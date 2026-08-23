/**
 * 运行时参数（8-18 Phase 4 第一批）。**目标只有一句：老韩不碰代码改掉一个阈值。**
 *
 * ## 定义在代码，值在库
 *
 * ```
 * 有哪些参数 / 什么类型 / 边界多少 / 给运营怎么解释   →  本文件的 REGISTRY（代码）
 * 现在是多少                                        →  runtime_params 表（库）
 * ```
 *
 * 读取顺序 **DB → env → 代码默认**，三层都在。没被配过的参数走后两层，
 * 行为与外化之前**完全一致** —— 这是「上线当天行为不变」的实现方式，
 * 不需要迁移时给每个参数写一行初始值。
 *
 * ## 🔴 边界不是装饰，是这套东西能交给运营的前提
 *
 * 每个参数都带 `min/max`（或枚举）。没有边界的参数页等于把生产环境的
 * 方向盘拆下来递过去 —— 质量线填 0 会让所有内容免检、冷却填 0 会让同一本刊
 * 天天上。校验在**写入侧**做（`setParam`），不是靠前端拦：前端能绕过，DB 不能。
 *
 * ## 为什么每个参数都要写 `impact`
 *
 * 运营改一个数之前得知道它会动到什么。「质量线」听起来像个分数，
 * 实际它决定内容进不进草稿箱 —— 这句话必须写在参数页上，不能只活在开发脑子里。
 *
 * ## 学科配额不在第一批
 *
 * 它要等新闸（配额按槽位学科计）设计完 —— 外化一个**口径还会变**的参数，
 * 等于把一个即将作废的旋钮交给运营。
 */
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { runtimeParams, runtimeParamAudits } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";

export type ParamType = "number" | "boolean";

export interface ParamDef {
  key: string;
  type: ParamType;
  /** 给运营看的名字 */
  label: string;
  /** 🔴 改了它会影响什么 —— 直接显示在参数页上 */
  impact: string;
  /** 代码默认（env 也没配时用它）。必须等于外化之前的硬编码值，否则就不是"行为不变" */
  fallback: number | boolean;
  /** env 兜底变量名（有就读，没有跳过） */
  envKey?: keyof typeof env;
  min?: number;
  max?: number;
  /** 谁能改 */
  audience: "运营" | "开发";
  /**
   * 🔴 8-20 加（老韩）：**这个值凭什么是这个数**。参数页原样显示。
   *
   * 起因：8-20 确认公众号阅读回流永远不会有数据（7 个号未微信认证，接口 48001），
   * 于是下面三个问题**从此没有数据答案**，只能由人拍：
   *
   *   发 14 篇不达标的 vs 2 篇达标的，哪个好？
   *   保底该定几篇？
   *   质量线该不该接到 80？
   *
   * 老韩的处置：**诚实标注比假装有依据更重要。**
   *
   *   > 这不是坏事，但要写下来 —— 否则三个月后有人问"为什么这么定"，
   *   > 答案又只剩下"当时那次运行的控制流"。
   *
   * 所以人工拍的值一律写「人工设定，无数据依据」并说明当时的考虑；
   * 有实测支撑的写清是哪组数据。**留空 = 还没人回答过这个问题**，同样是有用的信息。
   */
  evidence?: string;
}

/**
 * 第一批四个。挑选标准：**改了立刻见效、边界清楚、不依赖尚未定型的口径。**
 */
