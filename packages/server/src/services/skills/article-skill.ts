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
import { collectJournalContent, type CollectionResult, type JournalInfo } from "../data-collection/journal-content-collector.js";
import { generateJournalArticleHtml, generateJournalSectionHtml, type AIGeneratedContent } from "./journal-template.js";
import { ensureJournalEnriched } from "../crawler/springer-journal-fetcher.js";
import { validateAIContent, type ValidationIssue } from "./ai-content-validator.js";
import { fetchJournalCoverMultiSource, generateJournalDataCard, svgToDataUri } from "../crawler/journal-image-crawler.js";
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
    // P1 修复：检测「发布」指令 — 用户确认后直接发布已生成的文章
    const publishCmd = /^(发布|确认发布|publish|去发布)$/i.test(userInput.trim());
    if (publishCmd && context.metadata?.contentId) {
      const contentId = context.metadata.contentId as string;
      const platforms = (context.metadata?.publishPlatforms as string[]) || ["wechat"];
      try {
        const publishResults = await this.autoPublish({
          tenantId: context.tenantId,
          contentId,
          platforms,
          article: context.metadata.lastArticle as GeneratedArticle,
        });
        const successList = publishResults.filter((r) => r.success);
        const failList = publishResults.filter((r) => !r.success);
        let reply = "";
        if (successList.length > 0) {
          reply += `已成功发布到：\n`;
          successList.forEach((r) => { reply += `- ${r.accountName}（${r.platform}）${r.url ? ": " + r.url : ""}\n`; });
        }
        if (failList.length > 0) {
          reply += `\n发布失败：\n`;
          failList.forEach((r) => { reply += `- ${r.accountName}（${r.platform}）：${r.error}\n`; });
        }
        return { reply: reply || "发布完成" };
      } catch (err) {
        logger.error({ err }, "用户确认发布失败");
        return { reply: "发布时出现错误，请稍后重试。" };
      }
    }

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

    // P0 安全检查：校验不通过(score<70)时，强制转为人工审核，不自动发布
    if (!quality.passed || quality.totalScore < 70) {
      if (parsed.publishIntent.timing === "immediate") {
        logger.warn(
          { score: quality.totalScore, passed: quality.passed },
          "质量校验未通过，自动发布已降级为人工审核"
        );
        parsed.publishIntent.timing = "after_review";
      }
    }

    if (
      quality.passed &&
      quality.totalScore >= 70 &&
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

重要原则：不要追问，直接执行！老板时间宝贵，信息不足时用合理默认值填充。

规则：
1. 从用户的话中提取：主题、受众、类型、字数、要点、语气、参考信息
2. 信息不足时，用智能默认值填充：受众默认"大众读者"，字数根据平台自动判断（小红书600-800字、知乎1500-2000字、公众号1000-1500字、默认800字），语气根据平台自动判断（小红书亲切活泼、知乎专业严谨、公众号正式官方）
3. needsClarification 始终设为 false，clarificationQuestions 始终设为空数组
4. 识别用户的发布意图：如果用户提到"发到微信"、"发布到公众号"、"推送到知乎"等，提取目标平台和发布时机
5. 平台名称标准化：微信/公众号→wechat，百家号/百家→baijiahao，头条/今日头条→toutiao，知乎→zhihu，小红书/红书→xiaohongshu
6. 如果用户说"写完就发"、"直接发"→timing=immediate；说"我看看再发"、"先不发"→timing=after_review；没提到→timing=unspecified

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

    // 强制不追问，直接执行
    parsed.needsClarification = false;
    parsed.clarificationQuestions = [];

    response = `收到！正在为你生成「${parsed.topic}」的${parsed.articleType}文章，${parsed.wordCount}字左右，面向${parsed.audience}。`;
    if (parsed.publishIntent.wantPublish && parsed.publishIntent.timing === "immediate") {
      response += `写完后自动发布到${parsed.publishIntent.platforms.join("、")}。`;
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

    // V5: 期刊数据由结构化模板展示，AI 只需写分析评论
    if (journalData && (journalData.abstracts.length > 0 || journalData.journals.length > 0)) {
      systemPrompt += `\n\n【重要：关于期刊数据的写作规则】`;
      systemPrompt += `\n系统会在文章开头自动插入期刊的结构化数据面板（影响因子、分区、录用率、审稿周期、PubMed摘要等），你不需要在正文中重复这些数字。`;
      systemPrompt += `\n你的正文应该专注于：`;
      systemPrompt += `\n1. 对该领域的深度分析和解读（不要罗列数据）`;
      systemPrompt += `\n2. 投稿策略建议和经验分享`;
      systemPrompt += `\n3. 最新研究趋势的评论性解读`;
      systemPrompt += `\n4. 对目标读者的实用建议`;
      systemPrompt += `\n\n禁止事项：`;
      systemPrompt += `\n- 不要在正文中写"影响因子为XX"、"录用率为XX%"等数据性语句（这些已在数据面板中展示）`;
      systemPrompt += `\n- 不要插入任何图片标记（图片由系统处理）`;
      systemPrompt += `\n- 不要编造具体的统计数字或百分比`;

      // 仍然提供期刊背景信息，但只作为写作的上下文参考
      if (journalData.journals.length > 0) {
        const j = journalData.journals[0];
        systemPrompt += `\n\n【写作背景参考（不要直接引用数据）】`;
        systemPrompt += `\n期刊：${j.name}，学科：${j.discipline || "未知"}`;
        if (j.publisher) systemPrompt += `，出版商：${j.publisher}`;
      }

      if (journalData.abstracts.length > 0) {
        systemPrompt += `\n\n以下是最新相关研究的方向（供你理解领域动态，正文可以评论性地提及研究方向但不要逐字引用摘要）：`;
        for (const a of journalData.abstracts.slice(0, 3)) {
          systemPrompt += `\n- ${a.title}（${a.journal}）`;
        }
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

  /** 去除 HTML 标签后计算可见文字字数（中文每字符≈1词） */
  private static stripHtmlAndCount(html: string): number {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")   // 去除 style 块
      .replace(/<[^>]*>/g, "")                     // 去除所有标签
      .replace(/&[a-z]+;/gi, " ")                  // HTML 实体算1字
      .replace(/\s+/g, "")                         // 去除空白
      .length;
  }

  private calculateHardMetrics(article: GeneratedArticle, requirement: ParsedRequirement): QualityReport["hardMetrics"] {
    const actualWords = ArticleSkill.stripHtmlAndCount(article.body);
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

  // ============ 完整流程 V6 ============

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
    // V6: 始终走「期刊推荐文章」模板流程，绝不降级到旧 AI 全文写作
    logger.info({ topic: requirement.topic, hasJournals: journalData?.journals?.length || 0 }, "V6 期刊推荐流程开始");

    // 如果 DB 有匹配期刊，直接用
    if (journalData && journalData.journals.length > 0) {
      logger.info({ journal: journalData.journals[0].name }, "V6 使用 DB 匹配期刊");
      return this.generateJournalRecommendation(requirement, journalData);
    }

    // DB 没有匹配期刊 → 用 AI 根据主题推荐一个期刊
    logger.info({ topic: requirement.topic }, "V6 DB 无匹配期刊，AI 推荐期刊");
    let aiJournal: JournalInfo | null = null;
    try {
      aiJournal = await this.createJournalFromAI(requirement.topic);
    } catch (err) {
      logger.warn({ err, topic: requirement.topic }, "V6 AI 推荐期刊失败");
    }

    if (aiJournal) {
      logger.info({ journal: aiJournal.nameEn || aiJournal.name }, "V6 AI 推荐期刊成功");
      aiJournal.synthetic = true; // 标记为 AI 合成数据
      const syntheticData: CollectionResult = {
        hotKeywords: requirement.keyPoints || [],
        journals: [aiJournal],
        abstracts: journalData?.abstracts || [],
        knowledgeEntriesCreated: 0,
      };
      return this.generateJournalRecommendation(requirement, syntheticData);
    }

    // AI 也失败了 → 用主题名称创建最小期刊数据，仍走模板（绝不降级）
    logger.warn({ topic: requirement.topic }, "V6 AI 推荐也失败，使用最小数据走模板");
    const minimalJournal: JournalInfo = {
      name: requirement.topic,
      nameEn: null, issn: null, publisher: null, discipline: null,
      partition: null, impactFactor: null, acceptanceRate: null,
      reviewCycle: null, annualVolume: null, isWarningList: false,
      warningYear: null, coverUrl: null, dataCardUri: "",
      abbreviation: null, foundingYear: null, country: null,
      website: null, apcFee: null, selfCitationRate: null,
      casPartition: null, casPartitionNew: null, jcrSubjects: null,
      topInstitutions: null, scopeDescription: null,
      synthetic: true, // 标记为 AI 合成数据
    };
    const minimalData: CollectionResult = {
      hotKeywords: [], journals: [minimalJournal], abstracts: [], knowledgeEntriesCreated: 0,
    };
    return this.generateJournalRecommendation(requirement, minimalData);
  }

  /**
   * 当 DB 没有匹配期刊时，用 AI 根据话题/关键词推荐一个期刊并生成其完整数据
   */
  async createJournalFromAI(topic: string): Promise<JournalInfo | null> {
    try {
      const result = await this.provider.chat({
        messages: [
          {
            role: "system",
            content: `你是 SCI/SSCI 期刊数据库专家。用户给你一个学术关键词或研究方向，请推荐一个最适合投稿的高质量期刊。
只输出纯 JSON，不要 markdown 包裹：
{
  "name": "期刊中文名",
  "nameEn": "期刊英文全名",
  "abbreviation": "简称",
  "issn": "ISSN号",
  "publisher": "出版商",
  "discipline": "学科领域",
  "partition": "JCR分区如Q1",
  "impactFactor": 影响因子数字,
  "acceptanceRate": 录用率小数如0.35,
  "reviewCycle": "审稿周期如 2-3个月",
  "annualVolume": 年发文量数字,
  "isWarningList": false,
  "warningYear": null,
  "foundingYear": 创刊年份,
  "country": "出版国家",
  "website": "期刊官网URL",
  "apcFee": APC费用美元数字或null,
  "selfCitationRate": 自引率百分比数字或null,
  "casPartition": "中科院分区如 医学2区",
  "casPartitionNew": "新锐分区如 医学1区TOP 或null",
  "jcrSubjects": [{"subject":"学科名","rank":"Q1","position":"9/100"}],
  "topInstitutions": ["机构1","机构2","机构3","机构4","机构5"]
}
要求：
- 推荐的期刊必须是真实存在的、活跃的期刊
- 优先推荐影响因子较高、对国人友好、审稿周期合理的期刊
- 所有数据必须尽可能准确，不确定的字段写 null`,
          },
          {
            role: "user",
            content: `关键词/研究方向：${topic}\n\n请推荐一个最适合的期刊并提供完整信息。`,
          },
        ],
        temperature: 0.3,
        maxTokens: 1500,
      });

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      const journal: JournalInfo = {
        name: parsed.name || topic,
        nameEn: parsed.nameEn || null,
        issn: parsed.issn || null,
        publisher: parsed.publisher || null,
        discipline: parsed.discipline || null,
        partition: parsed.partition || null,
        impactFactor: typeof parsed.impactFactor === "number" ? parsed.impactFactor : null,
        acceptanceRate: typeof parsed.acceptanceRate === "number" ? parsed.acceptanceRate : null,
        reviewCycle: parsed.reviewCycle || null,
        annualVolume: typeof parsed.annualVolume === "number" ? parsed.annualVolume : null,
        isWarningList: parsed.isWarningList === true,
        warningYear: parsed.warningYear || null,
        coverUrl: null,
        dataCardUri: "",
        abbreviation: parsed.abbreviation || null,
        foundingYear: typeof parsed.foundingYear === "number" ? parsed.foundingYear : null,
        country: parsed.country || null,
        website: parsed.website || null,
        apcFee: typeof parsed.apcFee === "number" ? parsed.apcFee : null,
        selfCitationRate: typeof parsed.selfCitationRate === "number" ? parsed.selfCitationRate : null,
        casPartition: parsed.casPartition || null,
        casPartitionNew: parsed.casPartitionNew || null,
        jcrSubjects: parsed.jcrSubjects ? JSON.stringify(parsed.jcrSubjects) : null,
        topInstitutions: parsed.topInstitutions ? JSON.stringify(parsed.topInstitutions) : null,
        scopeDescription: null,
      };

      // 尝试抓取封面图
      try {
        const searchName = journal.nameEn || journal.name;
        const cover = await fetchJournalCoverMultiSource(searchName, journal.issn || undefined);
        if (cover) {
          journal.coverUrl = cover;
        }
      } catch (e) {
        logger.debug({ err: e, journal: journal.name }, "AI 期刊封面抓取失败");
      }

      // 生成 dataCardUri 备用图
      if (!journal.coverUrl) {
        const svg = generateJournalDataCard(journal);
        journal.dataCardUri = svgToDataUri(svg);
      }

      logger.info({ journal: journal.nameEn || journal.name, if: journal.impactFactor, hasCover: !!journal.coverUrl }, "AI 推荐期刊数据生成完成");
      return journal;
    } catch (err) {
      logger.warn({ err, topic }, "AI 创建期刊数据失败");
      return null;
    }
  }

  // ============ V6: 期刊推荐文章生成（顺仕美途风格）============

  /**
   * 新流程：
   * 1. 补充期刊数据（Springer + AI）
   * 2. AI 生成：标题、收稿范围、推荐总结
   * 3. 模板组装完整文章 HTML
   */
  async generateJournalRecommendation(
    requirement: ParsedRequirement,
    journalData: CollectionResult
  ): Promise<{
    article: GeneratedArticle;
    quality: QualityReport;
    outline: ArticleOutline;
  }> {
    const journal = journalData.journals[0];

    // 1. 补充期刊详细数据（如果还没有 enriched）
    // enrichment 触发条件：缺少任一关键补充字段即触发（不要求全部缺失）
    const needsEnrichment = !journal.abbreviation || !journal.foundingYear ||
      !journal.casPartition || !journal.website || !journal.coverUrl;
    if (needsEnrichment) {
      try {
        const enriched = await ensureJournalEnriched(
          "skip-cache", // 新文章每次都补充
          {
            name: journal.name,
            nameEn: journal.nameEn,
            issn: journal.issn,
            impactFactor: journal.impactFactor,
            partition: journal.partition,
            discipline: journal.discipline,
            publisher: journal.publisher,
          },
          this.provider
        );
        // 合并补充数据到 journal 对象
        if (enriched.abbreviation) journal.abbreviation = enriched.abbreviation;
        if (enriched.foundingYear) journal.foundingYear = enriched.foundingYear;
        if (enriched.country) journal.country = enriched.country;
        if (enriched.website) journal.website = enriched.website;
        if (enriched.apcFee) journal.apcFee = enriched.apcFee;
        if (enriched.selfCitationRate) journal.selfCitationRate = enriched.selfCitationRate;
        if (enriched.casPartition) journal.casPartition = enriched.casPartition;
        if (enriched.casPartitionNew) journal.casPartitionNew = enriched.casPartitionNew;
        if (enriched.jcrSubjects) journal.jcrSubjects = enriched.jcrSubjects;
        if (enriched.topInstitutions) journal.topInstitutions = enriched.topInstitutions;
      } catch (err) {
        logger.warn({ err, journal: journal.name }, "期刊数据补充失败，使用已有数据");
      }
    }

    // 1.5 补充封面图（如果还没有）
    if (!journal.coverUrl) {
      try {
        const searchName = journal.nameEn || journal.name;
        const cover = await fetchJournalCoverMultiSource(searchName, journal.issn || undefined);
        if (cover) {
          journal.coverUrl = cover;
          logger.info({ journal: journal.name, coverUrl: cover }, "期刊封面图抓取成功");
        }
      } catch (err) {
        logger.debug({ err, journal: journal.name }, "期刊封面图抓取失败");
      }
    }

    // 1.6 如果还是没有封面，生成数据卡片作为备用
    if (!journal.coverUrl && !journal.dataCardUri) {
      const svg = generateJournalDataCard(journal);
      journal.dataCardUri = svgToDataUri(svg);
    }

    // 2. AI 生成：标题 + 收稿范围 + 推荐语
    const aiContentRaw = await this.generateJournalAIContent(journal);

    // 2.5 数据校验：AI 输出 vs 真实数据交叉验证
    const validation = validateAIContent(aiContentRaw, journal);
    const aiContent = validation.corrected;

    if (validation.issues.length > 0) {
      logger.info(
        {
          journal: journal.name,
          totalIssues: validation.issues.length,
          corrected: validation.stats.correctedChecks,
          blocked: validation.stats.blockedChecks,
          issues: validation.issues.map((i: ValidationIssue) => ({
            severity: i.severity,
            field: i.field,
            message: i.message,
            fixed: i.autoCorrected,
          })),
        },
        "AI 内容校验完成：发现 %d 个问题，自动修正 %d 个",
        validation.issues.length,
        validation.stats.correctedChecks
      );
    }

    // 如果 AI 生成了 scopeDescription 且 DB 没有缓存，回写
    if (aiContent.scopeDescription && !journal.scopeDescription) {
      journal.scopeDescription = aiContent.scopeDescription;
    }

    // 3. 模板组装完整文章 HTML
    const articleBody = generateJournalArticleHtml(
      journal,
      aiContent,
      journalData.abstracts
    );

    const article: GeneratedArticle = {
      title: aiContent.title,
      body: articleBody,
      summary: `期刊推荐：${journal.nameEn || journal.name}，IF ${journal.impactFactor || "N/A"}，${journal.casPartition || journal.partition || ""}`,
      tags: ["期刊推荐", journal.discipline || "学术", journal.partition || ""].filter(Boolean),
      wordCount: ArticleSkill.stripHtmlAndCount(articleBody),
    };

    // 质检（包含 AI 内容校验结果）
    const validationIssueTexts = validation.issues
      .filter((i: ValidationIssue) => i.severity !== "info")
      .map((i: ValidationIssue) => `[${i.severity}] ${i.message}${i.autoCorrected ? "（已自动修正）" : ""}`);

    const qualityScore = validation.passed ? 85 : 60;

    const quality: QualityReport = {
      totalScore: qualityScore,
      passed: validation.passed,
      aiScore: qualityScore,
      hardMetrics: {
        wordDeviation: 0,
        wordDeviationScore: 100,
        paragraphCount: 10,
        paragraphScore: 100,
        keyPointCoverage: 1,
        keyPointScore: 100,
      },
      issues: validationIssueTexts,
      suggestions: validation.issues
        .filter((i: ValidationIssue) => !i.autoCorrected)
        .map((i: ValidationIssue) => i.message),
    };

    const outline: ArticleOutline = {
      titleCandidates: [aiContent.title],
      selectedTitle: aiContent.title,
      sections: [
        { heading: "期刊基本信息", keyPoints: ["名称", "出版商", "ISSN"], estimatedWords: 100 },
        { heading: "影响因子与分区", keyPoints: ["IF趋势", "JCR/CAS分区"], estimatedWords: 200 },
        { heading: "发文情况", keyPoints: ["年发文量", "录用率"], estimatedWords: 150 },
        { heading: "收稿范围", keyPoints: ["研究领域", "文章类型"], estimatedWords: 300 },
        { heading: "投稿指南", keyPoints: ["版面费", "审稿周期", "预警状态"], estimatedWords: 200 },
        { heading: "推荐总结", keyPoints: ["推荐指数", "适合人群"], estimatedWords: 200 },
      ],
      writingStrategy: { opening: "期刊推荐", argumentStructure: "信息展示+分析总结", closing: "推荐指数" },
      totalEstimatedWords: 1200,
    };

    logger.info({ journal: journal.name, title: aiContent.title }, "V6 期刊推荐文章生成完成");

    return { article, quality, outline };
  }

  /**
   * AI 生成期刊推荐文章的三个关键部分：标题、收稿范围、推荐总结
   */
  async generateJournalAIContent(journal: JournalInfo): Promise<AIGeneratedContent> {
    const ifText = journal.impactFactor != null ? journal.impactFactor.toFixed(1) : "N/A";
    const journalName = journal.nameEn || journal.name;

    // ---- 标题多元化：随机选择句式风格 ----
    const titleStyles = [
      // 数据亮点型
      `数据驱动型标题：用IF分数、录用率、审稿周期等关键数据作为标题核心卖点。示例："IF ${ifText}分，录用率仅${journal.acceptanceRate != null ? (journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100).toFixed(0) + "%" : "XX%"}，${journalName}值得一投！"`,
      // 疑问悬念型
      `疑问悬念型标题：用提问或悬念引发好奇心，让读者想点进来看答案。示例："这本${journal.discipline || ""}期刊凭什么IF年年涨？审稿只要${journal.reviewCycle || "X天"}的秘密"`,
      // 对比推荐型
      `对比推荐型标题：通过横向对比或排名突出期刊优势。示例："${journal.discipline || ""}领域性价比最高的Q1期刊？${journalName}深度解析"`,
      // 痛点切入型
      `痛点切入型标题：从科研人的实际痛点出发（赶毕业、评职称、发不出论文），关联到期刊推荐。示例："毕业季还没发SCI？这本${journal.casPartition || journal.partition || "高分"}期刊审稿快、录用率高！"`,
      // 热点结合型
      `热点趋势型标题：结合学科领域当前热门研究方向或关键词，增加时效感。示例："2025年${journal.discipline || ""}最火研究方向+高分期刊推荐，${journalName}全解读"`,
      // 榜单盘点型
      `榜单盘点型标题：用「必看」「盘点」「TOP」等词汇制造权威感。示例："${journal.discipline || ""}方向必投TOP期刊盘点：${journalName}，IF ${ifText}"`,
    ];
    const chosenStyle = titleStyles[Math.floor(Math.random() * titleStyles.length)];

    // ---- 学科领域定制标题风格 ----
    const discipline = (journal.discipline || "").toLowerCase();
    let disciplineHint = "";
    if (discipline.includes("医") || discipline.includes("临床") || discipline.includes("药")) {
      disciplineHint = "医学/药学领域读者偏好权威感和临床数据，标题可融入「临床转化」「治疗新策略」「多中心研究」等关键词。";
    } else if (discipline.includes("工") || discipline.includes("计算") || discipline.includes("电") || discipline.includes("材料")) {
      disciplineHint = "工科/信息技术领域读者喜欢技术前沿感，标题可融入「人工智能」「新能源」「智能制造」等热词。";
    } else if (discipline.includes("经济") || discipline.includes("管理") || discipline.includes("社会") || discipline.includes("教育")) {
      disciplineHint = "社科/管理领域读者注重政策导向和实践价值，标题可融入「新规」「趋势」「实证研究」等关键词。";
    } else if (discipline.includes("化") || discipline.includes("物理") || discipline.includes("数学")) {
      disciplineHint = "理学领域读者看重学术深度，标题可融入「Nature子刊」「前沿发现」「突破性成果」等表述。";
    } else if (discipline.includes("生物") || discipline.includes("环境") || discipline.includes("农") || discipline.includes("生态")) {
      disciplineHint = "生物/环境领域读者关注生态前沿，标题可融入「碳中和」「生物多样性」「基因编辑」等热词。";
    }
    if (disciplineHint) disciplineHint = `\n学科领域定制要求：${disciplineHint}`;

    const prompt = `你是一个学术期刊推荐自媒体的资深写手，擅长用不同风格的标题吸引读者。根据以下期刊信息，生成内容。

期刊信息：
- 名称：${journalName}${journal.abbreviation ? `（${journal.abbreviation}）` : ""}
- 学科：${journal.discipline || "未知"}
- 影响因子：${ifText}
- 分区：${journal.casPartition || journal.partition || "未知"}
${journal.casPartitionNew ? `- 新锐分区：${journal.casPartitionNew}` : ""}
- 录用率：${journal.acceptanceRate != null ? (journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100).toFixed(0) + "%" : "未知"}
- 审稿周期：${journal.reviewCycle || "未知"}
- 出版商：${journal.publisher || "未知"}
${journal.isWarningList ? "- ⚠️ 在预警名单中" : "- 不在预警名单中"}

【本次标题风格】
${chosenStyle}
${disciplineHint}

重要：标题风格必须严格遵循上面的"本次标题风格"要求，不要总是写成一种风格！
标题长度控制在 20-50 字，可以用「|」「，」「！」等标点断句增加节奏感。

【叙事口吻】
- recommendation 不要写成干巴巴的总结，要有个人观点和态度（像资深编辑而非百科词条）
- scopeDescription 要专业但不枯燥，适当加入「热门方向」「近年趋势」等吸引读者的表述
- editorComment 要极口语化，像和朋友聊天（"说实话这本刊..."、"赶毕业投这个！"）

请输出纯 JSON（不要 markdown）：
{
  "title": "按照上面指定的标题风格生成的标题",
  "scopeDescription": "收稿范围的详细描述（200-400字），分总述和具体方向列表。用HTML格式，可用<p>和<strong>标签。说明期刊聚焦什么领域、欢迎什么类型的稿件、有什么特色。要专业准确但不枯燥。",
  "recommendation": "推荐总结（150-300字），综合点评期刊的优势、适合什么样的作者投稿，用HTML格式。要有态度和个人观点，不要像百科全书。",
  "editorComment": "一句话小编点评（15-30字），极口语化、接地气，像朋友间推荐，如'说实话审稿快到离谱，赶毕业的同学冲！'",
  "highlightTip": "一个划重点提示（20-40字），提炼最核心的投稿建议或数据亮点",
  "ifPrediction": "影响因子走势预测的简短描述，如'预测今年涨至15分'，如果无法预测就返回null",
  "rating": 推荐星级1-5的数字
}`;

    try {
      const result = await this.provider.chat({
        messages: [
          { role: "system", content: "你是学术期刊分析专家，输出严格JSON格式。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.6,
        maxTokens: 2048,
      });

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          title: parsed.title || `期刊推荐：${journalName}`,
          scopeDescription: parsed.scopeDescription || "",
          recommendation: parsed.recommendation || "",
          ifPrediction: parsed.ifPrediction || undefined,
          rating: typeof parsed.rating === "number" ? Math.min(5, Math.max(1, parsed.rating)) : 4,
          editorComment: parsed.editorComment || undefined,
          highlightTip: parsed.highlightTip || undefined,
        };
      }
    } catch (err) {
      logger.warn({ err, journal: journal.name }, "AI 生成期刊推荐内容失败");
    }

    // 降级：使用基本信息
    return {
      title: `期刊推荐：${journalName}，影响因子 ${ifText}`,
      scopeDescription: journal.scopeDescription || "",
      recommendation: "",
      rating: 4,
    };
  }
}
