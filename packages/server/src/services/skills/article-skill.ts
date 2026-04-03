/**
 * 图文线 Skill - BossMate 第一条业务线（V2 质量优化版）
 *
 * 完整流程：
 * 需求理解 → 大纲生成 → 基于大纲逐章节生成 → 质检(AI+硬指标) → 修改式重试
 *
 * V2 改进：
 * 1. 新增大纲生成阶段（3个候选标题 + 结构化章节 + 写作策略）
 * 2. 质检改用独立模型 + 硬指标（字数偏差/段落数/关键词覆盖）
 * 3. 重试改为"修改"而非"重写"
 * 4. 支持用户历史偏好反馈注入
 */

import { logger } from "../../config/logger.js";
import type { AIProvider, ChatMessage } from "../ai/providers/base.js";
import type { ISkill, SkillContext, SkillResult } from "./base-skill.js";
import { retrieveForArticle } from "../knowledge/rag-retriever.js";
import { modelRouter } from "../ai/model-router.js";

// ============ 类型定义 ============

export type ArticleStage =
  | "understanding"
  | "clarifying"
  | "outlining"       // V2 新增
  | "generating"
  | "quality_check"
  | "revising"        // V2 新增
  | "editing"
  | "ready"
  | "published";

export interface ArticleContext {
  originalRequest: string;
  parsedRequirement?: ParsedRequirement;
  clarifications: Array<{ question: string; answer: string }>;
  outline?: ArticleOutline;   // V2 新增
  ragContext?: string;
  article?: GeneratedArticle;
  qualityReport?: QualityReport;
  stage: ArticleStage;
}

interface ParsedRequirement {
  topic: string;
  audience: string;
  articleType: string;
  wordCount: number;
  keyPoints: string[];
  tone: string;
  references: string[];
  needsClarification: boolean;
  clarificationQuestions: string[];
}

// V2: 大纲结构
interface ArticleOutline {
  titleCandidates: string[];          // 3 个候选标题
  selectedTitle: string;              // 选中的标题
  sections: OutlineSection[];         // 章节结构
  writingStrategy: {
    opening: string;                  // 开头切入方式
    argumentStructure: string;        // 论证结构
    closing: string;                  // 结尾收束方式
  };
  totalEstimatedWords: number;
}

interface OutlineSection {
  heading: string;                    // 小标题
  keyPoints: string[];                // 该章节要覆盖的要点
  estimatedWords: number;             // 预计字数
}

interface GeneratedArticle {
  title: string;
  body: string;
  summary: string;
  tags: string[];
  wordCount: number;
}

// V2: 质检报告增强
interface QualityReport {
  aiScore: number;            // AI 评分 0-100
  hardMetrics: {
    wordDeviation: number;    // 字数偏差率（0-1）
    wordDeviationScore: number;
    paragraphCount: number;
    paragraphScore: number;
    keyPointCoverage: number; // 关键词覆盖率（0-1）
    keyPointScore: number;
  };
  totalScore: number;         // 综合分 (AI 50% + 硬指标 50%)
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

// ============ 图文线 Skill ============

export class ArticleSkill implements ISkill {
  readonly name = "article";
  readonly displayName = "智能图文";
  readonly description = "基于 RAG 知识库的学术/行业图文生成，含大纲规划和自动质检";
  readonly preferredTier = "expensive" as const;

  private provider: AIProvider;

  constructor(provider: AIProvider) {
    this.provider = provider;
  }

  async handle(
    userInput: string,
    history: ChatMessage[],
    context: SkillContext
  ): Promise<SkillResult> {
    const { parsed, response } = await this.understandRequirement(userInput, history);

    if (parsed.needsClarification) {
      return { reply: response };
    }

    // RAG 检索
    let ragText = context.ragContext;
    if (!ragText) {
      try {
        const ragResult = await retrieveForArticle({
          tenantId: context.tenantId,
          topic: parsed.topic,
          audience: parsed.audience,
          tone: parsed.tone,
          keywords: parsed.keyPoints,
        });
        ragText = ragResult.text;
      } catch (err) {
        logger.warn({ err }, "RAG retrieval failed, proceeding without context");
      }
    }

    // V2: 提取用户历史偏好反馈
    const previousFeedback = (context.metadata?.previousFeedback as string) || "";

    // V2 流程: 大纲 → 生成 → 质检 → (修改)
    const { article, quality } = await this.fullGenerate(parsed, ragText, previousFeedback);

    return {
      reply: response,
      artifact: {
        type: "article",
        title: article.title,
        body: article.body,
        summary: article.summary,
        tags: article.tags,
        metadata: {
          wordCount: article.wordCount,
          qualityScore: quality.totalScore,
          qualityPassed: quality.passed,
          aiScore: quality.aiScore,
          hardMetrics: quality.hardMetrics,
          issues: quality.issues,
          suggestions: quality.suggestions,
        },
      },
    };
  }