export const REGISTRY: readonly ParamDef[] = [
  {
    key: "quality.minScore",
    type: "number",
    label: "质量线（六维总分及格分）",
    impact: "低于这个分的内容不进草稿箱，转待审。调高 = 出稿更少但更稳；调低 = 出稿多但需要人工多看。",
    fallback: 70,
    envKey: "QUALITY_MIN_SCORE",
    min: 0,
    max: 100,
    audience: "运营",
  },
  {
    key: "journal.cooldownDays",
    type: "number",
    label: "同一本期刊的冷却天数",
    impact:
      "这么多天内不重复用同一本刊。调高 = 内容更不重样，但学科池小的时候会选不出刊（education 现在可选只剩个位数）；调低 = 回头刊变多。",
    fallback: 15,
    min: 1,
    max: 90,
    audience: "运营",
  },
  {
    key: "keyword.cooldownDays",
    type: "number",
    label: "同一个选题词的冷却天数",
    impact: "这么多天内不重复用同一个词。8-16 那次选题坍缩（一晚 24 篇同一个 topic）就是这个约束不够强。",
    fallback: 30,
    min: 1,
    max: 180,
    audience: "运营",
  },
  {
    key: "watchdog.timeoutMinutes",
    type: "number",
    label: "生成超时判死线（分钟）",
    impact:
      "一篇内容处于「生成中」超过这么久，watchdog 就判它失败。" +
      "🔴 调得太紧会杀掉「慢但还活着」的生成 —— 8-17 实测：成功组耗时最大 9.7 分钟，" +
      "而当时的线是 10 分钟，只剩 3% 余量，当晚 3 篇被误判（内容其实已生成 11000+ 字，钱也花了，然后被扔掉）。" +
      "现值 40 —— 不只是 3× 实测 max，还要容得下心跳的最坏间隔（六维质检单次最坏 10 分钟，见 watchdog 文件头）。调低前先看那组分布。",
    fallback: 40,
    min: 5,
    max: 240,
    audience: "运营",
  },
  {
    key: "roundup.enabled",
    type: "boolean",
    label: "生成「多刊盘点」体裁（roundup）",
    impact:
      "🔴 2026-08-23 老韩拍板**停用**（内容质量一般）。这是开关不是删除 —— 代码原样留着，要恢复改这一个值。\n" +
      "停用的连带影响（停之前实测，不是推断）：\n" +
      "· 分发少 2 篇/天。近 6 天进箱 11.7/14，扣掉 roundup 是 9.7/14，缺口从 -2.3 扩到 -4.3。\n" +
      "  ⚠️ 8-16 那天全天只进箱 2 篇、两篇都是 roundup —— 没有它当天就是零分发。\n" +
      "· 期刊池省 6 本/天（roundup 一篇吃 3 本，普通文章一篇 1 本；2 篇 × 3 = 6）。\n" +
      "· 未发存量只有 2 篇 —— 它生成即分发，池子里不积压，所以停用几乎只影响未来。\n" +
      "· 覆盖号数一直是 6/7（Paper 断供 26 天），少 2 篇后断供号预计 2-3 个。\n" +
      "槽位补不补是**另一个决定**：补 2 个普通槽位 → 缺口 -3.6、日耗 20 本；" +
      "要把进箱补平得补 6 个（普通线进箱转化 37%，roundup 是 100%）→ 日耗 24 本，一本没省。\n" +
      "\n" +
      "🔴 **若要恢复（改回 true），第一件事是补做一项验收**：\n" +
      "roundup 的 intent 决策留痕（8-23 刚接上，`daily_cron_roundup` 此前 intent 恒为 0）\n" +
      "**因为停用而一次都没跑过**。判据已写死：恢复后第一晚，`decision_traces` 里\n" +
      "`requested_by='daily_cron_roundup'` 的 intent 行数应等于当晚 roundup 篇数，\n" +
      "且与同批 consumption 行共用同一个 `correlation_id`。\n" +
      "\n" +
      "为什么写在这里而不是待办：**这是恢复的人一定会看到的位置**，待办是「靠人记得」。\n" +
      "停用一个功能会同时停掉刚给它建的观测 —— 这不是问题，但不能让它悄悄消失。",
    fallback: true,
    audience: "运营",
  },
  {
    key: "quota.useV2",
    type: "boolean",
    label: "用新版学科配额算法（v2：保底 + 池子余量分配）",
    impact:
      "🔴 重大行为变更。开 = 每晚 18 篇分散到 12 个学科（education 4 篇保底）；" +
      "关 = 旧算法，每晚 24 篇**全是 education**（因为领域不限的号不贡献学科，见 auto-quota-v2 文件头）。" +
      "**这是一键回退开关** —— 出问题改这里，不要回滚代码。",
    fallback: false,
    audience: "开发",
  },
  {
    key: "gate.outputHealthEnabled",
    type: "boolean",
    label: "出稿健康闸",
    impact:
      "关掉后，占位文/空正文/截断/复读这类废稿会照常进草稿箱。**只在排查时短暂关闭**，关掉期间产出的内容需要人工全看一遍。",
    fallback: true,
    audience: "开发",
  },
  {
    key: "distribute.minSixDimTotal",
    type: "number",
    label: "进草稿箱的六维总分下限",
    min: 0,
    max: 100,
    impact:
      "低于这个分数的文章不进草稿箱，转待审留人工。" +
      "**这不是发布达标线**（那条是 80 分 + 每维 ≥6，写在 quality-thresholds.ts，改不了）—— " +
      "这条只拦最差的那一档。8-20 实测：设 60 会拦掉近 14 天进分发 103 篇里的 27 篇（其中 18 篇总分 <50）。" +
      "设 0 = 关闭本闸（回到 8-20 之前）。往上调会同时减少草稿箱产量，" +
      "调到 80 等于把发布达标线搬到分发口，当前产能下草稿箱会掉到约 1/5。",
    fallback: 60,
    audience: "开发",
    evidence:
      "人工设定，无数据依据。8-20 老韩拍 60，理由是「先只拦最烂的、不搬发布达标线」——" +
      "实测该值会拦掉近 14 天进分发 103 篇里的 27 篇（其中 18 篇总分 <50）。" +
      "🔴 拦多少是实测的，60 这个数本身不是：没有阅读数据能证明 60 分的内容表现差于 70 分的。",
  },
  {
    key: "draft.targetPerAccount",
    type: "number",
    label: "每号每天保底篇数",
    min: 0,
    max: 20,
    envKey: "DRAFT_TARGET_PER_ACCOUNT",
    impact:
      "每个公众号每天至少要推进草稿箱的篇数。7 个号 × 本值 = 每天的分发目标量。" +
      "调高会更多地动用低分内容与队尾内容（没评上分的）来凑数；调低会让草稿箱变空。" +
      "设 0 = 不保底，有多少合格的推多少。",
    fallback: 2,
    audience: "运营",
    evidence:
      "🔴 人工设定，无数据依据。这个 2 是按「公众号得天天有东西」的直觉定的，" +
      "**从来没有和产能对齐过**：8-20 实测达标产能约 1.6 篇/天，而 7 号 × 2 篇 = 14 篇/天，差 8.75 倍。" +
      "缺口不是靠拒发补的，是靠放低标准补的 —— 实测进分发的 103 篇里 86 篇（83.5%）不达标。" +
      "「发 14 篇不达标的 vs 发 2 篇达标的哪个对生意更好」**没有数据能回答**" +
      "（公众号阅读回流不可用，见 metrics/external-feedback-status.ts）。谁改这个数谁承担这个判断。",
  },
  {
    key: "publish.sixDimTotalLine",
    type: "number",
    label: "发布达标线（六维总分）",
    min: 0,
    max: 100,
    impact:
      "🔴 这是「这篇算不算合格」的定义本身，改它会改变所有下游统计的含义" +
      "（周报的达标率、质量快照的 passed/below_bar 分档、历史对比）。" +
      "注意它**不是**分发闸 —— 分发闸是 distribute.minSixDimTotal。" +
      "另有一道**独立地板**「任一维度 <6 即不通过」写死在代码里，本参数不影响它，" +
      "所以调低本值不会让某一维极差的内容变成达标。",
    fallback: 80,
    audience: "开发",
    evidence:
      "🔴 人工设定，无数据依据。80 分来自最初的评分标准文档，" +
      "没有任何读者反馈证明 80 分的内容表现优于 75 分的。" +
      "8-20 实测该线的实际效果：近 14 天 335 篇里 49 篇达标（15%）——" +
      "**筛掉 85% 本身可能是对的**（严格的闸就该拦下大部分），但这是设计意图，不是验证结论。",
  },
] as const;

