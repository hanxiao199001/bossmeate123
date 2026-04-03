/**
 * 图文线 Skill - BossMate 第一条业务线（V4 期刊数据驱动）
 *
 * 完整流程：
 * 需求理解 → 期刊数据采集 → RAG检索 → 大纲生成 → 基于大纲生成(含期刊图片) → 质检 → 修改式重试 → 发布
 *
 * V4 新增：
 * 1. 生成前自动采集相关期刊数据（PubMed摘要+期刊卡片）
 * 2. 文章中插入期刊封面图和数据信息卡片
 * 3. AI 基于真实论文摘要创作，而非凭空编造
 */

import { logger } from "../../config/logger.js";
import type { AIProvider, ChatMessage } from "../ai/providers/base.js";
import type { ISkill, SkillContext, SkillResult } from "./base-skill.js";
import { retrieveForArticle } from "../knowledge/rag-retriever.js";
import { modelRouter } from "../ai/model-router.js";
import { publishToAccounts, type PublishResult } from "../publisher/index.js";
import { collectJournalContent, type CollectionResult } from "../data-collection/journal-content-collector.js";
import { db } from "../../models/db.js";
import { platformAccounts } from "../../models/schema.js";
import { eq, and, inArray } from "drizzle-orm";

// ============ 类型定义 ============

export type ArticleStage =
  | "understanding"
  | "clarifying"
  | "outlining"
  | "generating"
  | "quality_check"
  | "revising"
  | "publishing"       // V3 新增
  | "editing"
  | "ready"
  | "published";

export interface ArticleContext {
  originalRequest: string;
  parsedRequirement?: ParsedRequirement;
  clarifications: Array<{ question: string; answer: string }>;
  outline?: ArticleOutline;
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

  /** V3 新增：发布意图 */
  publishIntent: {
    wantPublish: boolean;
    platforms: string[];
    timing: "immediate" | "after_review" | "unspecified";
  };
}

interface ArticleOutline {
  titleCandidates: string[];
  selectedTitle: string;
  sections: OutlineSection[];
  writingStrategy: {
    opening: string;
    argumentStructure: string;
    closing: string;
  };
  totalEstimatedWords: number;
}

interface OutlineSection {
  heading: string;
  keyPoints: string[];
  estimatedWords: number;
}

interface GeneratedArticle {
  title: string;
  body: string;
  summary: string;
  tags: string[];
  wordCount: number;
}

interface QualityReport {
  aiScore: number;
  hardMetrics: {
    wordDeviation: number;
    wordDeviationScore: number;
    paragraphCount: number;
    paragraphScore: number;
    keyPointCoverage: number;
    keyPointScore: number;
  };
  totalScore: number;
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

// ============ 图文线 Skill ============

export class ArticleSkill implements ISkill {
  readonly name = "article";
  readonly displayName = "智能图文";
  readonly description = "基于 RAG 知识库的学术/行业图文生成，含大纲规划、质检和一键发布";
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

    // V4: 先采集期刊数据到知识库（确保 RAG 有真实内容可查）
    let collectionResult: CollectionResult | undefined;
    try {
      collectionResult = await collectJournalContent({
        tenantId: context.tenantId,
        topic: parsed.topic,
        keywords: parsed.keyPoints,
      });
      logger.info({
        journals: collectionResult.journals.length,
        abstracts: collectionResult.abstracts.length,
        knowledgeEntries: collectionResult.knowledgeEntriesCreated,
      }, "期刊数据采集完成");
    } catch (err) {
      logger.warn({ err }, "期刊数据采集失败，继续使用已有知识库");
    }

    // RAG 检索（此时知识库已有最新期刊数据）
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

    const previousFeedback = (context.metadata?.previousFeedback as string) || "";

    // 生成流程（传入期刊数据用于图片插入）
    const { article, quality } = await this.fullGenerate(parsed, ragText, previousFeedback, collectionResult);

    // V3: 生成后自动发布
    let publishResults: PublishResult[] | undefined;
    let reply = response;

