/**
 * P0四件套④：压缩去水分 pass
 *
 * 为什么：老韩六维里"结构与信息密度"占 20%，AI 初稿普遍有 20-30% 的"不承载信息的
 * 句子和套话"。一次 LLM 压缩到 ~72%，信息密度直接上一档。
 *
 * 安全护栏（每条都是为了"绝不把文章压坏"）：
 * - <800 字（纯文本）跳过 —— 短文没水分可挤，压了反而丢信息
 * - 模板 HTML 文章跳过 —— 期刊推荐模板文是数据卡+图表拼装，压缩会破排版；
 *   其水分治理走 decliche 段落级清洗
 * - 压缩后字数必须落在原文 55%-90% 之间才采用（防过度压缩/根本没压）
 * - LLM 失败返回原文；env ARTICLE_CONDENSE=false 一键关闭
 */
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { chat } from "../ai/chat-service.js";
import { looksLikeHtml } from "./decliche.js";

export interface CondenseResult {
  body: string;
  applied: boolean;
  /** 未压缩时的原因（disabled/too_short/html_template/ratio_out_of_range/llm_failed） */
  reason?: string;
  /** 压缩后/压缩前 的纯文本字数比 */
  ratio?: number;
  llmCalls: number;
}

/** 纯文本字数（剥掉 HTML 标签后） */
function plainLength(body: string): number {
  return (body || "").replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
}

/**
 * 压缩去水分。targetRatio 默认 0.72（压到原文 72% 左右）。
 */
export async function condenseArticle(
  body: string,
  opts: { tenantId: string; userId?: string; targetRatio?: number }
): Promise<CondenseResult> {
  if (env.ARTICLE_CONDENSE === "false") {
    return { body, applied: false, reason: "disabled", llmCalls: 0 };
  }
  const originalPlain = plainLength(body);
  if (originalPlain < 800) {
    return { body, applied: false, reason: "too_short", llmCalls: 0 };
  }
  // 模板 HTML（数据卡/图表拼装）不整文压缩：LLM 复述上万字符 inline-style HTML
  // 既贵又极易改坏排版，性价比为负
  if (looksLikeHtml(body)) {
    return { body, applied: false, reason: "html_template", llmCalls: 0 };
  }

  const targetRatio = opts.targetRatio ?? 0.72;
  const targetWords = Math.round(originalPlain * targetRatio);

  try {
    const resp = await chat({
      tenantId: opts.tenantId,
      userId: opts.userId || "system",
      conversationId: `condense-${Date.now()}`,
      skillType: "content_generation",
      message: `请压缩以下文章去掉水分：
1. 删除所有不承载信息的句子和套话（铺垫、复读、空洞评价、"正如前文所说"式回指）
2. 压缩到原文 ${Math.round(targetRatio * 100)}% 左右（目标约 ${targetWords} 字）
3. 保留全部数据/事实/数字/案例，一个都不能丢；保留所有小标题、结构、Markdown 排版标记
4. 一句能说清的不用两句；不要新增内容，不要改写观点
5. 直接输出压缩后的全文，不要 JSON、不要解释

原文：
${body}`,
    });

    const newBody = (resp.content || "").trim();
    const newPlain = plainLength(newBody);
    const ratio = originalPlain > 0 ? newPlain / originalPlain : 1;

    // 采用区间校验：55%-90% 之外说明 LLM 压过头或没压，弃用
    if (!newBody || ratio < 0.55 || ratio > 0.9) {
      logger.warn({ ratio: ratio.toFixed(2), originalPlain, newPlain }, "P0④ 压缩比超出 55%-90% 区间，弃用压缩结果");
      return { body, applied: false, reason: "ratio_out_of_range", ratio, llmCalls: 1 };
    }

    logger.info({ originalPlain, newPlain, ratio: ratio.toFixed(2) }, "P0④ 压缩去水分完成");
    return { body: newBody, applied: true, ratio, llmCalls: 1 };
  } catch (err) {
    // 兜底：LLM 挂了用原文，绝不阻塞生成
    logger.warn({ err: err instanceof Error ? err.message : err }, "P0④ 压缩 LLM 失败，保留原文");
    return { body, applied: false, reason: "llm_failed", llmCalls: 1 };
  }
}
