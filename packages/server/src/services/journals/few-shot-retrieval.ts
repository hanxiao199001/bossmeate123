/**
 * PR Q.3：few-shot 行业样板检索。query → embed → LanceDB industry_sample 仓 vector
 * → hybrid score (vector 0.6 + keyword 0.3 + style 0.1) → top-K。设计文档锁公式。
 */
import { logger } from "../../config/logger.js";
import { getEmbedding } from "../knowledge/embedding-service.js";
import { searchVectors } from "../knowledge/vector-store.js";

export type SampleStyleTag = "academic" | "marketing" | "popular" | "vertical";

export interface FewShotSample {
  title: string;
  bodySnippet: string;     // 截首段 ≤ 600 字（≤ ~150 token，避免 prompt 爆）
  sourceAccount: string;
  styleTag: SampleStyleTag;
  score: number;           // hybrid 总分 0-1
}

interface RetrieveOptions {
  tenantId: string;
  styleTag: SampleStyleTag;
  query: string;            // 用户 prompt + parsed.topic 拼接
  topK?: number;            // 默认 3
}

const W_VECTOR = 0.6;
const W_KEYWORD = 0.3;
const W_STYLE = 0.1;

/** 简单 keyword overlap：query 与 title+body 的中文 / 英文 token 共现率。 */
function keywordOverlap(query: string, sampleText: string): number {
  const tokens = (s: string) =>
    new Set(s.toLowerCase().split(/[\s，。！？,.\!\?]+/).filter((t) => t.length >= 2));
  const q = tokens(query);
  const s = tokens(sampleText);
  if (q.size === 0) return 0;
  let hit = 0;
  for (const t of q) if (s.has(t)) hit += 1;
  return hit / q.size;
}

export async function retrieveSamples(opts: RetrieveOptions): Promise<FewShotSample[]> {
  const { tenantId, styleTag, query, topK = 3 } = opts;

  let queryVector: number[];
  try {
    const emb = await getEmbedding(query);
    queryVector = emb.vector;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "Q.3 few-shot: embedding 失败，跳过 few-shot");
    return [];
  }

  let candidates: Awaited<ReturnType<typeof searchVectors>> = [];
  try {
    candidates = await searchVectors({
      vector: queryVector,
      tenantId,
      category: "industry_sample",
      limit: topK * 5, // 多取一些供 client 端 style_tag 过滤后再排序
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "Q.3 few-shot: LanceDB 查询失败");
    return [];
  }

  if (candidates.length === 0) {
    logger.info({ styleTag, tenantId }, "Q.3 few-shot: industry_sample 仓为空（爬虫尚未跑或 0 命中）");
    return [];
  }

  const scored: FewShotSample[] = [];
  for (const c of candidates) {
    let metaObj: { sourceAccount?: string; styleTag?: string } = {};
    try { metaObj = JSON.parse(c.metadata || "{}"); } catch { /* swallow */ }
    const cStyle = (metaObj.styleTag as SampleStyleTag | undefined) ?? "vertical";
    const styleMatch = cStyle === styleTag ? 1 : 0;
    const vectorSim = 1 / (1 + c._distance);  // L2 距离 → 相似度
    const keywordSim = keywordOverlap(query, `${c.title} ${c.content}`);
    const score = W_VECTOR * vectorSim + W_KEYWORD * keywordSim + W_STYLE * styleMatch;
    scored.push({
      title: c.title,
      bodySnippet: c.content.slice(0, 600),
      sourceAccount: metaObj.sourceAccount ?? "unknown",
      styleTag: cStyle,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** 把 top-K 样本格式化为 prompt 注入文本（system prompt 用）。 */
export function formatSamplesForPrompt(samples: FewShotSample[]): string {
  if (samples.length === 0) return "";
  const lines = samples.map(
    (s, i) =>
      `### 样板 ${i + 1}（来源：${s.sourceAccount} · 风格：${s.styleTag} · 相似度 ${(s.score * 100).toFixed(0)}%）\n`
      + `标题：${s.title}\n`
      + `首段：${s.bodySnippet}\n`,
  );
  return `\n## 行业样板参考（请借鉴语气，不复制内容）\n${lines.join("\n")}`;
}