  // ============ 步骤 1: 需求理解 ============

  async understandRequirement(
    userInput: string,
    history: ChatMessage[] = []
  ): Promise<{ parsed: ParsedRequirement; response: string }> {
    const systemPrompt = `你是BossMate AI超级员工的"需求分析师"角色。你的任务是理解老板的内容创作需求，并拆解为结构化信息。

规则：
1. 从用户的话中提取：主题、受众、类型、字数、要点、语气、参考信息
2. 如果信息不足（比如没说清目标受众、字数、风格等），设 needsClarification 为 true，并列出需要追问的问题
3. 追问问题要自然、简洁，像助理在确认需求，不要像填表
4. 如果用户信息足够明确，直接拆解，needsClarification 设为 false

输出严格 JSON 格式：
{
  "topic": "文章主题",
  "audience": "目标受众",
  "articleType": "科普|资讯|评论|推广|通知|其他",
  "wordCount": 800,
  "keyPoints": ["要点1", "要点2"],
  "tone": "专业严谨|轻松活泼|正式官方|亲切温和",
  "references": ["参考信息"],
  "needsClarification": true,
  "clarificationQuestions": ["问题1", "问题2"]
}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userInput },
    ];

    const result = await this.provider.chat({
      messages,
      temperature: 0.3,
      maxTokens: 1024,
    });

    let parsed: ParsedRequirement;
    let response: string;

    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("未找到 JSON");
      }
    } catch {
      logger.warn("需求解析JSON提取失败，触发追问");
      parsed = {
        topic: userInput.slice(0, 50),
        audience: "未指定",
        articleType: "其他",
        wordCount: 800,
        keyPoints: [],
        tone: "专业严谨",
        references: [],
        needsClarification: true,
        clarificationQuestions: [
          "这篇文章主要给谁看的？",
          "希望多少字左右？",
          "有什么重点想要突出的吗？",
        ],
      };
    }

    if (parsed.needsClarification && parsed.clarificationQuestions.length > 0) {
      response = `收到！我先确认几个细节，帮你写出更好的内容：\n\n`;
      parsed.clarificationQuestions.forEach((q, i) => {
        response += `${i + 1}. ${q}\n`;
      });
      response += `\n你可以一次性回答，也可以逐个说。`;
    } else {
      response = `好的，需求明确了！我来帮你写一篇关于「${parsed.topic}」的${parsed.articleType}文章，${parsed.wordCount}字左右，面向${parsed.audience}。\n\n正在规划大纲...`;
    }

    logger.info(
      { topic: parsed.topic, needsClarification: parsed.needsClarification },
      "需求理解完成"
    );

    return { parsed, response };
  }

  // ============ 步骤 2: 大纲生成（V2 新增，最关键的一步）============

  async generateOutline(
    requirement: ParsedRequirement,
    ragContext?: string
  ): Promise<ArticleOutline> {
    let systemPrompt = `你是BossMate AI超级员工的"内容策划专家"。请根据需求为文章生成详细大纲。

需求信息：
- 主题：${requirement.topic}
- 目标受众：${requirement.audience}
- 文章类型：${requirement.articleType}
- 目标字数：${requirement.wordCount}字
- 语气风格：${requirement.tone}
- 关键要点：${requirement.keyPoints.join("、") || "未指定"}`;

    if (ragContext) {
      systemPrompt += `\n\n以下是知识库中的相关资料，请在规划大纲时参考：\n${ragContext}`;
    }

    systemPrompt += `\n\n请输出严格 JSON 格式的大纲：
{
  "titleCandidates": ["标题方案1（25字以内）", "标题方案2", "标题方案3"],
  "selectedTitle": "你认为最好的标题（从3个中选）",
  "sections": [
    {
      "heading": "章节小标题",
      "keyPoints": ["该章节要覆盖的要点1", "要点2", "要点3"],
      "estimatedWords": 200
    }
  ],
  "writingStrategy": {
    "opening": "开头切入方式（如：用数据冲击开头/讲故事引入/直接抛出问题）",
    "argumentStructure": "论证结构（如：总分总/递进式/对比论证/问题-分析-解决方案）",
    "closing": "结尾收束方式（如：总结要点+CTA/展望未来/金句收尾）"
  }
}

要求：
- 3-6个章节，每个章节有2-4个具体要点
- 各章节字数之和应接近目标字数 ${requirement.wordCount}
- 标题要有吸引力，25字以内
- 章节结构逻辑递进，不要堆砌
- 写作策略要具体可执行`;

    const result = await this.provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "请生成文章大纲" },
      ],
      temperature: 0.5,
      maxTokens: 2048,
    });

    let outline: ArticleOutline;

    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        outline = {
          titleCandidates: parsed.titleCandidates || [requirement.topic],
          selectedTitle: parsed.selectedTitle || parsed.titleCandidates?.[0] || requirement.topic,
          sections: (parsed.sections || []).map((s: any) => ({
            heading: s.heading || "",
            keyPoints: s.keyPoints || [],
            estimatedWords: s.estimatedWords || 200,
          })),
          writingStrategy: {
            opening: parsed.writingStrategy?.opening || "直接切入主题",
            argumentStructure: parsed.writingStrategy?.argumentStructure || "总分总",
            closing: parsed.writingStrategy?.closing || "总结要点",
          },
          totalEstimatedWords: 0,
        };
        outline.totalEstimatedWords = outline.sections.reduce((s, sec) => s + sec.estimatedWords, 0);
      } else {
        throw new Error("未找到 JSON");
      }
    } catch {
      // 兜底大纲
      outline = {
        titleCandidates: [requirement.topic],
        selectedTitle: requirement.topic,
        sections: [
          { heading: "引言", keyPoints: ["背景介绍", "问题提出"], estimatedWords: Math.round(requirement.wordCount * 0.2) },
          { heading: "核心分析", keyPoints: requirement.keyPoints.length > 0 ? requirement.keyPoints : ["主要论点", "数据支撑"], estimatedWords: Math.round(requirement.wordCount * 0.5) },
          { heading: "实践建议", keyPoints: ["具体方案", "操作步骤"], estimatedWords: Math.round(requirement.wordCount * 0.2) },
          { heading: "总结", keyPoints: ["要点回顾", "行动号召"], estimatedWords: Math.round(requirement.wordCount * 0.1) },
        ],
        writingStrategy: { opening: "提问式开头", argumentStructure: "总分总", closing: "总结+CTA" },
        totalEstimatedWords: requirement.wordCount,
      };
    }

    logger.info(
      {
        title: outline.selectedTitle,
        sectionCount: outline.sections.length,
        totalWords: outline.totalEstimatedWords,
      },
      "大纲生成完成"
    );

    return outline;
  }

  // ============ 步骤 3: 基于大纲生成文章 ============

  async generateArticle(
    requirement: ParsedRequirement,
    outline: ArticleOutline,
    ragContext?: string,
    previousFeedback?: string
  ): Promise<GeneratedArticle> {
    // 构建章节大纲文本
    const outlineText = outline.sections
      .map((s, i) => `${i + 1}. ${s.heading}（约${s.estimatedWords}字）\n   要点：${s.keyPoints.join("、")}`)
      .join("\n");

    let systemPrompt = `你是BossMate AI超级员工的"内容创作专家"。请严格按照以下大纲逐章节展开，生成完整文章。

文章标题：${outline.selectedTitle}
目标受众：${requirement.audience}
语气风格：${requirement.tone}
目标字数：${requirement.wordCount}字

写作策略：
- 开头方式：${outline.writingStrategy.opening}
- 论证结构：${outline.writingStrategy.argumentStructure}
- 结尾方式：${outline.writingStrategy.closing}

文章大纲：
${outlineText}

要求：
- 严格按照大纲的章节顺序和要点展开，不要遗漏任何要点
- 每个章节用 ## 小标题分隔
- 每个章节的字数尽量接近大纲中的预计字数
- 内容要有数据和案例支撑，不要空泛
- 关键词自然融入，不要堆砌`;

    if (ragContext) {
      systemPrompt += `\n\n以下是知识库中的参考资料，请在文章中适当引用：\n${ragContext}`;
    }

    // V2: 注入用户历史偏好反馈
    if (previousFeedback) {
      systemPrompt += `\n\n用户历史偏好反馈：${previousFeedback}，请在生成时参考这些偏好。`;
    }

    systemPrompt += `\n\n请输出 JSON 格式：
{
  "title": "文章标题",
  "body": "文章正文（Markdown格式，用 ## 分隔章节）",
  "summary": "一句话摘要",
  "tags": ["标签1", "标签2"],
  "wordCount": 实际字数
}`;

    const result = await this.provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `请按照大纲生成完整文章。参考信息：${requirement.references.join("；") || "无"}`,
        },
      ],
      temperature: 0.7,
      maxTokens: 8192,
    });

    let article: GeneratedArticle;

    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        article = JSON.parse(jsonMatch[0]);
      } else {
        article = {
          title: outline.selectedTitle,
          body: result.content,
          summary: result.content.slice(0, 100),
          tags: [requirement.articleType],
          wordCount: result.content.length,
        };
      }
    } catch {
      article = {
        title: outline.selectedTitle,
        body: result.content,
        summary: result.content.slice(0, 100),
        tags: [requirement.articleType],
        wordCount: result.content.length,
      };
    }

    logger.info(
      { title: article.title, wordCount: article.wordCount },
      "图文生成完成"
    );

    return article;
  }

  // ============ 步骤 4: 质检（V2: AI + 硬指标）============

  async qualityCheck(
    article: GeneratedArticle,
    requirement: ParsedRequirement
  ): Promise<QualityReport> {
    // V2: 硬指标自动计算
    const hardMetrics = this.calculateHardMetrics(article, requirement);

    // V2: 质检优先用 cheap 模型（不同模型评判更客观）
    const cheapProvider = modelRouter.selectModel("daily_chat");
    const checkProvider = cheapProvider
      ? { name: cheapProvider.name, model: cheapProvider.model, apiKey: cheapProvider.apiKey, baseUrl: cheapProvider.baseUrl }
      : null;

    const systemPrompt = `你是BossMate AI超级员工的"质检专家"。请对以下文章进行全面质检。

评分维度（每项0-20分，满分100）：
1. 主题相关性：是否围绕「${requirement.topic}」展开
2. 受众匹配度：是否适合「${requirement.audience}」阅读
3. 内容质量：逻辑是否清晰、信息是否准确
4. 语言风格：是否符合「${requirement.tone}」的要求
5. 结构完整性：章节是否完整、过渡是否自然

输出 JSON 格式：
{
  "score": 85,
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"]
}`;

    let aiScore = 75;
    let issues: string[] = [];
    let suggestions: string[] = [];

    try {
      // 使用 cheap 模型做质检（如果可用）
      let result;
      if (checkProvider && checkProvider.name !== "anthropic") {
        const response = await fetch(`${checkProvider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${checkProvider.apiKey}`,
          },
          body: JSON.stringify({
            model: checkProvider.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `标题：${article.title}\n\n正文：\n${article.body.slice(0, 3000)}` },
            ],
            max_tokens: 1024,
            temperature: 0.3,
          }),
        });
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        result = { content: data.choices?.[0]?.message?.content || "" };
      } else {
        result = await this.provider.chat({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `标题：${article.title}\n\n正文：\n${article.body.slice(0, 3000)}` },
          ],
          temperature: 0.3,
          maxTokens: 1024,
        });
      }

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        aiScore = Math.min(Math.max(parsed.score || 75, 0), 100);
        issues = parsed.issues || [];
        suggestions = parsed.suggestions || [];
      }
    } catch (err) {
      logger.warn({ err }, "AI质检调用失败，使用默认分");
    }

    // V2: 综合分 = AI 50% + 硬指标 50%
    const hardScore = (hardMetrics.wordDeviationScore + hardMetrics.paragraphScore + hardMetrics.keyPointScore) / 3;
    const totalScore = Math.round(aiScore * 0.5 + hardScore * 0.5);

    // 硬指标问题追加到 issues
    if (hardMetrics.wordDeviationScore < 70) {
      const deviation = Math.round(hardMetrics.wordDeviation * 100);
      issues.push(`字数偏差 ${deviation}%（要求 ${requirement.wordCount} 字，实际 ${article.wordCount} 字）`);
    }
    if (hardMetrics.paragraphScore < 70) {
      issues.push(`段落数量不合理（${hardMetrics.paragraphCount} 段）`);
    }
    if (hardMetrics.keyPointScore < 70) {
      const coverage = Math.round(hardMetrics.keyPointCoverage * 100);
      issues.push(`关键要点覆盖率仅 ${coverage}%`);
    }

    const report: QualityReport = {
      aiScore,
      hardMetrics,
      totalScore,
      passed: totalScore >= 70,
      issues,
      suggestions,
    };

    logger.info(
      { aiScore, hardScore: Math.round(hardScore), totalScore, passed: report.passed },
      "质检完成"
    );

    return report;
  }

  /**
   * V2: 硬指标自动计算
   */
  private calculateHardMetrics(
    article: GeneratedArticle,
    requirement: ParsedRequirement
  ): QualityReport["hardMetrics"] {
    // a. 字数偏差率
    const actualWords = article.body.length;
    const targetWords = requirement.wordCount;
    const wordDeviation = Math.abs(actualWords - targetWords) / targetWords;
    const wordDeviationScore = wordDeviation <= 0.1 ? 100
      : wordDeviation <= 0.2 ? 85
      : wordDeviation <= 0.3 ? 70
      : wordDeviation <= 0.5 ? 50
      : 30;

    // b. 段落数量
    const paragraphs = article.body
      .split(/\n\n+/)
      .filter((p) => p.trim().length > 10);
    const paragraphCount = paragraphs.length;
    const paragraphScore = (paragraphCount >= 3 && paragraphCount <= 20) ? 100
      : (paragraphCount >= 2 && paragraphCount <= 25) ? 70
      : 40;

    // c. 关键词覆盖率
    const keyPoints = requirement.keyPoints;
    if (keyPoints.length === 0) {
      return {
        wordDeviation, wordDeviationScore,
        paragraphCount, paragraphScore,
        keyPointCoverage: 1, keyPointScore: 100,
      };
    }

    const bodyLower = article.body.toLowerCase();
    const covered = keyPoints.filter((kp) => bodyLower.includes(kp.toLowerCase()));
    const keyPointCoverage = covered.length / keyPoints.length;
    const keyPointScore = keyPointCoverage >= 0.8 ? 100
      : keyPointCoverage >= 0.6 ? 80
      : keyPointCoverage >= 0.4 ? 60
      : 40;

    return {
      wordDeviation, wordDeviationScore,
      paragraphCount, paragraphScore,
      keyPointCoverage, keyPointScore,
    };
  }

  // ============ 步骤 5: 修改式重试（V2: 不重写，而是修改）============

  async reviseArticle(
    originalArticle: GeneratedArticle,
    qualityReport: QualityReport,
    outline: ArticleOutline,
    ragContext?: string
  ): Promise<GeneratedArticle> {
    const issuesText = qualityReport.issues.join("\n- ");
    const suggestionsText = qualityReport.suggestions.join("\n- ");

    const systemPrompt = `你是BossMate AI超级员工的"内容修改专家"。以下是一篇已生成的文章，质检发现了一些问题。
请在原文基础上进行修改，保留好的部分，修正有问题的部分。不要另起炉灶重写。

原文标题：${originalArticle.title}

质检发现的问题：
- ${issuesText}

改进建议：
- ${suggestionsText}

${ragContext ? `\n知识库参考资料：\n${ragContext}` : ""}

要求：
- 保持原文的整体结构和好的段落
- 只修改有问题的部分
- 修改后的文章要更加完善
- 输出完整的修改后文章

输出 JSON 格式：
{
  "title": "修改后的标题（如无需改可保持原标题）",
  "body": "修改后的完整正文（Markdown格式）",
  "summary": "一句话摘要",
  "tags": ["标签1", "标签2"],
  "wordCount": 实际字数
}`;

    const result = await this.provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `原文正文：\n${originalArticle.body}` },
      ],
      temperature: 0.5,
      maxTokens: 8192,
    });

    let revised: GeneratedArticle;

    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        revised = JSON.parse(jsonMatch[0]);
      } else {
        revised = {
          title: originalArticle.title,
          body: result.content,
          summary: originalArticle.summary,
          tags: originalArticle.tags,
          wordCount: result.content.length,
        };
      }
    } catch {
      revised = {
        title: originalArticle.title,
        body: result.content,
        summary: originalArticle.summary,
        tags: originalArticle.tags,
        wordCount: result.content.length,
      };
    }

    logger.info(
      { title: revised.title, wordCount: revised.wordCount },
      "文章修改完成"
    );

    return revised;
  }

  // ============ 完整流程 ============

  async fullGenerate(
    requirement: ParsedRequirement,
    ragContext?: string,
    previousFeedback?: string
  ): Promise<{
    article: GeneratedArticle;
    quality: QualityReport;
    outline: ArticleOutline;
  }> {
    // 1. 生成大纲
    const outline = await this.generateOutline(requirement, ragContext);

    // 2. 基于大纲生成文章
    const article = await this.generateArticle(requirement, outline, ragContext, previousFeedback);

    // 3. 质检
    const quality = await this.qualityCheck(article, requirement);

    // 4. 质检不通过 → 修改式重试（不重写）
    if (!quality.passed) {
      logger.info({ score: quality.totalScore }, "质检未通过，执行修改式重试");

      const revisedArticle = await this.reviseArticle(article, quality, outline, ragContext);
      const revisedQuality = await this.qualityCheck(revisedArticle, requirement);

      return { article: revisedArticle, quality: revisedQuality, outline };
    }

    return { article, quality, outline };
  }
}
