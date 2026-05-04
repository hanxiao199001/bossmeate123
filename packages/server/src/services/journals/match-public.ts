/**
 * 公开匿名期刊匹配 —— PR B.9
 *
 * 用户在 /try 页贴论文摘要 → AI 推荐 5 本最对口期刊。
 * 无 tenant / 无 user，纯 LLM（Qwen-Plus）即时返回，不持久化、不生成完整 article。
 * Rate-limit 在路由层做（10/IP/min），本函数只做 LLM 调用 + JSON 解析。
 */
import { z } from "zod";
import { getProviders } from "../ai/provider-factory.js";
import { logger } from "../../config/logger.js";

export const matchSchema = z.object({
  abstract: z.string().min(50, "摘要至少 50 字").max(3000, "摘要不超过 3000 字"),
});

const journalItemSchema = z.object({
  name: z.string(),
  discipline: z.string().optional().default(""),
  partition: z.string().optional().default(""),
  impactFactor: z.number().optional().default(0),
  reason: z.string(),
});

export type JournalMatch = z.infer<typeof journalItemSchema>;

const SYSTEM_PROMPT = `你是学术期刊匹配专家。客户给你一段论文摘要，你给出 5 本最对口的国际/中文期刊推荐。
**只输出 JSON 数组**（不要 markdown 代码块、不要解释、不要多余文字），格式严格：
[{"name":"期刊全名","discipline":"学科分类","partition":"中科院分区如「医学 2 区」或 SCI 二区","impactFactor":数字,"reason":"为什么推荐这本，30 字内"}, ...]
要求：5 条记录；优先 SCI/SSCI；如客户摘要是中文医学/教育类可推中文核心；reason 要具体（如「方向匹配 + IF 较稳」）。`;

export async function matchJournalsPublic(abstract: string): Promise<JournalMatch[]> {
  const provider = getProviders().cheap[0];
  if (!provider) throw new Error("无可用 LLM provider");
  const resp = await provider.chat({
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: abstract }],
    temperature: 0.3,
    maxTokens: 800,
  });
  const text = resp.content.trim().replace(/^```json\s*|\s*```$/g, "");
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (err) { logger.warn({ raw: text.slice(0, 200) }, "matchJournalsPublic JSON 解析失败"); throw new Error("LLM 返回格式错"); }
  const arr = z.array(journalItemSchema).min(1).max(8).parse(parsed);
  return arr.slice(0, 5);
}
