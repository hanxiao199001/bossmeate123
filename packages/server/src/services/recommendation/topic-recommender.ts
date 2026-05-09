/**
 * P3 AI 主题推荐（5-10 backend Day 1）。
 *
 * 输入: { tenantId, journalId, limit }
 * 输出: top N 主题 + 1 句理由
 *
 * 实现:
 *   1. 拉指定 journal（含 discipline / scope_description）
 *   2. 拉 user 历史 articles 的 title 列表（同 tenant，最近 50）
 *   3. LLM prompt: journal 学科 + 用户历史 → 推 5 个最相关 topic + 理由
 *   4. 失败 fallback: 用 journal.discipline + scope 关键词组合 N 个简单主题
 *   5. cache 30 min（key=tenantId+journalId+limit）
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, journals } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { getProviders } from "../ai/provider-factory.js";
import { cacheGet, cacheSet, cacheKey } from "./cache.js";

export interface TopicRecommendation {
  topic: string;
  reason: string;
}

export interface RecommendTopicsInput {
  tenantId: string;
  journalId?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_HISTORY = 50;

export async function recommendTopics(input: RecommendTopicsInput): Promise<TopicRecommendation[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 10);
  const key = cacheKey(["recommend-topics", input.tenantId, input.journalId, limit]);
  const cached = cacheGet<TopicRecommendation[]>(key);
  if (cached) {
    logger.debug({ tenantId: input.tenantId, journalId: input.journalId, limit }, "P3 topic-recommender cache hit");
    return cached;
  }

  // 1. journal 信息（journalId 可缺）
  let journal: { name: string; discipline: string | null; scopeDescription: string | null } | null = null;
  if (input.journalId) {
    const [row] = await db
      .select({
        name: journals.name,
        discipline: journals.discipline,
        scopeDescription: journals.scopeDescription,
      })
      .from(journals)
      .where(eq(journals.id, input.journalId))
      .limit(1);
    journal = row ?? null;
  }

  // 2. user 历史 article titles
  const historyRows = await db
    .select({ title: contents.title })
    .from(contents)
    .where(and(eq(contents.tenantId, input.tenantId), eq(contents.type, "article")))
    .orderBy(desc(contents.createdAt))
    .limit(MAX_HISTORY);
  const historyTitles = historyRows.map((r) => r.title).filter((t): t is string => !!t);

  // 3. LLM 推荐
  let llmResult: TopicRecommendation[] = [];
  try {
    llmResult = await callLlmForTopicRanking({ journal, historyTitles, limit });
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId }, "P3 topic-recommender LLM 失败，fallback 到规则");
  }

  // 4. fallback：基于 journal.discipline 简单 topic
  const final =
    llmResult.length > 0
      ? llmResult
      : journal
        ? [
            { topic: `${journal.discipline ?? journal.name} 最新进展综述`, reason: `${journal.name} 学科方向` },
            { topic: `${journal.discipline ?? journal.name} 临床研究案例`, reason: `${journal.name} 收稿范围` },
            { topic: `${journal.discipline ?? journal.name} 跨学科应用`, reason: `${journal.name} 跨界主题` },
          ].slice(0, limit)
        : [];

  cacheSet(key, final);
  return final;
}

async function callLlmForTopicRanking(args: {
  journal: { name: string; discipline: string | null; scopeDescription: string | null } | null;
  historyTitles: string[];
  limit: number;
}): Promise<TopicRecommendation[]> {
  const provider = getProviders().cheap[0];
  if (!provider) throw new Error("无可用 LLM provider");

  const journalHint = args.journal
    ? `目标期刊：${args.journal.name}（学科：${args.journal.discipline ?? "未指定"}；收稿范围：${args.journal.scopeDescription?.slice(0, 200) ?? "未指定"}）`
    : "用户未指定期刊";
  const historyHint =
    args.historyTitles.length > 0
      ? `用户历史 ${args.historyTitles.length} 篇文章标题（择优借鉴风格）：\n${args.historyTitles.slice(0, 20).map((t, i) => `${i + 1}. ${t}`).join("\n")}`
      : "用户暂无历史";

  const sys = `你是学术内容选题专家。给定期刊和用户历史，推荐 ${args.limit} 个最相关的写作主题。
**只输出纯 JSON**（不要 markdown 包裹）：
[{"topic":"主题名 < 30 字","reason":"30 字内推荐理由"}, ...]
要求：
- 共 ${args.limit} 条
- 主题真实可写、具体（不要"AI 在 X 中的应用"这种泛主题）
- reason 说明为什么这主题对这本期刊和用户合适`;

  const user = `${journalHint}\n\n${historyHint}`;

  const resp = await provider.chat({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.5,
    maxTokens: 600,
  });
  const text = resp.content.trim().replace(/^```json\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn({ raw: text.slice(0, 200) }, "P3 topic-recommender LLM JSON parse 失败");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (p: unknown): p is TopicRecommendation =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as { topic?: unknown }).topic === "string" &&
        typeof (p as { reason?: unknown }).reason === "string",
    )
    .slice(0, args.limit);
}
