/**
 * 账号自动配额 v2（8-19）—— **保底 + 余量分配**。先影子后生效。
 *
 * ## 为什么重写
 *
 * 旧 `computeAutoQuota()` 的权重有一处结构性错误：
 *
 * ```ts
 * count       = scale(domCount)     // 分母 = 全部活跃号
 * disciplines = weighted(domW)      // 分子 = 只有配了 disciplines 的号
 * ```
 *
 * `bump()` 对 `disciplines = []` 的号什么都不加，于是**领域不限的号贡献了篇数、
 * 却没贡献学科多样性**。8-19 实测：7 个活跃号里 5 个是空数组、2 个是 education，
 * `weighted()` 返回 `["education"]` —— 于是 24 个槽位**全是 education**。
 *
 * 连带后果（决策留痕两晚实测）：
 * ```
 * education 槽位 48/60 = 80%，而真正的 education 刊只出了 11 本
 * 另外 37 本靠 generic 通配兜底（62%）
 * education 池 15 天被榨干，冷却外可选 0 本
 * ```
 *
 * 注释里写着「map 为空 → 回退 ALL_DISC_CODES 均匀轮转」，但 map **不为空**
 * （有 education），那条回退永远不触发。
 *
 * > 这是红线 #20 的语义版：`[]` 现在的实际含义是**「我不参与学科决策」**，
 * > 而运营配它时想表达的是**「我什么都接」**。
 * > 「没数据」与「没有偏好」又一次被混用。
 *
 * ## v2 的分配规则
 *
 * ```
 * ① 保底：有定位的号 → 每学科保底 = 该学科号数 × 每号最低篇数
 *    （绝对值，不按比例 —— 2 个 education 号 × 2 = 4 篇/晚，不受总量影响）
 * ② 余下：领域不限的号 → 在【默认学科集】内，按 pool-inventory 余量从多到少分配
 * ③ 默认学科集：第一版取 inventory 里 sustainable=true 的学科
 *    —— **默认值从数据来，不手写列表**；配置项留着可改
 * ```
 *
 * 为什么保底不参与余量排序：否则 education 池空了它就永远选不到，
 * 那 2 个 education 号会从「独占」直接翻转成「断供」—— 两个极端都不对。
 */
import { logger } from "../../config/logger.js";

/** 一个账号在分配中的画像 */
export interface AccountProfile {
  /** domestic | international | both */
  scope: string;
  /** 空数组 = 领域不限 */
  disciplines: string[];
}

/** 某学科在某 scope 下的可选余量（来自 pool-inventory，供给侧口径） */
export interface DisciplineSupply {
  disciplineCode: string;
  scope: string;
  freshVerified: number;
  sustainable: boolean;
}

export interface QuotaPlan {
  /** scope → 学科 → 篇数 */
  byScope: Record<string, Record<string, number>>;
  /** 保底不足的告警素材：某学科保底要 N 篇但池子只有 M 本 */
  shortfalls: Array<{ scope: string; discipline: string;need: number; available: number }>;
  /** 本次用到的默认学科集（领域不限的号投向这里） */
  defaultSet: string[];
}

/** 每号最低篇数。与 `env.DRAFT_TARGET_PER_ACCOUNT` 同义，调用方传入以便测试 */
export const DEFAULT_PER_ACCOUNT_FLOOR = 2;

/**
 * 算配额。**纯函数**：账号画像 + 池子余量 → 分配方案。无 DB、无 IO，可测。
 *
 * @param perAccountFloor 每号最低篇数（保底用），生产传 `env.DRAFT_TARGET_PER_ACCOUNT`
 * @param defaultSetOverride 运营在参数页配的默认学科集；不传则用 sustainable=true 的
 */
