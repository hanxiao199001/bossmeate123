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
import { getTemplate, getDefaultTemplateId } from "./template-registry.js";
import { selectVariantTemplates } from "./template-preference.js";
import { ensureJournalEnriched } from "../crawler/springer-journal-fetcher.js";
import { buildTemplateAwarePromptSuffix } from "./template-prompt-injector.js";
import { validateAIContent, type ValidationIssue, extractClaimedFacts, verifyClaimsAgainstDb } from "./ai-content-validator.js";
import { fetchJournalCoverMultiSource, generateJournalDataCard, svgToDataUri } from "../crawler/journal-image-crawler.js";
import { persistJournalCover } from "../crawler/journal-cover-persist.js";
import { db } from "../../models/db.js";
import { platformAccounts, tenants, journals } from "../../models/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

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
    // PR #121 P5 fix：caller 已 P3/cron 预选 journalId（如 batch-worker），直接 SELECT 跳 collector V6
    // → 强制 P5 行业月度走 multi_source 池，避免 AI 编造期刊触发 ⚠️ 警告横幅
    const explicitJournalId = context.metadata?.journalId as string | undefined;
    if (explicitJournalId) {
      const [j] = await db.select().from(journals).where(eq(journals.id, explicitJournalId)).limit(1);
      if (j) {
        collectionResult = { journals: [j as unknown as JournalInfo], abstracts: [], hotKeywords: parsed.keyPoints, knowledgeEntriesCreated: 0 };
        logger.info({ journalId: explicitJournalId, name: j.name }, "PR #121: 用 caller 预选 journalId 跳 collector V6");
      }
    }
    if (!collectionResult) try {
      collectionResult = await collectJournalContent({
        tenantId: context.tenantId,
        topic: parsed.topic,
        keywords: parsed.keyPoints,
        // PR B.13：原始用户输入也透传（防 LLM understandRequirement 把"The Lancet" /
        // "新英格兰医学杂志" 等精确刊名 normalize 成"医学顶刊"等模糊词后丢失字面）
        rawUserPrompt: userInput,
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

    // T4-1b: 从 metadata 读 variants 参数（默认 1，向后兼容）
    const variants = (context.metadata?.variants as number | undefined) ?? 1;
    // T4-3-1: 从 metadata 读 templateId（默认 getDefaultTemplateId()='shunshi-style' as of task #11）
    // PR #123 P6（5-15）：metadata 缺时优先读 tenant_preferences.default_template，仍缺才走 default
    let explicitTemplateId = context.metadata?.templateId as string | undefined;
    if (!explicitTemplateId) {
      try {
        const { getPreference, setPreference } = await import("../preferences.js");
        const pref = await getPreference(context.tenantId, "default_template", null);
        if (pref) explicitTemplateId = pref;
        // 用户显式选 → 写回 preference（下次默认）。仅当 metadata 显式给且与 pref 不同时写。
        const mdId = context.metadata?.templateId as string | undefined;
        if (mdId && mdId !== pref) {
          await setPreference(context.tenantId, "default_template", mdId).catch(() => {});
        }
      } catch (err) {
        logger.warn({ err }, "P6 preference 读失败，走 default");
      }
    }
    explicitTemplateId = explicitTemplateId ?? getDefaultTemplateId();

    // T4-3-4: variants > 1 时，副版本按租户偏好分配不同模板；variants=1 行为不变
    const templateIds: string[] =
      variants > 1
        ? await selectVariantTemplates(context.tenantId, variants, {
            defaultId: explicitTemplateId,
          })
        : [explicitTemplateId];

    // 生成流程（传入期刊数据用于图片插入）
    const { article, quality, extraVariants, bodyHasWarnings, bodyFactIssues } = await this.fullGenerate(
      parsed,
      ragText,
      previousFeedback,
      collectionResult,
      variants,
      templateIds,
      context.tenantId, // task #35: 透传给 generateJournalRecommendation 拉 contact_meta
    );
    const totalVariants = (extraVariants?.length ?? 0) + 1;

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
          // T4-1b: 多版本标识（主版本 = 0）
          variantIndex: 0,
          totalVariants,
          // T4-3-4: 主版本所用模板（content-worker 写 contents.metadata 时透传）
          templateId: templateIds[0],
          // PR B.10：journalId 透传给 routes/chat.ts:236 的 auto-video-bridge 触发条件
          // （此前 metadata 缺该字段 → typeof journalId === "string" 永远 false → bridge 死代码）
          journalId: collectionResult?.journals[0]?.id,
          // 5-23 PR #162 Phase 4-lite: body fact check 结果, feed-service 据 hasWarnings filter
          hasWarnings: !!bodyHasWarnings,
          validatorIssues: bodyFactIssues && bodyFactIssues.length > 0 ? bodyFactIssues : undefined,
        },
      },
      // T4-1b: 副版本数组（variants=1 时为 undefined，向后兼容）
      extraArtifacts: extraVariants?.map((v, i) => ({
        type: "article",
        title: v.article.title,
        body: v.article.body,
        summary: v.article.summary,
        tags: v.article.tags,
        metadata: {
          wordCount: v.article.wordCount,
          qualityScore: v.quality.totalScore,
          qualityPassed: v.quality.passed,
          aiScore: v.quality.aiScore,
          hardMetrics: v.quality.hardMetrics,
          issues: v.quality.issues,
          suggestions: v.quality.suggestions,
          variantIndex: i + 1,
          totalVariants,
          // T4-3-4: 此副版本所用模板
          templateId: templateIds[i + 1] ?? templateIds[0],
          // variantOf 由 content-worker 写 contents 行时填入主版本 contentId
        },
      })),
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

  /** 去除 HTML 标签后计算可见文字字数（中文每字符≈1词） */
  private static stripHtmlAndCount(html: string): number {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, "")   // 去除 style 块
      .replace(/<[^>]*>/g, "")                     // 去除所有标签
      .replace(/&[a-z]+;/gi, " ")                  // HTML 实体算1字
      .replace(/\s+/g, "")                         // 去除空白
      .length;
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
    journalData?: CollectionResult,
    variants: number = 1,
    templateIds: string[] = [getDefaultTemplateId()],
    tenantId?: string,
  ): Promise<{
    article: GeneratedArticle;
    quality: QualityReport;
    outline: ArticleOutline;
    // 5-23 PR #162 透传 body-level fact check (主版本 only)
    bodyHasWarnings?: boolean;
    bodyFactIssues?: ValidationIssue[];
    extraVariants?: Array<{
      article: GeneratedArticle;
      quality: QualityReport;
      outline: ArticleOutline;
    }>;
  }> {
    // T4-1b: variants 参数控制版本数（1-3，clamp）
    const requestedVariants = Math.min(Math.max(variants, 1), 3);

    // V6: 始终走「期刊推荐文章」模板流程，绝不降级到旧 AI 全文写作
    logger.info(
      { topic: requirement.topic, hasJournals: journalData?.journals?.length || 0, variants: requestedVariants },
      "V6 期刊推荐流程开始"
    );

    // 1. 解析最终用的 journalData（DB / AI 推荐 / 最小数据 三选一）
    let finalJournalData: CollectionResult;
    if (journalData && journalData.journals.length > 0) {
      logger.info({ journal: journalData.journals[0].name }, "V6 使用 DB 匹配期刊");
      finalJournalData = journalData;
    } else {
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
        // PR 1（5-8 P0++）：持久化 AI 编造期刊到 journals 表，让 audit 页可见
        // 去重：name 已存在则仅刷 last_verified_at；不存在则 INSERT 标 ai_fabricated confidence=30
        await this.persistAIJournal(aiJournal, tenantId).catch((err) =>
          logger.warn({ err, journal: aiJournal!.name }, "PR1 AI journal persist 失败（非阻塞）"),
        );
        finalJournalData = {
          hotKeywords: requirement.keyPoints || [],
          journals: [aiJournal],
          abstracts: journalData?.abstracts || [],
          knowledgeEntriesCreated: 0,
        };
      } else {
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
        finalJournalData = {
          hotKeywords: [], journals: [minimalJournal], abstracts: [], knowledgeEntriesCreated: 0,
        };
      }
    }

    // 2. 主版本（必须先跑，副版本依赖其作为 parent 的语义）
    // T4-3-4: 每个 variant 用 templateIds[i]，缺位时退回 templateIds[0] / default
    const primaryTemplateId = templateIds[0] ?? getDefaultTemplateId();
    const primary = await this.generateJournalRecommendation(requirement, finalJournalData, primaryTemplateId, tenantId);

    // 3. 副版本并行跑（共享 finalJournalData，差异来自 LLM temperature 随机性 + 不同 templateId）
    if (requestedVariants > 1) {
      const subPromises: Array<Promise<{
        article: GeneratedArticle;
        quality: QualityReport;
        outline: ArticleOutline;
      }>> = [];
      for (let i = 1; i < requestedVariants; i++) {
        const tid = templateIds[i] ?? primaryTemplateId;
        subPromises.push(this.generateJournalRecommendation(requirement, finalJournalData, tid, tenantId));
      }
      const extraVariants = await Promise.all(subPromises);
      logger.info(
        {
          variants: requestedVariants,
          extraCount: extraVariants.length,
          templateIds: templateIds.slice(0, requestedVariants),
        },
        "T4-1b/T4-3-4: 多版本生成完成（每版独立 templateId）"
      );
      return { ...primary, extraVariants };
    }

    return primary;
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

      // 始终生成 dataCardUri 备用图（即使有 coverUrl 也作为 onerror 回退）
      const svg = generateJournalDataCard(journal);
      journal.dataCardUri = svgToDataUri(svg);

      logger.info({ journal: journal.nameEn || journal.name, if: journal.impactFactor, hasCover: !!journal.coverUrl }, "AI 推荐期刊数据生成完成");
      return journal;
    } catch (err) {
      logger.warn({ err, topic }, "AI 创建期刊数据失败");
      return null;
    }
  }

  /**
   * PR 1（5-8 P0++）：把 AI 编造的期刊持久化到 journals 表，标 data_source='ai_fabricated' confidence=30。
   * 让 /admin/journals/audit 页能 SELECT 到这些低可信 row（PR 2 实施 audit）。
   *
   * 去重：按 (tenantId, name) 查存在则仅刷 last_verified_at（不重复 INSERT）；
   * 不存在则 INSERT 完整 row。tenantId 缺时跳过（公开 /try 路径无 tenant）。
   */
  async persistAIJournal(aiJournal: JournalInfo, tenantId?: string): Promise<void> {
    if (!tenantId) return; // 公开匿名路径无 tenant，不持久化
    const { eq, and } = await import("drizzle-orm");
    const [existing] = await db
      .select({ id: journals.id })
      .from(journals)
      .where(and(eq(journals.tenantId, tenantId), eq(journals.name, aiJournal.name)))
      .limit(1);

    if (existing) {
      await db
        .update(journals)
        .set({ lastVerifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(journals.id, existing.id));
      return;
    }

    await db.insert(journals).values({
      tenantId,
      name: aiJournal.name,
      nameEn: aiJournal.nameEn ?? null,
      issn: aiJournal.issn ?? null,
      publisher: aiJournal.publisher ?? null,
      discipline: aiJournal.discipline ?? null,
      partition: aiJournal.partition ?? null,
      impactFactor: aiJournal.impactFactor ?? null,
      acceptanceRate: aiJournal.acceptanceRate ?? null,
      reviewCycle: aiJournal.reviewCycle ?? null,
      annualVolume: aiJournal.annualVolume ?? null,
      isWarningList: aiJournal.isWarningList ?? false,
      warningYear: aiJournal.warningYear ?? null,
      // PR 1 治理标记
      dataSource: "ai_fabricated",
      confidence: 30,
      lastVerifiedAt: new Date(),
      fieldProvenance: { all: "ai_fabricated" },
    });
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
    journalData: CollectionResult,
    templateId: string = getDefaultTemplateId(),
    tenantId?: string,
  ): Promise<{
    article: GeneratedArticle;
    quality: QualityReport;
    outline: ArticleOutline;
    // 5-23 PR #162 Phase 4-lite: body-level fact check results (caller 设 metadata.hasWarnings)
    bodyHasWarnings?: boolean;
    bodyFactIssues?: ValidationIssue[];
  }> {
    // T4-1b: variantId 用于多版本并行生成时的日志区分
    const variantId = nanoid(6);
    logger.info(
      { variantId, topic: requirement.topic, journal: journalData.journals[0]?.name },
      "📝 generateJournalRecommendation 启动"
    );

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
          // T6-C: 回写 journals 表（idempotent，只在 cover_image_url 为空时写）
          if (journal.id) {
            await persistJournalCover(journal.id, cover, "inline-skill");
          }
        }
      } catch (err) {
        logger.debug({ err, journal: journal.name }, "期刊封面图抓取失败");
      }
    }

    // 1.6 始终生成数据卡片作为备用（coverUrl 加载失败时 onerror 回退）
    {
      const svg = generateJournalDataCard(journal);
      journal.dataCardUri = svgToDataUri(svg);
    }

    // 2. AI 生成：标题 + 收稿范围 + 推荐语
    // PR Q.3：根据 selected template 注入 prompt_overrides + few-shot 行业样板
    const templateAware = await buildTemplateAwarePromptSuffix({
      templateId,
      tenantId: tenantId ?? "",
      query: requirement.topic,
    });
    if (templateAware.templateName) {
      logger.info({ variantId, templateName: templateAware.templateName, styleTag: templateAware.styleTag, suffixLen: templateAware.suffix.length }, "Q.3 template-aware prompt 已注入");
    }
    const aiContentRaw = await this.generateJournalAIContent(journal, templateAware.suffix);

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

    // 3. 模板组装完整文章 HTML（T4-3-1: 走 registry，未注册 ID 降级到 default）
    let template = getTemplate(templateId);
    if (!template) {
      logger.warn({ templateId, fallback: getDefaultTemplateId() }, "template not registered, falling back to default");
      template = getTemplate(getDefaultTemplateId());
    }
    // task #35: 拉 tenant.contact_meta 透传给模板（仅 shunshi-style 用，其他模板忽略）。
    // 失败 / 找不到 / 未传 tenantId 时 tenantInfo = null → 模板走 hardcoded fallback。
    let tenantInfo: { contactMeta?: unknown } | null = null;
    if (tenantId) {
      try {
        const [t] = await db
          .select({ contactMeta: tenants.contactMeta })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);
        if (t) tenantInfo = { contactMeta: t.contactMeta };
      } catch (err) {
        logger.warn({ err, tenantId }, "tenant contactMeta lookup failed; using template fallback");
      }
    }
    // PR Q.5 D4：拉模板的 chart_config 给 htmlGenerator（4 套差异化 chart 数量 + colors）
    // PR Q.6 D5：拉 sectionCount（A=23 / B=15 / C=18 / E=25）控制区块数差异
    const chartConfig = templateAware.chartConfig;
    const articleBody = await template!.htmlGenerator(
      journal,
      aiContent,
      journalData.abstracts,
      tenantInfo,
      chartConfig,
      templateAware.sectionCount ?? undefined,
    );

    // PR Q.4 D3：根据 selected template 的 styleTag 包裹 CSS class，前端 4 CSS 主题生效
    const wrappedBody = templateAware.styleTag
      ? `<article class="bm-template-${templateAware.styleTag}">${articleBody}</article>`
      : articleBody;

    const article: GeneratedArticle = {
      title: aiContent.title,
      body: wrappedBody,
      summary: `期刊推荐：${journal.nameEn || journal.name}，IF ${journal.impactFactor || "N/A"}，${journal.casPartition || journal.partition || ""}`,
      tags: ["期刊推荐", journal.discipline || "学术", journal.partition || ""].filter(Boolean),
      wordCount: ArticleSkill.stripHtmlAndCount(wrappedBody),
    };

    // 5-23 PR #162 Phase 4-lite: body-level fact check (兜底 prompt 硬约束未拦的 AI 幻觉)
    // 提取 body 中具体数字 (IF/录用率/审稿/版面费/创刊年/出版国) 与 DB journal 对照
    // warnings 写入 article.metadata, 推荐池 feed 会 filter hasWarnings=true 不展示给用户
    //
    // 5-23 PR #168 hotfix: in-memory journal.foundingYear/country 被 ensureJournalEnriched
    // 用 AI 推测污染了 (line ~854-855), validator 不能用它当 DB truth. 改 SELECT DB 真值.
    const bodyClaims = extractClaimedFacts(wrappedBody);
    let dbJournalTruth: { impactFactor: number | null; acceptanceRate: number | null; reviewCycle: string | null; apcFee: number | null; foundingYear: number | null; country: string | null } = {
      impactFactor: journal.impactFactor ?? null,
      acceptanceRate: journal.acceptanceRate ?? null,
      reviewCycle: journal.reviewCycle ?? null,
      apcFee: (journal as any).apcFee ?? null,
      foundingYear: null, // PR #168: in-memory 这俩可能被 AI 编, 不信
      country: null,
    };
    if ((journal as any).id) {
      try {
        const [dbRow] = await db
          .select({
            impactFactor: journals.impactFactor,
            acceptanceRate: journals.acceptanceRate,
            reviewCycle: journals.reviewCycle,
            apcFee: journals.apcFee,
            foundingYear: journals.foundingYear,
            country: journals.country,
          })
          .from(journals)
          .where(eq(journals.id, (journal as any).id))
          .limit(1);
        if (dbRow) dbJournalTruth = dbRow;
      } catch (err) {
        logger.warn({ journalId: (journal as any).id, err: err instanceof Error ? err.message : String(err) }, "PR #168 fetch DB truth 失败, 回退 in-memory");
      }
    }
    const factIssues = verifyClaimsAgainstDb(bodyClaims, dbJournalTruth);
    const hasFactWarnings = factIssues.length > 0;
    if (hasFactWarnings) {
      logger.warn(
        { journalName: journal.nameEn || journal.name, claimsCount: bodyClaims.length, issuesCount: factIssues.length, firstIssue: factIssues[0]?.message },
        "PR #162 body-level fact check 发现 warnings"
      );
    }

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

    logger.info({ journal: journal.name, title: aiContent.title, templateId: template!.id }, "V6 期刊推荐文章生成完成");

    return { article, quality, outline, bodyHasWarnings: hasFactWarnings, bodyFactIssues: factIssues };
  }

  /**
   * AI 生成期刊推荐文章的三个关键部分：标题、收稿范围、推荐总结
   * PR Q.3: q3PromptSuffix 由 generateJournalRecommendation 算好后传入
   * （含 prompt_overrides 风格约束 + few-shot 行业样板）。
   */
  async generateJournalAIContent(journal: JournalInfo, q3PromptSuffix: string = ""): Promise<AIGeneratedContent> {
    const ifText = journal.impactFactor != null ? journal.impactFactor.toFixed(1) : "N/A";
    const journalName = journal.nameEn || journal.name;

    // ---- 标题多元化：随机选择句式风格 ----
    // PR #180: 标题风格重写 — 必含期刊名, 禁模板化句式, 禁无数据评价
    // PR #183 (5-20): (1) 年份动态 currentYear 不再硬编码 2025
    //                 (2) IF 为 null 的期刊不放含 IF 的风格 (避免 "IF N/A" 裸露标题)
    //                 (3) 砍掉容易撞车的固定营销话术, 示例标注"仅供骨架参考, 措辞须重写"
    const currentYear = new Date().getFullYear();
    const hasIF = journal.impactFactor != null;
    const rateText = journal.acceptanceRate != null ? `录用率${(journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100).toFixed(0)}%` : "";
    const cycleText = journal.reviewCycle ? `审稿${journal.reviewCycle}` : "";
    // 无 IF 依赖的风格 (所有期刊都可用)
    const titleStyles: string[] = [
      `学科定位型：突出期刊所属学科和出版社。示例骨架（措辞必须重写，勿照抄）："${journalName}: ${journal.publisher || "国际出版社"}旗下${journal.discipline || "学术"}领域旗舰期刊"`,
      `横向对比型：与同领域期刊对比突出差异。示例骨架（措辞必须重写，勿照抄）："${journal.discipline || "学术"}领域期刊盘点: ${journalName} 的定位与特色"`,
      `趋势分析型：结合年度热点。示例骨架（措辞必须重写，勿照抄）："${currentYear}年${journal.discipline || "学术"}研究趋势与 ${journalName} 投稿指南"`,
    ];
    // 含 IF 的风格 — 仅当期刊有真 IF 时启用 (否则会写出 "IF N/A")
    if (hasIF) {
      titleStyles.push(
        `数据亮点型：以 IF + 期刊英文全名为核心。示例骨架（措辞必须重写，勿照抄）："${journalName} IF ${ifText}: ${journal.discipline || "学术"}领域深度盘点"`,
        `深度解读型：聚焦期刊特色和数据。示例骨架（措辞必须重写，勿照抄）："${journalName} 全面解读: IF ${ifText}${rateText ? "·" + rateText : ""}${cycleText ? "·" + cycleText : ""}"`,
      );
    }
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

    // V7（task #11）：sparse null-skip 单字段拼装。某字段缺数据时不出现在 prompt
    // 里 —— 不要给 LLM "我没数据"的明示，避免它根据缺失暗示编造。
    const enrichmentLines: string[] = [];
    if (journal.promptIfHistory && journal.promptIfHistory.length > 0) {
      enrichmentLines.push(`- 近 10 年 IF 历史：${JSON.stringify(journal.promptIfHistory)}`);
      if (journal.promptIfPredicted) {
        enrichmentLines.push(`- IF 预测：${JSON.stringify(journal.promptIfPredicted)}`);
      }
    }
    if (journal.promptCarIndex?.data && journal.promptCarIndex.data.length > 0) {
      enrichmentLines.push(`- 近 5 年 CAR 指数（中国学者占比）：${JSON.stringify(journal.promptCarIndex.data)}，风险等级：${journal.promptCarIndex.riskLevel || "未知"}${journal.promptCarIndex.isWarningListed ? "，⚠️ 中科院预警名单" : ""}`);
    }
    if (journal.promptCitingTop10?.topJournals && journal.promptCitingTop10.topJournals.length > 0) {
      enrichmentLines.push(`- 引用前 10 期刊：${JSON.stringify(journal.promptCitingTop10.topJournals)}${journal.promptCitingTop10.selfCitationRate != null ? `，自引率：${(journal.promptCitingTop10.selfCitationRate * 100).toFixed(1)}%` : ""}`);
    }
    if (journal.promptScopeDetails) {
      const sd = journal.promptScopeDetails;
      if (sd.categories && sd.categories.length > 0) enrichmentLines.push(`- 收稿分类：${JSON.stringify(sd.categories)}`);
      if (sd.articleTypes && sd.articleTypes.length > 0) enrichmentLines.push(`- 接受文章类型：${sd.articleTypes.join("、")}`);
      if (sd.subjectDistribution && sd.subjectDistribution.length > 0) enrichmentLines.push(`- 学科分布：${JSON.stringify(sd.subjectDistribution)}`);
    }
    if (journal.promptPublicationCosts?.apc != null || journal.promptPublicationCosts?.openAccess != null) {
      const pc = journal.promptPublicationCosts;
      enrichmentLines.push(`- 版面费：${pc.apc != null ? `${pc.apc} ${pc.currency || "USD"}` : "未公开"}${pc.openAccess ? "（开放获取）" : ""}${pc.fastTrack ? "（快速通道）" : ""}`);
    }
    if (journal.promptJcrFull) {
      const jc = journal.promptJcrFull;
      const jcrParts: string[] = [];
      if (jc.wosLevel) jcrParts.push(`WOS：${jc.wosLevel}`);
      if (jc.jifSubjects && jc.jifSubjects.length > 0) jcrParts.push(`JIF：${JSON.stringify(jc.jifSubjects)}`);
      if (jc.jciSubjects && jc.jciSubjects.length > 0) jcrParts.push(`JCI：${JSON.stringify(jc.jciSubjects)}`);
      if (jc.isTopJournal) jcrParts.push("顶级期刊");
      if (jc.isReviewJournal) jcrParts.push("综述期刊");
      if (jcrParts.length > 0) enrichmentLines.push(`- JCR 详细：${jcrParts.join("，")}`);
    }
    if (journal.promptPublicationStats) {
      const ps = journal.promptPublicationStats;
      if (ps.frequency) enrichmentLines.push(`- 刊期：${ps.frequency}`);
      if (ps.annualVolumeHistory && ps.annualVolumeHistory.length > 0) enrichmentLines.push(`- 年发文量历史：${JSON.stringify(ps.annualVolumeHistory)}`);
      if (ps.topInstitutions && ps.topInstitutions.length > 0) enrichmentLines.push(`- 活跃机构：${JSON.stringify(ps.topInstitutions)}`);
    }
    const enrichmentBlock = enrichmentLines.length > 0
      ? `\n【真实补充数据 — 深度分析必须基于此】\n${enrichmentLines.join("\n")}\n`
      : "";

    // 5-23 PR #162 Phase 2: 改 "字段缺=未知" → "字段缺=不列出" + 显式 ##未公开字段## 块
    // 让 AI 清楚哪些字段没数据, 文章中**完全不要提及** (PR #184 砍兜底话术, 见下方 unknownBlock)
    const knownFields: string[] = [];
    const unknownFields: string[] = [];
    knownFields.push(`- 名称：${journalName}${journal.abbreviation ? `（${journal.abbreviation}）` : ""}`);
    if (journal.discipline) knownFields.push(`- 学科：${journal.discipline}`); else unknownFields.push("学科");
    // ifText 在前面构造 (来自 journal.impactFactor 或 ifHistory), 非 "未知" 才算 known
    if (ifText && !ifText.includes("未知")) knownFields.push(`- 影响因子：${ifText}`); else unknownFields.push("影响因子");
    if (journal.casPartition || journal.partition) knownFields.push(`- 分区：${journal.casPartition || journal.partition}`); else unknownFields.push("分区");
    if (journal.casPartitionNew) knownFields.push(`- 新锐分区：${journal.casPartitionNew}`);
    if (journal.acceptanceRate != null) {
      knownFields.push(`- 录用率：${(journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100).toFixed(0)}%`);
    } else { unknownFields.push("录用率"); }
    if (journal.reviewCycle) knownFields.push(`- 审稿周期：${journal.reviewCycle}`); else unknownFields.push("审稿周期");
    if (journal.publisher) knownFields.push(`- 出版商：${journal.publisher}`); else unknownFields.push("出版商");
    if ((journal as any).foundingYear) knownFields.push(`- 创刊年：${(journal as any).foundingYear}`); else unknownFields.push("创刊年");
    if ((journal as any).country) knownFields.push(`- 出版国：${(journal as any).country}`); else unknownFields.push("出版国");
    if ((journal as any).apcFee != null) knownFields.push(`- 版面费 (APC)：$${(journal as any).apcFee}`); else unknownFields.push("版面费");
    knownFields.push(journal.isWarningList ? "- ⚠️ 在中科院预警名单中" : "- 不在中科院预警名单中");

    // PR #184 (5-20): 收录状态注入 — 严格按真实字段, 防止非 SCI 期刊被当 SCI 写
    const indexStatuses: string[] = [];
    const wosLevel = journal.promptJcrFull?.wosLevel;
    if (wosLevel) indexStatuses.push(`WOS ${wosLevel}`); // SCIE / SSCI / ESCI / AHCI
    const cats = journal.catalogs || [];
    if (cats.includes("cssci")) indexStatuses.push("CSSCI（南大核心）");
    if (cats.includes("pku-core")) indexStatuses.push("北大核心");
    if (cats.includes("cscd")) indexStatuses.push("CSCD（中国科学引文数据库）");
    if (journal.catalogType === "sci" || journal.catalogType === "sci-core") {
      if (!wosLevel) indexStatuses.push("SCI 收录");
    }
    if (indexStatuses.length > 0) {
      knownFields.push(`- 收录情况：${indexStatuses.join("、")}（文章中描述收录情况必须严格按此, 不得拔高）`);
    } else {
      // 无任何权威收录证据 → 明确告诉 AI 不许称 SCI/SSCI
      knownFields.push(`- 收录情况：无 SCI/SSCI/中文核心 收录证据（**严禁**称其为 "SCI 期刊" / "SSCI 期刊" / "核心期刊" / "顶刊", 只能客观介绍）`);
    }

    // PR #184: 砍 "据公开资料尚无统一披露" 教唆 (运营反馈这是 AI 感来源).
    // 缺数据的字段 → 文章里**完全不提**, 而非自暴 "暂无数据".
    const unknownBlock = unknownFields.length > 0
      ? `\n##未公开字段## (以下字段无数据, 文章中**完全不要提及这些字段**, 禁止出现"暂无/未公开/据公开资料尚无/由于缺乏...数据"等任何说法)：${unknownFields.join("、")}\n`
      : "";

    // 5-23 PR #167: 4 字段黑名单 — backfill 报告确认这 4 字段 DB 0 源覆盖 (AI 编源 100% 确认)
    // 任何场景下都不允许出具体值. 仅允许模糊词 (较高/较低/适中/相对宽松/较快/较慢/标准)
    const blacklistBlock = `
##禁止字段## (BossMate database 缺失数据, 严禁虚构以下 4 类具体值)
- **创刊年 / founded in / 创办于**: 禁止提具体年份, 禁止"可追溯至 XXXX"、"创办于 XXXX"。若必须提及, 用"历史悠久的"或"近年新创"等模糊词
- **出版国 / 出版地 / based in / country**: 禁止具体国家名 (如"瑞士"、"美国"、"英国"). 若必须提及, 用"国际期刊"或"业内"等中性词
- **录用率**: 仅允许"较高 / 较低 / 适中 / 相对宽松 / 难度较大"等模糊词. **禁止具体百分比** (除非 ##已知期刊数据## 给了 acceptanceRate 字段)
- **审稿周期**: 仅允许"较快 / 较慢 / 标准 / 周期合理"等模糊词. **禁止具体周数** (除非 ##已知期刊数据## 给了 reviewCycle 字段)

违反任一 → validator 拦截 → 文章排除推荐池 (无效产出, 浪费 token).
`;

    const prompt = `你是一个学术期刊推荐自媒体的资深写手，擅长用不同风格的标题吸引读者。根据以下期刊信息，生成内容。

##已知期刊数据## (文章中所有具体数字必须来自这里, 严禁编造)
${knownFields.join("\n")}
${unknownBlock}${blacklistBlock}${enrichmentBlock}
## 分区数据约束 (PR #180)
任何 "分区" / "Q1" / "Q2" / "Q3" / "Q4" / "X区顶刊" 等表述,
必须来自 ##已知期刊数据## 中的 partition 或 jifSubjects[].zone.
若两个字段都 NULL → 文章中**禁止提分区**, 也禁止说"顶刊" / "X区刊"。

## 标题硬约束 (PR #180 + #183 + #184)
1. 【期刊名可选】期刊名(${journalName})可放标题也可不放; 若期刊名超过 20 个字符, **优先不放标题**(避免吞掉噱头), 改放副标题/正文。标题要先吸引人, 不是先报刊名。
2. 【完整性】严禁出现悬空对比 (如 "A vs " 后面没有 B)、截断、半句话。每个标题都必须是完整通顺的一句。
3. 【中文为主】标题以中文为主, 英文仅限期刊名/必要专业缩写(如 IF、SCI), 不要中英文生硬混杂。
4. 【要有钩子】标题必须有痛点或悬念, 戳中科研人真实需求 (如 投稿周期、命中率、避坑、选刊纠结、毕业/评职压力), 不要干巴巴罗列参数。
5. 禁止以下模板式句式: "毕业季还没发SCI?" / "XX值得一投!" / "审稿快、录用率高" / "为何是性价比之王?" / "最火研究方向"
6. 禁止无数据模糊评价: "录用率高/低" / "审稿快/慢" / "性价比高" (除非有 DB 真数字)
7. 标题长度 18-40 字 (太长公众号会截断)
8. 【防撞车】"本次标题风格"里引号内仅是结构骨架, 严禁照搬其措辞/句式; 必须用全新词汇重新构思
9. 【年份】如需写年份, 一律用 ${currentYear} (当前年), 禁止写 2025 或其它过往年份
10. 【无 IF 不提 IF】若 ##已知期刊数据## 中无 impactFactor, 标题禁止出现 "IF" / "影响因子" 字样
11. 【收录状态如实】标题涉及 SCI/SSCI/核心 字样时必须与 "收录情况" 一致, 无收录证据严禁写 "SCI"

【本次标题风格】
${chosenStyle}
${disciplineHint}

【叙事口吻】
- recommendation 不要写成干巴巴的总结，要有个人观点和态度（像资深编辑而非百科词条）
- scopeDescription 要专业但不枯燥，适当加入「热门方向」「近年趋势」等吸引读者的表述
- editorComment 要极口语化，像和朋友聊天（"说实话这本刊..."、"赶毕业投这个！"）

【正文语言要求】(PR #184)
- 正文以**中文为主**, 英文只用于期刊名、必要专业术语缩写(IF/SCI/OA 等), 不要整句英文或中英文生硬混杂。
- 🚫🚫 **严禁元话术**: 绝对不要出现 "由于缺乏...数据" / "无法详细分析" / "暂无统一披露" / "数据未公布" / "缺少相关数据" 这类自暴其短的句子。某项没数据就**直接不写那部分**, 当它不存在, 绝不解释为什么没写。

【深度分析章节】（V7 task #11，4 个独立 HTML 字段）
🚫 严格禁止基于上方未提及的字段编造数据。
🚫 如某章节缺关键数据 → 该字段直接返回 null (整章不渲染), **绝不要**写"由于缺乏数据无法分析"之类的占位话。宁可少一章, 不要有 AI 感的空话。
- ifHistoryAnalysis（200-400 字）：基于"近 10 年 IF 历史"和"IF 预测"做趋势深度分析。引用具体年份和数字（如"从 2015 年 3.2 涨到 2024 年 7.8"），分析涨跌拐点，给出趋势判断。**无 IF 历史数据时返回 null**。
- carRiskAnalysis（200-400 字）：基于"近 5 年 CAR 指数"和"风险等级 + 预警名单"分析国内学者投稿现状。给出明确建议（"国内学者占比逐年升至 X%，CAR 风险 low/mid/high，可放心冲 / 谨慎评估 / 强烈避雷"）。**无 CAR 数据时返回 null**。
- scopeAndCitations（200-400 字）：基于"收稿分类 / 文章类型 / 学科分布"和"引用前 10 期刊 / 自引率"分析期刊定位 + 引用生态。引用具体期刊名（如"主要被 Lancet（12.5%）、NEJM（8.3%）引用"）。**无引用数据时只写收稿范围定位, 绝不提"缺引用数据"**。
- submissionAdvice（300-500 字）：综合"版面费 / 录用率 / 审稿周期 / JCR 详细 / 年发文量"给投稿建议。明确：APC 多少 / 哪类作者适合冲 / 哪类避开 / 性价比评分。引用具体数字。**有几项写几项, 没有的不提**。

请输出纯 JSON（不要 markdown）：
{
  "title": "按照上面指定的标题风格生成的标题",
  "scopeDescription": "收稿范围的详细描述（200-400字），分总述和具体方向列表。用HTML格式，可用<p>和<strong>标签。说明期刊聚焦什么领域、欢迎什么类型的稿件、有什么特色。要专业准确但不枯燥。",
  "recommendation": "推荐总结（150-300字），综合点评期刊的优势、适合什么样的作者投稿，用HTML格式。要有态度和个人观点，不要像百科全书。",
  "editorComment": "一句话小编点评（15-30字），极口语化、接地气，像朋友间推荐，如'说实话审稿快到离谱，赶毕业的同学冲！'",
  "highlightTip": "一个划重点提示（20-40字），提炼最核心的投稿建议或数据亮点",
  "ifPrediction": "影响因子走势预测的简短描述，如'预测今年涨至15分'，如果无法预测就返回null",
  "rating": 推荐星级1-5的数字,
  "ifHistoryAnalysis": "章 1 — HTML，引用真实数据。无 IF 历史数据则返回 null（禁止写空话）。",
  "carRiskAnalysis": "章 2 — HTML，引用真实数据。无 CAR 数据则返回 null（禁止写空话）。",
  "scopeAndCitations": "章 3 — HTML，引用真实数据。无引用数据则只写收稿定位, 禁止提'缺数据'。",
  "submissionAdvice": "章 4 — HTML，引用真实数据。有几项写几项, 没有的不提。"
}`;

    // 5-23 PR #162 Phase 2: 双重硬约束 (system + user 各重复一次) — 防 AI 凭训练记忆编 IF / 录用率 / 创刊年
    const baseSystemPrompt = `你是学术期刊分析专家，输出严格JSON格式。

##硬规则##
1. 文章中所有具体数字必须来自 user 消息 ##已知期刊数据## 段, 严禁从训练记忆调任何数字 / 年份 / 国家 / 价格
2. 未在 ##已知期刊数据## 出现的字段, 严禁虚构, 用兜底语代替
3. **特别注意 — 以下 4 字段是 BossMate database 没有的数据 (backfill 实测 0 源覆盖):**
   - **创刊年**: 禁止提具体年份, 若必须涉及用"历史悠久的"等模糊词
   - **出版国 / 出版地**: 禁止具体国家名, 用"国际期刊""业内"等中性词
   - **具体录用率百分比**: 禁止 "录用率 48%" 类表述, 仅允许"较高/较低/适中"
   - **具体审稿周数**: 禁止 "审稿 5-8 周" 类表述 (除非 ##已知期刊数据## 给了 reviewCycle), 仅允许"较快/较慢/标准"
4. 违反 → validator 拦截 + hasWarnings=true → 文章排除推荐池, 浪费 token`;
    const finalSystemPrompt = q3PromptSuffix ? `${baseSystemPrompt}${q3PromptSuffix}` : baseSystemPrompt;

    try {
      let result = await this.provider.chat({
        messages: [
          { role: "system", content: finalSystemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.6,
        // V7：原 2048 不够装 7 短字段 + 4 新章节（每章 200-500 字 ≈ 4000+ tokens 输出）
        maxTokens: 6000,
      });

      // PR Q.6.1：检测 title 历史峰值幻觉，命中 → 加更强约束 + LLM 重生 1 次（最多 1 次重试）。
      // 5-8 D5 C 套实测违反："IF从44飙升到98.4" — NUMBER_CONSTRAINT 在 prompt 中但 LLM 偶发不严格遵守。
      const peakMatch = result.content.match(/从\s*\d+(\.\d+)?\s*[飙涨升]+\s*[到至]\s*\d+/);
      if (peakMatch) {
        logger.warn({ journalName, badTitleSnippet: peakMatch[0] }, "Q.6.1 title 历史峰值幻觉，LLM 重生 1 次");
        const reinforced = finalSystemPrompt
          + `\n\n### ⚠️ 重生约束（你上次输出含历史峰值表述「${peakMatch[0]}」违反 task #54）\n`
          + `本次必须避免任何"从 X 飙到 Y / 涨到 / 升至"等历史 → 当前的对比表述作 title。\n`
          + `title 仅描述当前 IF 数值（如"IF 98.4 的医学顶刊"），历史趋势放 ifHistoryAnalysis 章节。`;
        result = await this.provider.chat({
          messages: [
            { role: "system", content: reinforced },
            { role: "user", content: prompt },
          ],
          temperature: 0.4,  // 降 temperature 让 LLM 更严格遵守
          maxTokens: 6000,
        });
      }

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
          // V7：4 新独立章节字段（不合并）。PR #184: LLM 缺数据时返回 null → 整章不渲染（不再写"暂无数据"空话）。
          ifHistoryAnalysis: typeof parsed.ifHistoryAnalysis === "string" ? parsed.ifHistoryAnalysis : undefined,
          carRiskAnalysis: typeof parsed.carRiskAnalysis === "string" ? parsed.carRiskAnalysis : undefined,
          scopeAndCitations: typeof parsed.scopeAndCitations === "string" ? parsed.scopeAndCitations : undefined,
          submissionAdvice: typeof parsed.submissionAdvice === "string" ? parsed.submissionAdvice : undefined,
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
