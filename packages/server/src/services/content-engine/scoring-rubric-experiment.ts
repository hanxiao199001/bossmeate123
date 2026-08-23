/**
 * 六维判据改动的**预注册验收判据**（红线 #18）。8-21。
 *
 * ═══ 🔴 件 1 / 件 2 的判据已作废（2026-08-23）——「观察窗口被后续版本覆盖」═══
 *
 * **不是「没测」，是「测的机会被我们自己弄没了」。** 三个月后有人翻到这里，
 * 要能看出区别 —— 所以作废原因写在这里，判据本体保留不删。
 *
 * ```
 * 件1 → v3   8-22 上线，当天被件2 覆盖
 * 件2 → v4   8-22 上线，当天被 v5(截断修复) 覆盖
 * 实测：6 天里 v3 / v4 各自落库 0 篇 —— 两者都没有过任何观察窗口
 * ```
 *
 * a892a64 立的规矩是「四件各自独立部署并各自 +1 版本」。规矩立了，
 * 但**没有任何机制强制「上一件观察满一个窗口再上下一件」** ——
 * 串行部署的纪律，没有对应的强制。按可靠性排序，「靠人记得按顺序」是等级 ④。
 *
 * 后果：`v5 = 件1 + 件2 + 截断修复`，**三者贡献永远分不开**。
 * 🔴 v5 的效果不得归因给其中任何一件（见 `quality-thresholds.ts` 的 v5 版本记录）。
 *
 * **不补测**（老韩 8-23 拍板）：件1 已知读不出（效应 1.0 落在 ±1.3 噪音里），
 * 件2 的 +3.11 已经在 v4 vs v2 的注册期机器校验里测过。
 * 离线重跑几百次调用去分离一个**我们已经不打算据此做决定**的效应，不值那个钱（红线 #21）。
 *
 * 配套已立：版本 +1 时**必须声明是否覆盖了上一版本的观察窗口**
 * （`quality-thresholds.ts` 规矩 1.5）。紧急修复可以覆盖，但要当天标注，
 * 而不是六天后有人查数据才发现分不开了。
 *
 * ═══ 为什么必须先注册 ═══
 *
 * 8-15 `reasoning_effort` 那次的教训原文：
 *   > 判据写坏了要认，不能事后改口径把它救成「通过」。预注册的全部价值就在这一句上。
 *   > 反过来同样成立：实验组「看着更好」的维度也不许事后捡回来当结论。
 *
 * 两条硬要求：
 *   1. 判据先拿基线跑一遍 —— 基线自己过不了的判据，测不出任何变化。
 *   2. 「持平」一律写成**单向**：只禁变差，不禁变好。
 *
 * ═══ 样本集（冻结） ═══
 *
 * ```
 * A2_new    9 篇   A2 新体裁「学科定位」，全部 sparse 国内刊
 * A2_old    9 篇   同 9 本刊的现体裁存量文章（同刊配对）
 * rich_prod 12 篇  rich 供给的生产存量
 * ```
 *
 * ⚠️ 已知局限，报结论时必须一并说：
 *   - n=30，单轮，评分本身有随机性 → 一律写「初步迹象」，不写「证明」
 *   - rich_prod 只涉及 3 本刊（计算机与教育 / 教育前沿 / 高等教育研究）——
 *     回头刊集中是生产现状，但这让 rich 组的结论**不能外推到全部 rich 刊**
 *   - A2_old 与 A2_new 同刊配对，A2 组的组内对比强度高于跨组对比
 *
 * ═══ 件 1：解除 structureDensity × dataAccuracy 的双重计分 ═══
 *
 * 病：`structureDensity` 判据里的「干货密」与 `dataAccuracy` 判据里的
 * 「每 200 字至少 1 个具体硬数据」是**同一件事**，合计权重 45%。
 * sparse 刊没数据 → 两维同时塌（实测 3.92 / 4.75）——
 * 这不是两个独立证据，是一个原因被记了两遍。
 *
 * 🔴 推论二（老韩）：这两维的相关性是**设计出来的**，不是内容规律。
 * A2 修好 dataAccuracy 后 structureDensity 跟着涨（4.44→5.89），
 * 之前会被误读成「新体裁结构也更好」，其实是同一个原因的回声。
 */

export type RubricGroup = "A2_new" | "A2_old" | "rich_prod";

export interface GroupDimStats {
  n: number;
  /** 各维均分 */
  dims: Record<string, number>;
  total: number;
  /** structureDensity 与 dataAccuracy 的皮尔逊相关系数 */
  corrStructData: number;
}

