/**
 * 选题技能（TopicSkill）
 *
 * 对齐詹金晶的工作流：
 * Step 1: 选刊 → 从期刊库筛选期刊
 * Step 2: 找噱头 → AI分析期刊近期动态，找到有话题性的角度
 * Step 3: 出标题 → AI基于期刊+噱头，生成多个吸引人的公众号标题
 * Step 4: 写文章 → AI围绕选定标题，写完整的公众号文章
 */

import { getProvider } from "../ai/provider-factory.js";
import { logger } from "../../config/logger.js";

interface JournalInfo {
  name: string;
  nameEn?: string;
  discipline?: string;
  partition?: string;
  impactFactor?: number;
  acceptanceRate?: number;
  reviewCycle?: string;
  isWarningList?: boolean;
  warningYear?: string;
}

interface HookResult {
  hooks: Array<{
    angle: string;        // 噱头角度
    description: string;  // 简要说明
    heatLevel: "高" | "中" | "低";
  }>;
}

interface TitleResult {
  titles: Array<{
    title: string;
    style: string;     // 风格类型：震惊体 | 数据体 | 悬念体 | 对比体
    hook: string;      // 用到的噱头
  }>;
}

interface ArticleResult {
  title: string;
  content: string;     // Markdown格式的公众号文章正文
  wordCount: number;
  seoKeywords: string[];
}

/**
 * Step 2: 为选定期刊找噱头
 */
export async function findHooks(journal: JournalInfo): Promise<HookResult> {
  const provider = getProvider("cheap");
  if (!provider) throw new Error("AI模型未配置");

  const systemPrompt = `你是一名资深学术期刊自媒体运营专家。你的任务是为指定期刊找到有话题性、能吸引目标读者（准备发论文的硕博研究生、高校教师）点击的"噱头"角度。

噱头类型参考：
1. 期刊动态：降区预警、影响因子大涨大跌、被踢出数据库、新入选核心
2. 政策变化：投稿规则变更、审稿周期变化、版面费调整
3. 热门事件：大规模撤稿、学术不端案例、录用率突变
4. 选刊建议：这个期刊适合什么人投、容不容易中、审稿快不快
5. 对比分析：和同领域其他期刊对比优劣势

重要：给出的噱头要具体、有数据感，不要泛泛而谈。`;

  const userPrompt = `请为以下期刊找 5 个有话题性的噱头角度：

期刊名称：${journal.name}
英文名：${journal.nameEn || "未知"}
学科：${journal.discipline || "未知"}
分区：${journal.partition || "未知"}
影响因子：${journal.impactFactor ?? "未知"}
录用率：${journal.acceptanceRate ? `${(journal.acceptanceRate * 100).toFixed(0)}%` : "未知"}
审稿周期：${journal.reviewCycle || "未知"}
是否预警：${journal.isWarningList ? `是（${journal.warningYear || ""}年预警）` : "否"}

请以JSON格式返回：
{
  "hooks": [
    { "angle": "噱头角度标题", "description": "简要说明为什么这个角度吸引人", "heatLevel": "高/中/低" }
  ]
}

只返回JSON，不要其他内容。`;

  const response = await provider.chat({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
    maxTokens: 2000,
  });

  try {
    const jsonStr = response.content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(jsonStr);
  } catch {
    logger.warn("噱头解析失败，返回默认噱头");
    return {
      hooks: [
        { angle: `${journal.name}最新分区变化解读`, description: "分区变化是读者最关心的话题", heatLevel: "高" },
        { angle: `${journal.name}投稿避坑指南`, description: "实用性强，新手最爱", heatLevel: "中" },
        { angle: `${journal.name}影响因子趋势分析`, description: "数据驱动的内容有说服力", heatLevel: "中" },
      ],
    };
  }
}

/**
 * Step 3: 基于期刊+噱头生成标题
 */
