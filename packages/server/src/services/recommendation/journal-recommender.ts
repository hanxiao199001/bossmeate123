/**
 * P3 AI 期刊推荐（5-10 backend Day 1）。
 *
 * 输入: { tenantId, topic, limit }
 * 输出: top N 期刊 + 1 句理由
 *
 * 实现:
 *   1. 拉 user 历史 articles (last 50, latest first) → 提取 metadata.journalId 列表
 *   2. 拉 confidence>=70 的 enriched journals (最多 100，按 confidence DESC)
 *   3. LLM prompt: history journals + topic → 推 5 个最相关 + 理由
 *   4. 失败 fallback: 按 confidence DESC + topic 名称 ilike 排序 top N
 *   5. cache 30 min（key=tenantId+topic+limit）
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, ilike, or, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, journals } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { getProviders } from "../ai/provider-factory.js";
import { cacheGet, cacheSet, cacheKey } from "./cache.js";

export interface JournalRecommendation {
  id: string;
  name: string;
  nameEn: string | null;
  issn: string | null;
  impactFactor: number | null;
  partition: string | null;
  discipline?: string | null;
  confidence: number | null;
  reason: string;
}

export interface RecommendJournalsInput {
  tenantId: string;
  topic?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_HISTORY = 50;
const CANDIDATE_POOL = 100;

export async function recommendJournals(input: RecommendJournalsInput): Promise<JournalRecommendation[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 10);
  const topic = (input.topic ?? "").trim();
  const key = cacheKey(["recommend-journals", input.tenantId, topic, limit]);
  const cached = cacheGet<JournalRecommendation[]>(key);
  if (cached) {
    logger.debug({ tenantId: input.tenantId, topic, limit }, "P3 journal-recommender cache hit");
    return cached;
  }

  // 1. user 历史 articles 提取 journalId
  const historyRows = await db
    .select({ metadata: contents.metadata })
    .from(contents)
    .where(and(eq(contents.tenantId, input.tenantId), eq(contents.type, "article")))
    .orderBy(desc(contents.createdAt))
    .limit(MAX_HISTORY);

  const historyJournalIds = new Set<string>();
  for (const row of historyRows) {
    const journalId = (row.metadata as Record<string, unknown> | null)?.journalId;
    if (typeof journalId === "string") historyJournalIds.add(journalId);
  }

  // 2. 候选 journals: confidence>=70 + 全局共享(NULL) 或 自 tenant
  // PR #184 (5-20): 只推 SCI/SSCI 收录期刊 (运营反馈: 非 SCI 期刊被当 SCI 写).
  //   判据: jcr_full.wosLevel 含 SCIE/SSCI  OR  impact_factor 非空 (有 IF 基本是 JCR 收录).
  //   带 fallback: SCI 候选 < limit 时放宽回全部, 避免推荐空转.
  const baseWhere = and(
    gte(journals.confidence, 70),
    or(isNull(journals.tenantId), eq(journals.tenantId, input.tenantId)),
  );
  const sciWhere = and(
    baseWhere,
    sql`(
      ${journals.jcrFull}->>'wosLevel' ILIKE '%SCIE%'
      OR ${journals.jcrFull}->>'wosLevel' ILIKE '%SSCI%'
      OR ${journals.impactFactor} IS NOT NULL
    )`,
  );
  const selectCols = {
    id: journals.id,
    name: journals.name,
    nameEn: journals.nameEn,
    issn: journals.issn,
    impactFactor: journals.impactFactor,
    partition: journals.partition,
    discipline: journals.discipline,
    confidence: journals.confidence,
  };
  let candidates = await db
    .select(selectCols)
    .from(journals)
    .where(sciWhere)
    .orderBy(desc(journals.confidence))
    .limit(CANDIDATE_POOL);

  // Fallback: SCI 候选不足 limit → 放宽回全部 (宁可推非 SCI, 也不空转)
  if (candidates.length < limit) {
    logger.info({ got: candidates.length, limit }, "PR #184 SCI 候选不足, fallback 放宽全部期刊");
    candidates = await db
      .select(selectCols)
      .from(journals)
      .where(baseWhere)
      .orderBy(desc(journals.confidence))
      .limit(CANDIDATE_POOL);
  }

  if (candidates.length === 0) {
    logger.warn({ tenantId: input.tenantId }, "P3 journal-recommender: 0 高可信候选期刊（全 confidence<70）");
    return [];
  }

  // 3. LLM 推荐
  let llmResult: Array<{ id: string; reason: string }> = [];
  try {
    llmResult = await callLlmForJournalRanking({
      topic,
      candidates,
      historyJournalIds: Array.from(historyJournalIds),
      limit,
    });
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId }, "P3 journal-recommender LLM 失败，fallback 到规则排序");
  }

  // 4. fallback: confidence DESC + topic ilike
  const useFallback = llmResult.length === 0;
  let final: JournalRecommendation[];
  if (useFallback) {
    final = candidates.slice(0, limit).map((c) => ({
      ...c,
      reason: topic
        ? `${c.name} 是 confidence ${c.confidence} 的高可信期刊，匹配主题"${topic}"`
        : `${c.name} 是 confidence ${c.confidence} 的高可信期刊`,
    }));
  } else {
    final = [];
    for (const r of llmResult) {
      const c = candidates.find((x) => x.id === r.id);
      if (c) final.push({ ...c, reason: r.reason });
    }
  }

  cacheSet(key, final);
  return final;
}

async function callLlmForJournalRanking(args: {
  topic: string;
  candidates: Array<{ id: string; name: string; impactFactor: number | null; partition: string | null; discipline: string | null }>;
  historyJournalIds: string[];
  limit: number;
}): Promise<Array<{ id: string; reason: string }>> {
  const provider = getProviders().cheap[0];
  if (!provider) throw new Error("无可用 LLM provider");

  const candidateLines = args.candidates
    .map((c) => `- id=${c.id} | ${c.name} | IF=${c.impactFactor ?? "-"} | ${c.partition ?? "-"} | ${c.discipline ?? "-"}`)
    .join("\n");
  const historyHint =
    args.historyJournalIds.length > 0
      ? `用户历史发过这些期刊 ID（按相似度优先推荐相近主题但不要重复推荐）: ${args.historyJournalIds.slice(0, 10).join(", ")}`
      : "用户暂无历史期刊";

  const sys = `你是学术期刊推荐专家。从给定候选列表选 ${args.limit} 本最相关期刊。
**只输出纯 JSON**（不要 markdown 包裹）：
[{"id":"<候选 id>","reason":"30 字内推荐理由"}, ...]
要求：
- 必须从候选列表选 id（不能编造 id）
- 共 ${args.limit} 条
- reason 具体说明为什么相关（如"与用户主题 X 高度匹配 + IF 较稳"）`;

  const user = `候选期刊（最多 100）:\n${candidateLines}\n\n用户主题: ${args.topic || "（未指定，按用户历史和高可信优先）"}\n${historyHint}`;

  const resp = await provider.chat({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    maxTokens: 600,
  });
  const text = resp.content.trim().replace(/^```json\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn({ raw: text.slice(0, 200) }, "P3 journal-recommender LLM JSON parse 失败");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // 仅返回 id 在候选集中的（防 LLM hallucinate id）
  const candidateIds = new Set(args.candidates.map((c) => c.id));
  return parsed
    .filter((p: unknown): p is { id: string; reason: string } =>
      typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string"
        && typeof (p as { reason?: unknown }).reason === "string"
        && candidateIds.has((p as { id: string }).id),
    )
    .slice(0, args.limit);
}