export interface RubricRunStats {
  version: string;
  groups: Record<RubricGroup, GroupDimStats>;
  /** 全样本 30 篇的总分分位数，用于配套② 的线校准 */
  totalPercentiles: { p50: number; p75: number; p85: number; p90: number };
}

export interface CriterionVerdict {
  id: string;
  statement: string;
  pass: boolean;
  observed: string;
  /** 判据在基线上自测的结果 —— 基线过不了的判据测不出变化（红线 #18 第 1 条） */
  baselineSanity?: string;
}

/** 皮尔逊相关系数。样本 <3 返回 NaN（相关系数在 n=2 时恒为 ±1，是噪声不是信号）。 */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return Number.NaN;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const d = Math.sqrt(sxx * syy);
  return d === 0 ? Number.NaN : sxy / d;
}

/**
 * 件 1 的预注册判据。**在跑改动之前写死，跑完原样喂进去。**
 *
 * 判据设计说明（每条都要能回答「基线自己过得了吗」）：
 *
 * | # | 判据 | 方向 | 为什么这么写 |
 * |---|---|---|---|
 * | 1 | sparse 组 structureDensity 上升 ≥0.5 | 差分 | 主效应。sparse 是被双重扣分的那一组 |
 * | 2 | rich 组 structureDensity 变化 ≥ -0.3 | **单向** | rich 本来就有数据、不吃这条扣分，所以应当基本不动。写成单向 = 只禁变差 |
 * | 3 | 各组 dataAccuracy ≥ -0.3 | **单向** | 这一维不该被本次改动碰到。只禁变差 |
 * | 4 | sparse 组 corr(struct,data) 下降 | 差分 | 🔴 核心：相关性若是设计出来的，解除重复后应当下降 |
 * | 5 | 全样本 p85 记录在案 | 记录 | 配套②：旧尺子 80 分对应什么分位，新尺子要挪到同分位还是明确放宽 |
 *
 * 判据 4 的**已知弱点**（先写下来，免得事后当发现）：n=18（A2 两组合并），
 * 相关系数在这个量级上很不稳。所以它**不作为否决项**，只作为方向性观察 ——
 * 8-15 那次「事件频率 0.17% × n=10」的错误不再重演：样本撑不起的判据，
 * 先算清期望再决定它算不算数。
 */
export function evaluateDedupCriteria(base: RubricRunStats, after: RubricRunStats): {
  verdicts: CriterionVerdict[];
  decision: "PASS" | "FAIL" | "NO_DATA";
} {
  const v: CriterionVerdict[] = [];
  const d = (g: RubricGroup, k: string) => (after.groups[g].dims[k] ?? NaN) - (base.groups[g].dims[k] ?? NaN);
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

  const sparseDelta = (k: string) => {
    // A2_new 与 A2_old 都是 sparse，合并看主效应
    const bn = base.groups.A2_new.n + base.groups.A2_old.n;
    const wb = (base.groups.A2_new.dims[k] * base.groups.A2_new.n + base.groups.A2_old.dims[k] * base.groups.A2_old.n) / bn;
    const wa = (after.groups.A2_new.dims[k] * after.groups.A2_new.n + after.groups.A2_old.dims[k] * after.groups.A2_old.n) / bn;
    return wa - wb;
  };

  const c1 = sparseDelta("structureDensity");
  v.push({ id: "1", statement: "sparse 组 structureDensity 上升 ≥0.5（主效应）", pass: c1 >= 0.5, observed: `Δ=${f(c1)}` });

  const c2 = d("rich_prod", "structureDensity");
  v.push({ id: "2", statement: "rich 组 structureDensity 不变差（单向，≥-0.3）", pass: c2 >= -0.3, observed: `Δ=${f(c2)}` });

  const c3 = Math.min(sparseDelta("dataAccuracy"), d("rich_prod", "dataAccuracy"));
  v.push({ id: "3", statement: "dataAccuracy 各组不变差（单向，≥-0.3）—— 本次改动不该碰它", pass: c3 >= -0.3, observed: `最差组 Δ=${f(c3)}` });

  const bc = base.groups.A2_new.corrStructData, ac = after.groups.A2_new.corrStructData;
  const c4ok = Number.isFinite(bc) && Number.isFinite(ac) ? ac < bc : false;
  v.push({
    id: "4",
    statement: "sparse 组 corr(structureDensity, dataAccuracy) 下降（方向性观察，不否决）",
    pass: true, // 🔴 刻意不否决：n=18 撑不起相关系数，见函数注释
    observed: `${f(bc)} → ${f(ac)}${c4ok ? "（下降 ✓）" : "（未下降或不可算）"}`,
    baselineSanity: "n=18，相关系数在此量级极不稳；仅作方向观察，不作为通过条件",
  });

  v.push({
    id: "5",
    statement: "记录全样本总分分位（配套②线校准输入）",
    pass: true,
    observed: `基线 p50=${base.totalPercentiles.p50} p75=${base.totalPercentiles.p75} p85=${base.totalPercentiles.p85} p90=${base.totalPercentiles.p90}` +
      ` → 改后 p50=${after.totalPercentiles.p50} p75=${after.totalPercentiles.p75} p85=${after.totalPercentiles.p85} p90=${after.totalPercentiles.p90}`,
  });

  const decisive = v.filter((x) => ["1", "2", "3"].includes(x.id));
  if (decisive.some((x) => !Number.isFinite(Number(x.observed.replace(/[^\d.-]/g, ""))))) {
    return { verdicts: v, decision: "NO_DATA" };
  }
  return { verdicts: v, decision: decisive.every((x) => x.pass) ? "PASS" : "FAIL" };
}