export async function generateTitles(
  journal: JournalInfo,
  hookAngle: string
): Promise<TitleResult> {
  const provider = getProvider("cheap");
  if (!provider) throw new Error("AI模型未配置");

  const systemPrompt = `你是一名擅长写公众号爆款标题的学术期刊自媒体运营。你要根据期刊信息和噱头角度，创作能让硕博研究生忍不住点进来的标题。

标题原则：
1. 数据 > 形容词（"发文量暴涨300%" 比 "发文量大幅增长" 好）
2. 具体 > 模糊（写出具体的期刊名、IF值、分区等）
3. 悬念/冲突/反差要强（"一区期刊竟然这么容易中？"）
4. 控制在25字以内
5. 可以夸张但不能造谣（可以说"震惊"，但数据要合理）`;

  const userPrompt = `期刊：${journal.name}（${journal.nameEn || ""}）
学科：${journal.discipline || ""}
分区：${journal.partition || ""}
影响因子：${journal.impactFactor ?? "未知"}
噱头角度：${hookAngle}

请生成 6 个风格各异的公众号标题，以JSON格式返回：
{
  "titles": [
    { "title": "标题文字", "style": "震惊体/数据体/悬念体/对比体/干货体/问答体", "hook": "用到的噱头" }
  ]
}

只返回JSON。`;

  const response = await provider.chat({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.9,
    maxTokens: 1500,
  });

  try {
    const jsonStr = response.content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(jsonStr);
  } catch {
    return {
      titles: [
        { title: `${journal.name}最新消息：${hookAngle}`, style: "干货体", hook: hookAngle },
      ],
    };
  }
}

/**
 * Step 4: 基于选定标题写完整公众号文章
 */
export async function generateArticle(
  journal: JournalInfo,
  title: string,
  hookAngle: string
): Promise<ArticleResult> {
  const provider = getProvider("expensive") || getProvider("cheap");
  if (!provider) throw new Error("AI模型未配置");

  const systemPrompt = `你是一名资深学术期刊自媒体写手，擅长写公众号文章。你的文章特点：
1. 开头直击痛点，3秒内抓住读者
2. 内容有料有据，穿插具体数据和案例
3. 语言通俗但不失专业，像一个学长在分享经验
4. 适当使用emoji但不过度
5. 结尾有行动指引（"想了解更多可以关注我们"）
6. 文章长度1000-1500字，适合公众号阅读

文章结构：
- 开头：用噱头吸引注意力（1-2段）
- 期刊基本介绍：名称、分区、IF、学科（1段）
- 核心内容：围绕噱头角度展开分析（3-4段）
- 实用建议：投稿建议、注意事项（1-2段）
- 结尾：总结+引流（1段）

重要：所有数据尽量准确。如果不确定，用模糊表述而不是编造具体数字。`;

  const userPrompt = `请围绕以下信息写一篇公众号文章：

标题：${title}
期刊名称：${journal.name}（${journal.nameEn || ""}）
学科领域：${journal.discipline || "未知"}
分区：${journal.partition || "未知"}
影响因子：${journal.impactFactor ?? "未知"}
录用率：${journal.acceptanceRate ? `${(journal.acceptanceRate * 100).toFixed(0)}%` : "未知"}
审稿周期：${journal.reviewCycle || "未知"}
是否预警：${journal.isWarningList ? `是（${journal.warningYear || ""}年预警）` : "否"}
噱头角度：${hookAngle}

请直接输出Markdown格式的文章正文（不要再重复标题），最后一行输出关键词（用逗号分隔）。`;

  const response = await provider.chat({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
    maxTokens: 4000,
  });

  const content = response.content;
  const lines = content.split("\n");

  // 提取最后一行作为关键词
  let seoKeywords: string[] = [];
  const lastLine = lines[lines.length - 1];
  if (lastLine && (lastLine.includes("关键词") || lastLine.includes(","))) {
    seoKeywords = lastLine
      .replace(/^关键词[:：]\s*/, "")
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter(Boolean);
  }

  return {
    title,
    content: content,
    wordCount: content.length,
    seoKeywords,
  };
}
