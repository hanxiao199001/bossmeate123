/**
 * 7-27 AI 兜底文案 —— **单一来源**。
 *
 * 背景(7-27 事故): chat() 在主备模型全挂时不抛错, 而是返回一句人类可读的兜底文案
 * ("抱歉，AI暂时无法响应，请稍后重试。")。这句话对聊天场景是友好提示, 对**生成链路**
 * 却是一颗定时炸弹 —— title-generator 的"按行拆"兜底把它当成了候选标题, 于是
 * 一篇标题=占位文的文章拿着六维 80 分、status=generated 一路溜进公众号草稿箱。
 *
 * 为什么要集中管理: 兜底文案原本散在 chat-service 的 4 处硬编码里。检查器如果自己抄一份
 * 字符串, 以后有人加/改一句兜底文案, 闸就静默漏掉那一句 —— 这正是"检查器与被检查方
 * 各写一套判据"的经典失效。现在两边都 import 本文件, 加新文案只改这里一处。
 *
 * ⚠️ 新增兜底文案时: 加进 AI_FALLBACK_MESSAGES 即可, 出稿健康闸(publisher/output-health.ts)
 * 与六维质检的"AI 不可用"识别会自动覆盖到。
 */

/** 无可用模型(路由表空/全部熔断) */
export const AI_FALLBACK_NO_MODEL = "抱歉，当前没有可用的AI模型，请检查配置。";

/** 主备模型全部调用失败(超时/4xx/5xx) */
export const AI_FALLBACK_UNAVAILABLE = "抱歉，AI暂时无法响应，请稍后重试。";

/** routes/chat 工坊对话在拿不到 provider 时落进 messages 表的助手回复(原两处硬编码) */
export const AI_FALLBACK_NO_MODEL_HINT = "当前没有可用的AI模型，请在 .env 中配置 API Key。";

/**
 * 全部兜底文案。**出稿健康闸的判据来源**。
 * 只放"会被当成模型输出返回给调用方"的文案 —— HTTP 层的 500 报错文案(routes/*.ts 的
 * "操作失败，请稍后重试")不进这里: 它们不会流进 contents 表, 收进来只会扩大误伤面。
 * (NO_MODEL_HINT 理论上也只进 messages 表, 但它是整句、正常文章零概率出现, 收进来只赚不赔。)
 */
export const AI_FALLBACK_MESSAGES: readonly string[] = [
  AI_FALLBACK_NO_MODEL,
  AI_FALLBACK_UNAVAILABLE,
  AI_FALLBACK_NO_MODEL_HINT,
];

/**
 * 匹配用归一化: 剥 HTML → 去空白 → 去中英文标点 → 小写。
 *
 * 为什么要归一化: 同一句兜底文案在正文里可能被模板包成 `<p>抱歉，AI暂时无法响应…</p>`、
 * 被 LLM 复述成半角逗号、或中间被插入空格。只做 includes(原文) 会漏。
 */
export function normalizeForFallbackMatch(input: string | null | undefined): string {
  if (!input) return "";
  return String(input)
    .replace(/<[^>]+>/g, " ")
    .replace(/[\s　]/g, "")
    .replace(/[，,。.、；;：:！!？?~～…—\-“”"'‘’()（）【】\[\]]/g, "")
    .toLowerCase();
}

/**
 * 文本里是否混进了系统兜底文案。命中返回**原始文案**(供日志/落库说明原因), 否则 null。
 *
 * 判据是**整句特征**而不是"抱歉"二字 —— 正常内容里完全可能出现"抱歉"(如"很抱歉地通知
 * 各位, 该刊已被剔除"), 只匹配两个字必然大面积误伤。归一化后要求整句连续出现。
 */
export function findAiFallbackText(text: string | null | undefined): string | null {
  const norm = normalizeForFallbackMatch(text);
  if (!norm) return null;
  for (const msg of AI_FALLBACK_MESSAGES) {
    if (norm.includes(normalizeForFallbackMatch(msg))) return msg;
  }
  return null;
}

/** 这段文本"整体就是"一句兜底文案(而不是正常内容里夹了一句) —— 用于判定 LLM 这次调用等于没返回。 */
export function isAiFallbackText(text: string | null | undefined): boolean {
  const norm = normalizeForFallbackMatch(text);
  if (!norm) return false;
  return AI_FALLBACK_MESSAGES.some((m) => {
    const n = normalizeForFallbackMatch(m);
    // 允许前后有少量残留(如 "```" 包裹), 但主体必须是兜底文案
    return norm.includes(n) && norm.length <= n.length + 20;
  });
}