const byKey = new Map(REGISTRY.map((d) => [d.key, d]));
export function getParamDef(key: string): ParamDef | null {
  return byKey.get(key) ?? null;
}

/** 进程内缓存。参数是低频改动、高频读取，每次读库不划算 */
const cache = new Map<string, { v: number | boolean; at: number }>();
const CACHE_MS = 60_000;

/**
 * 读一个参数。**DB → env → 代码默认**，任何一层缺失都自动落到下一层。
 *
 * 读失败（库挂了/值非法）一律退回默认并记日志 ——
 * 参数系统本身不该成为新的故障点：它挂了应该表现为「回到外化之前的行为」，
 * 而不是「整条链路读不到配置」。
 */
export async function getParam<T extends number | boolean>(key: string): Promise<T> {
  const def = byKey.get(key);
  if (!def) throw new Error(`未注册的运行时参数: ${key}`);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v as T;

  let value: number | boolean = def.fallback;
  try {
    const [row] = await db.select().from(runtimeParams).where(eq(runtimeParams.key, key)).limit(1);
    if (row && validate(def, row.value as unknown).ok) {
      value = row.value as number | boolean;
    } else if (def.envKey && env[def.envKey] !== undefined) {
      value = env[def.envKey] as number | boolean;
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, key }, "runtime_param.read_failed_use_default");
  }
  cache.set(key, { v: value, at: Date.now() });
  return value as T;
}

