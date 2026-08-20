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
      "现值 40 —— 不只是 3× 实测 max，还要容得下心跳的最坏间隔（六维质检单次最坏 12 分钟，见 watchdog 文件头）。调低前先看那组分布。",
    fallback: 40,
    min: 5,
    max: 240,
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
