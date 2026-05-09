/**
 * P5 industry topic generator（5-14 V2 P5）。
 *
 * 输入：industry ('medical' | 'it' | 'law' | 'education')
 * 输出：50 个 article topic 数组
 *
 * Spec 严格约束（user 强约束）：
 * - 学术专业，不 sensational（避免标题党）
 * - 50 个主题分散不重复（覆盖子领域）
 * - 12-30 字长度
 * - 行业示例 topic 引导（few-shot 见下文）
 * - JSON 数组输出，禁止 markdown 包裹
 */
import { logger } from "../../config/logger.js";
import { getProviders } from "../ai/provider-factory.js";

export type Industry = "medical" | "it" | "law" | "education";

export const INDUSTRIES: readonly Industry[] = ["medical", "it", "law", "education"] as const;

/** 4 行业绑定 4 模板（5-14 spec：固定，不轮询；5-22 后 backlog #114）*/
export const INDUSTRY_TEMPLATE_MAP: Record<Industry, string> = {
  medical: "shunshi-style",        // A 学术权威
  it: "industry-vertical",         // E 行业垂直
  law: "shunshi-style",            // A 学术权威
  education: "popular-science",    // C 科普轻松
};

/** 4 行业 few-shot 引导示例（学术风、12-30 字、子领域分散） */
const INDUSTRY_FEW_SHOT: Record<Industry, string[]> = {
  medical: [
    "心血管疾病早期筛查的 AI 辅助诊断进展",
    "肺癌靶向治疗耐药机制临床研究综述",
    "糖尿病肾病蛋白尿生物标志物的最新发现",
  ],
  it: [
    "大语言模型推理优化的工程实践探讨",
    "微服务架构下分布式追踪系统的设计",
    "云原生数据库一致性保障方案对比",
  ],
  law: [
    "数据跨境流动法律框架的国际比较研究",
    "AI 生成内容著作权归属的司法判例分析",
    "个人信息保护法合规审查实务要点",
  ],
  education: [
    "高校思政课混合式教学模式效果实证",
    "项目式学习对中学生科学素养的影响",
    "在线教育中学习者注意力监测技术应用",
  ],
};

const TOPIC_COUNT = 50;
const MIN_LEN = 12;
const MAX_LEN = 30;

export interface IndustryTopicResult {
  industry: Industry;
  topics: string[];
  generatedAt: string;
  llmDurationMs: number;
}

/** 调 LLM 生成 50 个学术主题；失败抛错（caller 决定 retry）*/
export async function generateIndustryTopics(industry: Industry): Promise<IndustryTopicResult> {
  const t0 = Date.now();
  const provider = getProviders().cheap[0];
  if (!provider) throw new Error("无可用 LLM provider");

  const fewShot = INDUSTRY_FEW_SHOT[industry];
  const industryName: Record<Industry, string> = {
    medical: "医学",
    it: "信息技术 / 计算机科学",
    law: "法学",
    education: "教育学",
  };

  const sys = `你是 ${industryName[industry]} 领域学术内容选题专家。给定行业，给出 ${TOPIC_COUNT} 个高质量 article 主题。

**严格约束**：
1. **学术专业**：不要"震惊体"/"标题党"/"史上最 X"等 sensational 措辞
2. **${TOPIC_COUNT} 个主题分散不重复**：覆盖子领域（如医学含心血管/肿瘤/内分泌/影像/...）
3. **每主题 ${MIN_LEN}-${MAX_LEN} 字**：精准表达不冗长
4. **风格参考**（${industryName[industry]} 行业示例）：
${fewShot.map((t, i) => `   ${i + 1}. ${t}`).join("\n")}

**输出**：纯 JSON 数组（禁止 markdown 包裹 / 禁止解释）：
["主题1","主题2",...,"主题${TOPIC_COUNT}"]`;

  const user = `生成 ${TOPIC_COUNT} 个 ${industryName[industry]} 行业本月最新热门 article 主题。`;

  const resp = await provider.chat({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.7, // 主题需多样性
    maxTokens: 2500,
  });

  const text = resp.content.trim().replace(/^```json\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn({ industry, raw: text.slice(0, 300) }, "P5 topic-generator JSON parse 失败");
    throw new Error("LLM 返回 JSON 解析失败");
  }

  if (!Array.isArray(parsed)) throw new Error("LLM 返回不是数组");
  // 过滤：长度 + 去重
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const t of parsed) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    topics.push(trimmed);
  }

  if (topics.length < 10) {
    throw new Error(`LLM 返回有效主题过少（${topics.length}/${TOPIC_COUNT}），疑 prompt 失败`);
  }
  if (topics.length > TOPIC_COUNT) topics.length = TOPIC_COUNT;

  return {
    industry,
    topics,
    generatedAt: new Date().toISOString(),
    llmDurationMs: Date.now() - t0,
  };
}