export function planAutoQuota(
  accounts: AccountProfile[],
  supply: DisciplineSupply[],
  perAccountFloor: number = DEFAULT_PER_ACCOUNT_FLOOR,
  defaultSetOverride?: string[],
): QuotaPlan {
  const scopes = ["domestic", "international"] as const;
  const byScope: Record<string, Record<string, number>> = {};
  const shortfalls: QuotaPlan["shortfalls"] = [];

  /** 供给查表：scope+学科 → 可选量 */
  const supplyOf = (scope: string, disc: string): DisciplineSupply | undefined =>
    supply.find((s) => s.scope === scope && s.disciplineCode === disc);

  /**
   * 默认学科集：第一版取 `sustainable=true` 的学科 —— **默认值从数据来，不手写列表**。
   * 手写列表会在池子变化时悄悄过期，而 sustainable 是 inventory 每次现算的。
   */
  const defaultSet =
    defaultSetOverride && defaultSetOverride.length > 0
      ? defaultSetOverride
      : [...new Set(supply.filter((s) => s.sustainable).map((s) => s.disciplineCode))];

  for (const scope of scopes) {
    const inScope = accounts.filter((a) => a.scope === scope || a.scope === "both");
    if (inScope.length === 0) continue;
    const alloc: Record<string, number> = {};

    // ① 保底：按**号数 × 每号最低篇数**，绝对值不按比例
    const floorCounts = new Map<string, number>();
    for (const a of inScope) for (const d of a.disciplines) floorCounts.set(d, (floorCounts.get(d) ?? 0) + 1);
    let floorTotal = 0;
    for (const [d, n] of floorCounts) {
      const need = n * perAccountFloor;
      alloc[d] = (alloc[d] ?? 0) + need;
      floorTotal += need;
      const s = supplyOf(scope, d);
      const avail = s?.freshVerified ?? 0;
      // ② 保底 > 池子可选量 → 出声。这条会每天喊，直到扩池或改定位解决它
      if (need > avail) shortfalls.push({ scope, discipline: d, need, available: avail });
    }

    // ② 余下：领域不限的号，在默认集内按余量从多到少分配
    const openCount = inScope.filter((a) => a.disciplines.length === 0).length;
    const remaining = openCount * perAccountFloor;
    if (remaining > 0 && defaultSet.length > 0) {
      const ranked = [...defaultSet]
        .map((d) => ({ d, avail: supplyOf(scope, d)?.freshVerified ?? 0 }))
        .sort((a, b) => b.avail - a.avail);
      // 轮流投给余量最多的（而非一次性堆给第一名）—— 避免把新的枯竭制造出来
      for (let i = 0; i < remaining; i++) {
        const pick = ranked[i % ranked.length]!;
        alloc[pick.d] = (alloc[pick.d] ?? 0) + 1;
      }
    }

    byScope[scope] = alloc;
    void floorTotal;
  }

  return { byScope, shortfalls, defaultSet };
}

/** 把方案渲染成人能读的一行行 —— 影子期对比用 */
export function describePlan(plan: QuotaPlan): string {
  const L: string[] = [];
  for (const [scope, alloc] of Object.entries(plan.byScope)) {
    const total = Object.values(alloc).reduce((a, b) => a + b, 0);
    const items = Object.entries(alloc)
      .sort((a, b) => b[1] - a[1])
      .map(([d, n]) => `${d} ${n}`)
      .join(" · ");
    L.push(`  ${scope} 合计 ${total}：${items}`);
  }
  if (plan.shortfalls.length) {
    for (const s of plan.shortfalls) {
      L.push(`  🔴 ${s.scope}/${s.discipline} 保底需 ${s.need} 篇，池子可选 ${s.available} 本`);
    }
  }
  L.push(`  默认学科集（领域不限的号投向这里）：${plan.defaultSet.join("、") || "(空)"}`);
  return L.join("\n");
}

/** 影子对比：新旧方案并排，只记录不改行为 */
export function logShadowComparison(
  oldQuota: Record<string, { count: number; disciplines: string[] }> | null,
  plan: QuotaPlan,
): void {
  const oldDesc = oldQuota
    ? Object.entries(oldQuota)
        .map(([k, v]) => `${k} count=${v.count} disciplines=[${v.disciplines.join(",")}]`)
        .join(" ｜ ")
    : "(null)";
  logger.info(
    { oldQuota: oldDesc, newPlan: plan.byScope, shortfalls: plan.shortfalls, defaultSet: plan.defaultSet },
    "auto_quota_v2.shadow —— 新算法会这么分（本次不生效）",
  );
}
