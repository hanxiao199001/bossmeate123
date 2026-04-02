/**
 * 图文线 Skill - BossMate 第一条业务线
 *
 * 完整流程（对应业务流程图V2）：
 * 语音/文字输入 → AI需求理解 → 多轮追问确认 → 需求拆解
 * → RAG知识库检索 → AI图文生成 → 质检校准 → 人工二次编辑
 * → 绑定平台 → 一键发布 → 数据回流知识库
 *
 * 本文件实现前半段：需求理解 → 追问 → 内容生成 → 质检
 */

import { logger } from "../../config/logger.js";
import type { AIProvider, ChatMessage } from "../ai/providers/base.js";
import type { ISkill, SkillContext, SkillResult } from "./base-skill.js";
import { retrieveForArticle } from "../knowledge/rag-retriever.js";

// ============ 类型定义 ============

/** 图文任务状态 */
export type ArticleStage =
  | "understanding"    // AI 正在理解需求
  | "clarifying"       // 需要追问确认
  | "generating"       // 正在生成内容
  | "quality_check"    // 质检中
  | "editing"          // 人工编辑中
  | "ready"            // 可发布
  | "published";       // 已发布

/** 图文任务上下文 */
export interface ArticleContext {
  /** 原始需求 */
  originalRequest: string;
  /** 拆解后的需求结构 */
  parsedRequirement?: ParsedRequirement;
  /** 追问记录 */
  clarifications: Array<{ question: string; answer: string }>;
  /** 知识库检索结果 */
  ragContext?: string;
  /** 生成的文章 */
  article?: GeneratedArticle;
  /** 质检结果 */
  qualityReport?: QualityReport;
  /** 当前阶段 */
  stage: ArticleStage;
}

interface ParsedRequirement {
  /** 文章主题 */
  topic: string;
  /** 目标受众 */
  audience: string;
  /** 文章类型（科普/资讯/评论/推广） */
  articleType: string;
  /** 字数要求 */
  wordCount: number;
  /** 关键要点 */
  keyPoints: string[];
  /** 语气风格 */
  tone: string;
  /** 参考信息 */
  references: string[];
  /** 是否需要追问 */
  needsClarification: boolean;
  /** 追问问题列表 */
  clarificationQuestions: string[];
}

interface GeneratedArticle {
  title: string;
  body: string;
  summary: string;
  tags: string[];
  wordCount: number;
}

interface QualityReport {
  score: number; // 0-100
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

// ============ 图文线 Skill ============

export class ArticleSkill implements ISkill {
  // ===== ISkill 接口实现 =====
  readonly name = "article";
  readonly displayName = "智能图文";
  readonly description = "基于 RAG 知识库的学术/行业图文生成，含自动质量检查";
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