    if (
      quality.passed &&
      parsed.publishIntent.wantPublish &&
      parsed.publishIntent.timing !== "after_review"
    ) {
      const contentId = context.metadata?.contentId as string;
      if (contentId) {
        try {
          publishResults = await this.autoPublish({
            tenantId: context.tenantId,
            contentId,
            platforms: parsed.publishIntent.platforms,
            article,
          });
        } catch (err) {
          logger.error({ err }, "自动发布失败");
        }
      }
    }

    // V3: 构造带发布结果的回复
    if (publishResults && publishResults.length > 0) {
      const successList = publishResults.filter((r) => r.success);
      const failList = publishResults.filter((r) => !r.success);

      if (successList.length > 0) {
        reply += `\n\n已成功发布到：\n`;
        successList.forEach((r) => {
          reply += `- ${r.accountName}（${r.platform}）${r.url ? ": " + r.url : ""}\n`;
        });
      }
      if (failList.length > 0) {
        reply += `\n以下平台发布失败：\n`;
        failList.forEach((r) => {
          reply += `- ${r.accountName}: ${r.error}\n`;
        });
      }
    } else if (parsed.publishIntent.wantPublish && parsed.publishIntent.timing === "after_review") {
      reply += `\n\n文章已生成，等你确认后说"发布"即可一键推送到${parsed.publishIntent.platforms.join("、")}。`;
    }

    return {
      reply,
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
          publishIntent: parsed.publishIntent,
          publishResults: publishResults?.map((r) => ({
            platform: r.platform,
            accountName: r.accountName,
            success: r.success,
            url: r.url,
            error: r.error,
          })),
        },
      },
    };
  }

  // ============ 步骤 1: 需求理解（V3: 含发布意图）============

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
5. 识别用户的发布意图：如果用户提到"发到微信"、"发布到公众号"、"推送到知乎"等，提取目标平台和发布时机
6. 平台名称标准化：微信/公众号→wechat，百家号/百家→baijiahao，头条/今日头条→toutiao，知乎→zhihu，小红书/红书→xiaohongshu
7. 如果用户说"写完就发"、"直接发"→timing=immediate；说"我看看再发"、"先不发"→timing=after_review；没提到→timing=unspecified

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
  "clarificationQuestions": ["问题1", "问题2"],
  "publishIntent": {
    "wantPublish": false,
    "platforms": [],
    "timing": "unspecified"
  }
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
        const raw = JSON.parse(jsonMatch[0]);
        parsed = {
          ...raw,
          publishIntent: raw.publishIntent || { wantPublish: false, platforms: [], timing: "unspecified" },
        };
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
        publishIntent: { wantPublish: false, platforms: [], timing: "unspecified" },
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
      if (parsed.publishIntent.wantPublish && parsed.publishIntent.timing === "immediate") {
        response += `\n写完后会自动发布到${parsed.publishIntent.platforms.join("、")}。`;
      }
    }

    logger.info(
      {
        topic: parsed.topic,
        needsClarification: parsed.needsClarification,
        publishIntent: parsed.publishIntent,
      },
      "需求理解完成"
    );

    return { parsed, response };
  }

  // ============ 步骤 2: 大纲生成 ============

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
    "opening": "开头切入方式",
    "argumentStructure": "论证结构",
    "closing": "结尾收束方式"
  }
}

