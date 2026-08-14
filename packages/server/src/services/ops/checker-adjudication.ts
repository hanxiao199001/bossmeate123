/**
 * 检查器裁决（8-14 方法论移植 Phase 3 · 后端数据路径）。
 *
 * ## 它解决的问题
 *
 * 台账（Phase 1）能数出「这道闸报了 37 条」，但数不出「其中几条报对了」。
 * 没有这个数，`judge()` 的所有结论都卡在「台账未成熟」——
 * 措辞闸 37 报 0 中、排名闸 2 报 2 中，当初都是人肉数出来的。
 * 本文件就是把那个"人肉数"变成一个每周 5 分钟的动作。
 *
 * ## 🔴 只存裁决，不存命中
 *
 * 命中实例**现算**（`checkOutputHealth` 跑一遍近期内容），不落表。两个理由：
 *   ① 033 定的硬纪律是聚合不逐条落行 —— 给最大的表加每条一行的判定日志，
 *      收益远小于代价；
 *   ② **命中一旦落表就会与闸的当前判据漂移**。8-13 一天之内三道闸的判据被收窄过，
 *      裁决一条按旧判据命中的记录，得到的结论对今天的闸没有意义。
 *      现算保证「你判的就是它今天真会报的」。
 *
 * ## 抽样是随机的，且不给人挑
 *
 * 按内容 id 的哈希定序取前 N 条 —— 同一批候选每次结果一致（可复现），
 * 但与"新旧""好坏"都无关。让人自己挑要判哪条，判出来的比例就没有意义了。
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, checkerAdjudications } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { checkOutputHealth } from "../publisher/output-health.js";
import { recordAdjudication } from "./checker-ledger.js";
import { getChecker } from "./checker-registry.js";

/** 一条待裁决的命中 */
export interface PendingHit {
  checkerId: string;
  /** 这道闸防什么 —— 裁决的人得知道判据是什么才判得了 */
  guards: string;
  contentId: string;
  title: string;
  /** 闸给出的命中说明（含原文片段） */
  detail: string;
  createdAt: string;
}

export type Verdict = "true_positive" | "false_positive" | "miss";
export const VERDICTS: readonly Verdict[] = ["true_positive", "false_positive", "miss"];

/** 一次抽样给几条。10 条 ≈ 5 分钟，是「每周花 5 分钟」这句承诺的来源 */
export const SAMPLE_SIZE = 10;

/**
 * 抽一批待裁决的命中。
 *
 * @param days       往前看几天（默认 14 —— 太久远的内容裁决者已经没有上下文了）
 * @param annotatorId 排除此人已判过的（不排除别人判过的：两个人判同一条是有价值的）
 */
export async function sampleHitsForAdjudication(opts: {
  days?: number;
  limit?: number;
  checkerId?: string;
  annotatorId?: string | null;
}): Promise<PendingHit[]> {
  const days = opts.days ?? 14;
  const limit = opts.limit ?? SAMPLE_SIZE;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);

  const rows = await db
    .select({
      id: contents.id,
      title: contents.title,
      body: contents.body,
      createdAt: contents.createdAt,
    })
    .from(contents)
    .where(and(eq(contents.type, "article"), gte(contents.createdAt, since)))
    .orderBy(desc(contents.createdAt));

  // 已判过的 (checker, content) 组合 —— 同一人不重复判
  const judged = new Set<string>();
  if (opts.annotatorId) {
    const prev = await db
      .select({ c: checkerAdjudications.checkerId, k: checkerAdjudications.contentId })
      .from(checkerAdjudications)
      .where(eq(checkerAdjudications.annotatorId, opts.annotatorId));
    for (const p of prev) judged.add(`${p.c}::${p.k}`);
  }

  const hits: PendingHit[] = [];
  for (const r of rows) {
    const health = checkOutputHealth({ title: r.title ?? "", body: r.body ?? "" });
    for (const issue of health.issues ?? []) {
      const checkerId = `output_health.${issue.code}`;
      if (opts.checkerId && checkerId !== opts.checkerId) continue;
      if (judged.has(`${checkerId}::${r.id}`)) continue;
      hits.push({
        checkerId,
        guards: getChecker(checkerId)?.guards ?? "(未注册)",
        contentId: r.id,
        title: r.title ?? "",
        detail: issue.detail,
        createdAt: String(r.createdAt),
      });
    }
  }

  // 确定性乱序：按 contentId+checkerId 的哈希定序。
  //   不用 Math.random —— 同一批候选两次调用结果要一致，否则前端刷新一次就换一批，
  //   已经看过的又冒出来。也不用 createdAt 排序：那样永远只判最新的。
  const key = (h: PendingHit) => {
    let x = 0;
    const s = `${h.contentId}${h.checkerId}`;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return x;
  };
  return hits.sort((a, b) => key(a) - key(b)).slice(0, limit);
}