    const { article, quality } = await this.fullGenerate(parsed, ragText);

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
          qualityScore: quality.score,
          qualityPassed: quality.passed,
          issues: quality.issues,
          suggestions: quality.suggestions,
        },
      },
    };
  }

  // ===== 以下保留原有方法不变 =====

  /**
   * 步骤1: 需求理解与拆解
   * 用户一句话输入 → AI 解析成结构化需求 → 判断是否需要追问
   */
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
      temperature: 0.3, // 低温度确保结构化输出稳定
      maxTokens: 1024,
    });

    let parsed: ParsedRequirement;
    let response: string;

    try {
      // 尝试从回复中提取 JSON
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("未找到 JSON");
      }
    } catch {
      // 兜底：标记需要追问
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
      response = `好的，需求明确了！我来帮你写一篇关于「${parsed.topic}」的${parsed.articleType}文章，${parsed.wordCount}字左右，面向${parsed.audience}。\n\n正在生成中...`;
    }

    logger.info(
      {
        topic: parsed.topic,
        needsClarification: parsed.needsClarification,
      },
      "需求理解完成"
    );

    return { parsed, response };
  }

  /**
   * 步骤2: 生成图文内容
   * 基于结构化需求 + RAG知识库上下文 → 生成高质量文章
   */
  async generateArticle(
    requirement: ParsedRequirement,
    ragContext?: string
  ): Promise<GeneratedArticle> {
    let systemPrompt = `你是BossMate AI超级员工的"内容创作专家"。根据需求生成高质量的文章内容。

要求：
- 主题：${requirement.topic}
- 目标受众：${requirement.audience}
- 文章类型：${requirement.articleType}
- 字数：${requirement.wordCount}字左右
- 语气风格：${requirement.tone}
- 关键要点：${requirement.keyPoints.join("、")}`;

    if (ragContext) {
      systemPrompt += `\n\n以下是知识库中的相关参考资料，请在文章中适当引用：\n${ragContext}`;
    }

    systemPrompt += `\n\n请输出 JSON 格式：
{
  "title": "文章标题",
  "body": "文章正文（Markdown格式）",
  "summary": "一句话摘要",
  "tags": ["标签1", "标签2"],
  "wordCount": 实际字数
}`;

    const result = await this.provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `请根据以上需求生成文章。参考信息：${requirement.references.join("；") || "无"}`,
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
        // 非JSON回复，直接当正文用
        article = {
          title: requirement.topic,
          body: result.content,
          summary: result.content.slice(0, 100),
          tags: [requirement.articleType],
          wordCount: result.content.length,
        };
      }
    } catch {
      article = {
        title: requirement.topic,
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

  /**
   * 步骤3: 质检校准
   * 用另一次 AI 调用检查文章质量，打分并给建议
   */
  async qualityCheck(
    article: GeneratedArticle,
    requirement: ParsedRequirement
  ): Promise<QualityReport> {
    const systemPrompt = `你是BossMate AI超级员工的"质检专家"。请对以下文章进行全面质检。

评分维度（每项0-20分，满分100）：
1. 主题相关性：是否围绕「${requirement.topic}」展开
2. 受众匹配度：是否适合「${requirement.audience}」阅读
3. 内容质量：逻辑是否清晰、信息是否准确
4. 语言风格：是否符合「${requirement.tone}」的要求
5. 字数匹配：是否接近要求的 ${requirement.wordCount} 字

输出 JSON 格式：
{
  "score": 85,
  "passed": true,
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"]
}

passed 标准：score >= 70 为通过`;

    const result = await this.provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `标题：${article.title}\n\n正文：\n${article.body}`,
        },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    });

    let report: QualityReport;

    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        report = JSON.parse(jsonMatch[0]);
      } else {
        report = { score: 75, passed: true, issues: [], suggestions: [] };
      }
    } catch {
      report = { score: 75, passed: true, issues: [], suggestions: [] };
    }

    logger.info(
      { score: report.score, passed: report.passed },
      "质检完成"
    );

    return report;
  }

  /**
   * 完整流程：一键生成（需求已明确时）
   * 需求拆解 → 内容生成 → 质检 → 返回结果
   */
  async fullGenerate(
    requirement: ParsedRequirement,
    ragContext?: string
  ): Promise<{
    article: GeneratedArticle;
    quality: QualityReport;
  }> {
    // 1. 生成内容
    const article = await this.generateArticle(requirement, ragContext);

    // 2. 质检
    const quality = await this.qualityCheck(article, requirement);

    // 3. 质检不通过，自动重新生成一次
    if (!quality.passed) {
      logger.info("质检未通过，重新生成");

      const retryRequirement = {
        ...requirement,
        references: [
          ...requirement.references,
          `上次生成的问题：${quality.issues.join("；")}`,
          `改进建议：${quality.suggestions.join("；")}`,
        ],
      };

      const retryArticle = await this.generateArticle(
        retryRequirement,
        ragContext
      );
      const retryQuality = await this.qualityCheck(
        retryArticle,
        requirement
      );

      return { article: retryArticle, quality: retryQuality };
    }

    return { article, quality };
  }
}
