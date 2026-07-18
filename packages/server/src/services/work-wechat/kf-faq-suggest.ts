/**
 * 「从历史对话学习」FAQ 建议 —— 纯函数部分（供 routes/work-wechat-kf.ts 的 /admin/kf/faq-suggestions 复用，可单测）。
 *
 * 合规实现（不做黑箱自动学，避免学歪）：
 *   扫最近转人工/人工回复的会话 → 把「客户问题 + 人工真实回答」喂 LLM 提炼成候选 FAQ →
 *   返回给老板逐条编辑/采纳 → 采纳的走批量导入入库。全程人过目，不自动落库。
 *
 * 本模块只负责：会话消息 → LLM 输入文本、LLM 输出 → 候选数组（纯函数，无 IO）。
 * LLM 调用与 DB 查询在路由层做（成本护栏：会话数上限、失败兜底不阻塞）。
 */

export interface KfMsgLite {
  direction: "in" | "out";
  content: string;
  aiAction: string | null;
  msgType: string;
}

export interface QaCandidate {
  question: string;
  answer: string;
}

const HUMAN_ACTIONS = new Set(["manual", "human_wecom"]); // 人工回复（系统内人工 / 企微端人工），排除 AI answered/transferred

/**
 * 单会话消息（asc 顺序）→ 喂 LLM 的带角色标注文本。
 * 只取：客户文本入站(direction=in, text) + 人工回复出站(aiAction ∈ manual/human_wecom)。
 * AI 自动回复(answered)、转人工话术(transferred)、占位消息(skipped) 不进 —— 我们要学的是"人怎么答"。
 * 超 maxChars 从头部截断（保留最近对话）。
 */
export function formatConversationForLlm(messages: KfMsgLite[], maxChars = 1200): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.msgType !== "text") continue;
    const content = (m.content ?? "").trim();
    if (!content) continue;
    if (m.direction === "in") {
      lines.push(`客户：${content}`);
    } else if (m.direction === "out" && m.aiAction && HUMAN_ACTIONS.has(m.aiAction)) {
      lines.push(`人工客服：${content}`);
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(text.length - maxChars); // 留最近
  return text.trim();
}

/** 是否值得提炼：至少要有一条客户问 + 一条人工答，否则没料 */
export function conversationHasHumanAnswer(messages: KfMsgLite[]): boolean {
  let hasCustomer = false;
  let hasHuman = false;
  for (const m of messages) {
    if (m.msgType !== "text" || !(m.content ?? "").trim()) continue;
    if (m.direction === "in") hasCustomer = true;
    else if (m.direction === "out" && m.aiAction && HUMAN_ACTIONS.has(m.aiAction)) hasHuman = true;
    if (hasCustomer && hasHuman) return true;
  }
  return false;
}

/** 构造提炼用 systemPrompt（约束：只提炼可复用的通用问答，忠于人工答案，不编数字，JSON 输出） */
export function buildSuggestSystemPrompt(maxCandidates: number): string {
  return `你是学术期刊咨询公司的客服知识库整理助手。下面是若干条"真实客户咨询 + 人工客服回答"的对话记录。
你的任务：从中提炼出可以沉淀为标准 FAQ 的通用问答，供以后 AI 客服自动回答类似问题。
铁律：
1. 只提炼"以后其他客户也会问、答案具有普适性"的问题；一次性的、个案的、含具体客户隐私/订单号的对话跳过。
2. 答案必须忠于人工客服的原话，可做通用化改写（去掉针对某个客户的称呼/细节），但禁止新增人工没说过的数字、时长、价格、比例或承诺。
3. 若某段对话没有值得沉淀的通用问答，直接跳过，不要硬凑。
4. 最多提炼 ${maxCandidates} 条。
只输出 JSON 数组，不要输出任何其他文字，格式：[{"question":"问题","answer":"标准答案"}]。若无可提炼，输出 []。`;
}

/** 把多个会话拼成 LLM 的 user 消息（每会话一段，编号分隔） */
export function buildSuggestUserMessage(conversationTexts: string[]): string {
  const blocks = conversationTexts
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t, i) => `【对话 ${i + 1}】\n${t}`);
  return blocks.join("\n\n");
}

/** 从 LLM 输出里抠 JSON 数组 → 候选列表（容忍 ```json 围栏 / 前后废话；坏输出返回 []） */
export function parseSuggestions(raw: string): QaCandidate[] {
  if (!raw) return [];
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: QaCandidate[] = [];
  const seen = new Set<string>();
  for (const r of parsed) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const question = String(rec.question ?? "").trim().slice(0, 500);
    const answer = String(rec.answer ?? "").trim().slice(0, 4000);
    if (!question || !answer) continue;
    const key = question.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question, answer });
  }
  return out;
}