要求：
- 3-6个章节，每个章节有2-4个具体要点
- 各章节字数之和应接近目标字数 ${requirement.wordCount}
- 标题要有吸引力，25字以内`;

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
      { title: outline.selectedTitle, sectionCount: outline.sections.length },
      "大纲生成完成"
    );

    return outline;
  }

  // ============ 步骤 3: 基于大纲生成文章 ============

  async generateArticle(
    requirement: ParsedRequirement,
    outline: ArticleOutline,
    ragContext?: string,
    previousFeedback?: string,
    journalData?: CollectionResult
  ): Promise<GeneratedArticle> {
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

    // V4: 注入真实期刊数据
    if (journalData && (journalData.abstracts.length > 0 || journalData.journals.length > 0)) {
      systemPrompt += `\n\n【真实期刊研究数据 — 必须引用】`;

      if (journalData.abstracts.length > 0) {
        systemPrompt += `\n以下是 PubMed 最新研究摘要，请在文章中引用这些真实研究：`;
        for (const a of journalData.abstracts.slice(0, 3)) {
          systemPrompt += `\n- [${a.journal}] ${a.title}\n  摘要：${a.abstractText.slice(0, 300)}`;
        }
      }

      if (journalData.journals.length > 0) {
        systemPrompt += `\n\n以下期刊有数据信息卡片，请在文章适当位置插入（使用 Markdown 图片语法）：`;
        for (const j of journalData.journals) {
          systemPrompt += `\n- ${j.name}（IF: ${j.impactFactor || "N/A"}, ${j.partition || "N/A"}区）`;
          systemPrompt += `\n  数据卡片：![${j.name}数据卡片](${j.dataCardUri})`;
          if (j.coverUrl) {
            systemPrompt += `\n  封面图：![${j.name}](${j.coverUrl})`;
          }
        }
        systemPrompt += `\n\n规则：在文章中提到某个期刊时，紧跟其后插入该期刊的数据卡片图片。`;
      }
    }

    if (previousFeedback) {
      systemPrompt += `\n\n用户历史偏好反馈：${previousFeedback}，请在生成时参考这些偏好。`;
    }

    systemPrompt += `\n\n请输出 JSON 格式：
{
  "title": "文章标题",
  "body": "文章正文（Markdown格式，可包含图片标记）",
  "summary": "一句话摘要",
  "tags": ["标签1", "标签2"],
  "wordCount": 实际字数
}`;

    const result = await this.provider.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `请按照大纲生成完整文章。参考信息：${requirement.references.join("；") || "无"}` },
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
        article = { title: outline.selectedTitle, body: result.content, summary: result.content.slice(0, 100), tags: [requirement.articleType], wordCount: result.content.length };
      }
    } catch {
      article = { title: outline.selectedTitle, body: result.content, summary: result.content.slice(0, 100), tags: [requirement.articleType], wordCount: result.content.length };
    }

    logger.info({ title: article.title, wordCount: article.wordCount }, "图文生成完成");
    return article;
  }

  // ============ 步骤 4: 质检（AI + 硬指标）============

  async qualityCheck(
    article: GeneratedArticle,
    requirement: ParsedRequirement
  ): Promise<QualityReport> {
    const hardMetrics = this.calculateHardMetrics(article, requirement);

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
      let result;
      if (checkProvider && checkProvider.name !== "anthropic") {
        const response = await fetch(`${checkProvider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${checkProvider.apiKey}` },
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

    const hardScore = (hardMetrics.wordDeviationScore + hardMetrics.paragraphScore + hardMetrics.keyPointScore) / 3;
    const totalScore = Math.round(aiScore * 0.5 + hardScore * 0.5);

    if (hardMetrics.wordDeviationScore < 70) {
      issues.push(`字数偏差 ${Math.round(hardMetrics.wordDeviation * 100)}%（要求 ${requirement.wordCount} 字，实际 ${article.wordCount} 字）`);
    }
    if (hardMetrics.paragraphScore < 70) {
      issues.push(`段落数量不合理（${hardMetrics.paragraphCount} 段）`);
    }
    if (hardMetrics.keyPointScore < 70) {
      issues.push(`关键要点覆盖率仅 ${Math.round(hardMetrics.keyPointCoverage * 100)}%`);
    }

    const report: QualityReport = { aiScore, hardMetrics, totalScore, passed: totalScore >= 70, issues, suggestions };
    logger.info({ aiScore, hardScore: Math.round(hardScore), totalScore, passed: report.passed }, "质检完成");
    return report;
  }

  private calculateHardMetrics(article: GeneratedArticle, requirement: ParsedRequirement): QualityReport["hardMetrics"] {
    const actualWords = article.body.length;
    const targetWords = requirement.wordCount;
    const wordDeviation = Math.abs(actualWords - targetWords) / targetWords;
    const wordDeviationScore = wordDeviation <= 0.1 ? 100 : wordDeviation <= 0.2 ? 85 : wordDeviation <= 0.3 ? 70 : wordDeviation <= 0.5 ? 50 : 30;

    const paragraphs = article.body.split(/\n\n+/).filter((p) => p.trim().length > 10);
    const paragraphCount = paragraphs.length;
    const paragraphScore = (paragraphCount >= 3 && paragraphCount <= 20) ? 100 : (paragraphCount >= 2 && paragraphCount <= 25) ? 70 : 40;

    const keyPoints = requirement.keyPoints;
    if (keyPoints.length === 0) {
      return { wordDeviation, wordDeviationScore, paragraphCount, paragraphScore, keyPointCoverage: 1, keyPointScore: 100 };
    }

    const bodyLower = article.body.toLowerCase();
    const covered = keyPoints.filter((kp) => bodyLower.includes(kp.toLowerCase()));
    const keyPointCoverage = covered.length / keyPoints.length;
    const keyPointScore = keyPointCoverage >= 0.8 ? 100 : keyPointCoverage >= 0.6 ? 80 : keyPointCoverage >= 0.4 ? 60 : 40;

    return { wordDeviation, wordDeviationScore, paragraphCount, paragraphScore, keyPointCoverage, keyPointScore };
  }

  // ============ 步骤 5: 修改式重试 ============

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

输出 JSON 格式：
{
  "title": "修改后的标题",
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
        revised = { title: originalArticle.title, body: result.content, summary: originalArticle.summary, tags: originalArticle.tags, wordCount: result.content.length };
      }
    } catch {
      revised = { title: originalArticle.title, body: result.content, summary: originalArticle.summary, tags: originalArticle.tags, wordCount: result.content.length };
    }

    logger.info({ title: revised.title, wordCount: revised.wordCount }, "文章修改完成");
    return revised;
  }

  // ============ V3: 自动发布 ============

  private async autoPublish(params: {
    tenantId: string;
    contentId: string;
    platforms: string[];
    article: GeneratedArticle;
  }): Promise<PublishResult[]> {
    const { tenantId, contentId, platforms } = params;

    const accounts = await db
      .select()
      .from(platformAccounts)
      .where(
        and(
          eq(platformAccounts.tenantId, tenantId),
          eq(platformAccounts.status, "active"),
          eq(platformAccounts.isVerified, true),
          inArray(platformAccounts.platform, platforms)
        )
      );

    if (accounts.length === 0) {
      logger.warn({ tenantId, platforms }, "自动发布：未找到已验证的活跃账号");
      return [
        {
          accountId: "",
          accountName: "",
          platform: platforms.join(","),
          success: false,
          error: `未找到${platforms.join("、")}平台的已验证账号，请先在"账号管理"中绑定`,
        },
      ];
    }

    return publishToAccounts({
      contentId,
      tenantId,
      accountIds: accounts.map((a) => a.id),
    });
  }

  // ============ 完整流程 ============

  async fullGenerate(
    requirement: ParsedRequirement,
    ragContext?: string,
    previousFeedback?: string,
    journalData?: CollectionResult
  ): Promise<{
    article: GeneratedArticle;
    quality: QualityReport;
    outline: ArticleOutline;
  }> {
    const outline = await this.generateOutline(requirement, ragContext);
    const article = await this.generateArticle(requirement, outline, ragContext, previousFeedback, journalData);
    const quality = await this.qualityCheck(article, requirement);

    if (!quality.passed) {
      logger.info({ score: quality.totalScore }, "质检未通过，执行修改式重试");
      const revisedArticle = await this.reviseArticle(article, quality, outline, ragContext);
      const revisedQuality = await this.qualityCheck(revisedArticle, requirement);
      return { article: revisedArticle, quality: revisedQuality, outline };
    }

    return { article, quality, outline };
  }
}