/** 边界校验。**写入侧**做 —— 前端能绕过，DB 不能 */
export function validate(def: ParamDef, raw: unknown): { ok: true; value: number | boolean } | { ok: false; reason: string } {
  if (def.type === "boolean") {
    if (typeof raw !== "boolean") return { ok: false, reason: "必须是 true / false" };
    return { ok: true, value: raw };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, reason: "必须是数字" };
  if (def.min !== undefined && n < def.min) return { ok: false, reason: `不能小于 ${def.min}` };
  if (def.max !== undefined && n > def.max) return { ok: false, reason: `不能大于 ${def.max}` };
  return { ok: true, value: n };
}

/** 改一个参数。**必落审计行** —— 参数能被运营改，就必须能回答「谁把它改成这样的」 */
export async function setParam(
  key: string,
  raw: unknown,
  ctx: { changedBy?: string | null; note?: string | null } = {},
): Promise<{ ok: boolean; reason?: string; oldValue?: unknown }> {
  const def = byKey.get(key);
  if (!def) return { ok: false, reason: `未注册的参数: ${key}` };
  const v = validate(def, raw);
  if (!v.ok) return { ok: false, reason: v.reason };

  const [prev] = await db.select().from(runtimeParams).where(eq(runtimeParams.key, key)).limit(1);
  const oldValue = prev?.value ?? null;

  await db
    .insert(runtimeParams)
    .values({ key, value: v.value as never, updatedBy: ctx.changedBy ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: runtimeParams.key,
      set: { value: v.value as never, updatedBy: ctx.changedBy ?? null, updatedAt: new Date() },
    });

  await db.insert(runtimeParamAudits).values({
    key,
    oldValue: oldValue as never,
    newValue: v.value as never,
    changedBy: ctx.changedBy ?? null,
    note: ctx.note ?? null,
  });

  cache.delete(key);
  logger.info({ key, oldValue, newValue: v.value, changedBy: ctx.changedBy }, "runtime_param.changed");
  return { ok: true, oldValue };
}

/** 参数页要的数据：定义 + 当前值 + 来源（让运营看得出这个数是配过的还是默认的） */
export async function listParams(): Promise<
  Array<ParamDef & { current: number | boolean; source: "配置" | "环境变量" | "默认" }>
> {
  const rows = await db.select().from(runtimeParams);
  const configured = new Map(rows.map((r) => [r.key, r.value]));
  return REGISTRY.map((def) => {
    const dbv = configured.get(def.key);
    if (dbv !== undefined && validate(def, dbv).ok) {
      return { ...def, current: dbv as number | boolean, source: "配置" as const };
    }
    if (def.envKey && env[def.envKey] !== undefined) {
      return { ...def, current: env[def.envKey] as number | boolean, source: "环境变量" as const };
    }
    return { ...def, current: def.fallback, source: "默认" as const };
  });
}
