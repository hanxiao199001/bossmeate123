/**
 * 每日成本拆分 —— 简报里的四个数 (9-04)。
 *
 * ## 为什么加
 *
 * 简报此前只报「今日花费 X 元」一个总数, 而这个数**答不了任何一个要决策的问题**:
 *   · 钱是花在新内容上, 还是在补昨天的积压?
 *   · 视频占多少?(单条 ¥8-20, 一条顶几十篇文章)
 *   · 撞顶了吗?(撞顶意味着当天后面的排产全被顺延)
 *
 * 9-01/9-02 各烧 ¥162/¥166, 简报里只是"今日花费 162 元"这一行 ——
 * 而真相是**积压重跑把新内容挤掉了**, 那个信息在总额里完全看不见。
 *
 * ## 四个数
 *
 * ```
 * 当日总额     cost_ledger 全部 kind
 * 重跑占       note like '%retry=1%'    ← 件 1(e) 的归因产物
 * 视频占       kind='dvh'
 * 是否撞顶     ops_incidents kind='llm_cost_cap'
 * ```
 *
 * 🔴 取数失败**不许**静默返回 0 —— "今天花了 0 元"和"查不出来"在简报里长得一样,
 * 而前者是好消息。失败以 error 形态返回, 由渲染层原样报出来。
 */

import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { logger } from "../../config/logger.js";

export interface CostBreakdown {
  totalCents: number;
  retryCents: number;
  videoCents: number;
  llmCents: number;
  cappedAt: string | null;
  /** 取数失败时的原因; 非 null 时上面的数无意义 */
  error: string | null;
}

/** 北京时间当天 00:00 的 UTC ISO */
export function bjDayStartIso(now: Date): string {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const start = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  return new Date(start - 8 * 3600_000).toISOString();
}

export async function collectCostBreakdown(now: Date = new Date()): Promise<CostBreakdown> {
  const since = bjDayStartIso(now);
  try {
    const res = await db.execute(sql`
      SELECT
        COALESCE(SUM(amount_cents), 0)::int                                            AS total,
        COALESCE(SUM(amount_cents) FILTER (WHERE note LIKE '%retry=1%'), 0)::int        AS retry,
        COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'dvh'), 0)::int                 AS video,
        COALESCE(SUM(amount_cents) FILTER (WHERE kind = 'llm'), 0)::int                 AS llm
      FROM cost_ledger WHERE created_at >= ${since}
    `);
    const r = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0] ?? {};

    const capRes = await db.execute(sql`
      SELECT to_char(created_at + interval '8 hours', 'HH24:MI') AS t
      FROM ops_incidents WHERE kind = 'llm_cost_cap' AND created_at >= ${since}
      ORDER BY created_at LIMIT 1
    `);
    const capRow = (capRes as unknown as { rows?: Array<{ t: string }> }).rows?.[0];

    return {
      totalCents: Number(r.total ?? 0),
      retryCents: Number(r.retry ?? 0),
      videoCents: Number(r.video ?? 0),
      llmCents: Number(r.llm ?? 0),
      cappedAt: capRow?.t ?? null,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "cost_breakdown.collect_failed");
    // 🔴 不返回 0 —— 见文件头
    return { totalCents: 0, retryCents: 0, videoCents: 0, llmCents: 0, cappedAt: null, error: msg.slice(0, 200) };
  }
}

/** 渲染成简报里的几行。判据与渲染分开, 便于单测 */
export function renderCostBreakdown(b: CostBreakdown): string[] {
  if (b.error) {
    return [`  ⚠️ 成本拆分**没查成**(≠ 今天没花钱): ${b.error}`];
  }
  const y = (c: number) => (c / 100).toFixed(2);
  const pct = (c: number) => (b.totalCents > 0 ? Math.round((c / b.totalCents) * 100) : 0);
  const lines = [
    `  今日总额 ${y(b.totalCents)} 元 = 文章/AI ${y(b.llmCents)} + 视频 ${y(b.videoCents)}`,
  ];
  // 重跑占比是件 1 的核心指标: 0 是正常, 非 0 说明有积压在补
  lines.push(
    b.retryCents > 0
      ? `  其中重跑积压 ${y(b.retryCents)} 元(${pct(b.retryCents)}%) —— 这部分钱花在补旧内容上, 会挤占当天新内容配额`
      : "  其中重跑积压 0 元 —— 今天的钱全花在新内容上",
  );
  lines.push(
    b.cappedAt
      ? `  🔴 ${b.cappedAt} 触达日成本上限 —— 之后的排产已顺延到次日, 不是丢弃`
      : "  未触达日成本上限",
  );
  return lines;
}