/**
 * 改判时台账要怎么加减。**抽成纯函数是为了能被测到** ——
 * 这条规则错了不会报错，只会让 confirmed_true/false 悄悄多出票来。
 *
 * 一个人把「拦对了」改成「拦错了」，若只 +1 不 -1，台账就记成两票，
 * 而且是一真一假，正好把判定拉向中间 —— 看数字的人完全察觉不到。
 */
export function adjudicationDeltas(
  prev: Verdict | null,
  next: Verdict,
): Array<{ verdict: Verdict; delta: number }> {
  if (prev === next) return [];
  const out: Array<{ verdict: Verdict; delta: number }> = [];
  if (prev) out.push({ verdict: prev, delta: -1 });
  out.push({ verdict: next, delta: 1 });
  return out;
}

/**
 * 落一条裁决。**同一人对同一条命中只算一次** —— 改判走覆盖，不叠加。
 *
 * 台账那边是 `+1` 的计数器，所以覆盖时要把旧票撤掉再投新票，
 * 否则一个人改一次主意，台账就多出一票。
 */
export async function submitAdjudication(input: {
  checkerId: string;
  contentId: string;
  verdict: Verdict;
  annotatorId?: string | null;
  note?: string | null;
}): Promise<{ recorded: boolean; changedFrom: Verdict | null }> {
  const { checkerId, contentId, verdict } = input;
  const annotatorId = input.annotatorId ?? null;

  const prev = annotatorId
    ? await db
        .select({ v: checkerAdjudications.verdict })
        .from(checkerAdjudications)
        .where(
          and(
            eq(checkerAdjudications.checkerId, checkerId),
            eq(checkerAdjudications.contentId, contentId),
            eq(checkerAdjudications.annotatorId, annotatorId),
          ),
        )
        .limit(1)
    : [];
  const changedFrom = (prev[0]?.v as Verdict | undefined) ?? null;
  if (changedFrom === verdict) return { recorded: false, changedFrom };

  await db
    .insert(checkerAdjudications)
    .values({ checkerId, contentId, verdict, annotatorId, note: input.note ?? null })
    .onConflictDoUpdate({
      target: [checkerAdjudications.checkerId, checkerAdjudications.contentId, checkerAdjudications.annotatorId],
      set: { verdict, note: input.note ?? null, createdAt: new Date() },
    });

  // 🔴 改判：先撤旧票再投新票（判据见 adjudicationDeltas）
  for (const d of adjudicationDeltas(changedFrom, verdict)) {
    await recordAdjudication(checkerId, d.verdict, d.delta);
  }

  logger.info({ checkerId, contentId, verdict, changedFrom }, "checker_adjudication.recorded");
  return { recorded: true, changedFrom };
}

/** 裁决进度：每个检查器攒了多少票（周报与判定的输入） */
export async function adjudicationProgress(): Promise<Array<{ checkerId: string; total: number }>> {
  const rows = await db
    .select({ checkerId: checkerAdjudications.checkerId, total: sql<number>`count(*)::int` })
    .from(checkerAdjudications)
    .groupBy(checkerAdjudications.checkerId);
  return rows;
}