// ═══════════════════════════════════════════════════════════════
// 件 2：practicality 体裁中立化（v3 → v4）。8-22 预注册。
// ═══════════════════════════════════════════════════════════════

import { registerCriteria, MEASURED_NOISE, type ScoringCriterion } from "./criterion-registry.js";

/**
 * 🔴 与件 1 的关键差别：**这批判据在注册期就被机器校验过**。
 *
 * 件 1 那次我手写了 0.5 / 0.3 这种阈值，而单维噪音是 1.3 ——
 * 判据在写下的那一刻就已经答不出东西，跑完才发现。
 * 现在 `registerCriteria` 会在实验开跑前抛错。
 *
 * 阈值取 **2× 噪音 = 2.6**（老韩定的门槛）。
 * 件 2 预期效应 3-4 分（practicality 从结构性 0 分变成有分），够穿透。
 */
export const PIECE2_CRITERIA: readonly ScoringCriterion[] = registerCriteria(
  [
    {
      id: "p2-1",
      statement: "A2_new 组 practicality 上升 ≥2.6（主效应：不再因为没写投稿建议而拿不到分）",
      threshold: 2.6,
      unit: "sixdim_dim_0_10",
      noiseLevel: MEASURED_NOISE.sixdim_dim_0_10.level,
      noiseUnit: "sixdim_dim_0_10",
      noiseSource: MEASURED_NOISE.sixdim_dim_0_10.source,
      noiseMeasuredAt: MEASURED_NOISE.sixdim_dim_0_10.at,
      direction: "increase",
    },
    {
      id: "p2-2",
      // 🔴 单向（红线 #18）：rich 组本来就写投稿建议，中立化不该让它变差；变好也不算问题
      statement: "rich_prod 组 practicality 不变差（单向，≥-1.3）—— 放宽定义不该惩罚原本合格的",
      threshold: -1.3,
      unit: "sixdim_dim_0_10",
      noiseLevel: MEASURED_NOISE.sixdim_dim_0_10.level,
      noiseUnit: "sixdim_dim_0_10",
      noiseSource: MEASURED_NOISE.sixdim_dim_0_10.source,
      noiseMeasuredAt: MEASURED_NOISE.sixdim_dim_0_10.at,
      direction: "no_worse",
      // 阈值恰好等于噪音，作为单向下界是可接受的：它问的是"有没有塌"，不是"有没有动"
      observationOnly: true,
    },
    {
      id: "p2-3",
      statement: "A2_new 组 practicality 逐篇同向 ≥7/9（方向一致性优先于均值差）",
      threshold: 7,
      unit: "article_count",
      noiseLevel: 0,
      noiseUnit: "article_count",
      noiseSource: "计数无评分噪音（同一次运行内的确定性比较）",
      noiseMeasuredAt: MEASURED_NOISE.sixdim_dim_0_10.at,
      direction: "increase",
    },
    {
      id: "p2-4",
      // 配套②：放宽定义 → 分数上移 → 达标率可能虚涨。必须先看分位再决定要不要挪线
      statement: "记录 80 分在 v4 下的分位（若较 v3 下移 >5 个百分点，视为线变松，需重新校准）",
      threshold: 5,
      unit: "percent_0_100",
      noiseLevel: 0,
      noiseUnit: "percent_0_100",
      noiseSource: "分位为样本内确定性统计，无评分噪音；但样本本身 n=30 有抽样误差",
      noiseMeasuredAt: MEASURED_NOISE.sixdim_dim_0_10.at,
      direction: "no_worse",
      observationOnly: true,
    },
  ],
  MEASURED_NOISE.sixdim_dim_0_10.at,
);
