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
import { extractJsonObject } from "../content-engine/llm-json.js";
import { AiUnavailableError, isAiUnavailableError } from "../ai/chat-service.js";
import { isAiFallbackText } from "../ai/fallback-messages.js";
import type { AIProvider, ChatMessage } from "../ai/providers/base.js";
import type { ISkill, SkillContext, SkillResult } from "./base-skill.js";
import { retrieveForArticle } from "../knowledge/rag-retriever.js";
import { modelRouter } from "../ai/model-router.js";
import { publishToAccounts, type PublishResult } from "../publisher/index.js";
import { collectJournalContent, type CollectionResult, type JournalInfo } from "../data-collection/journal-content-collector.js";
import { generateJournalArticleHtml, generateJournalSectionHtml, type AIGeneratedContent } from "./journal-template.js";
import { getTemplate, getDefaultTemplateId, pickRotatingTemplateId } from "./template-registry.js";
import { env } from "../../config/env.js";
import { selectVariantTemplates } from "./template-preference.js";
import { ensureJournalEnriched } from "../crawler/springer-journal-fetcher.js";
import { buildTemplateAwarePromptSuffix } from "./template-prompt-injector.js";
import { buildVariation } from "./structure-variation.js"; // PR-X1 结构组合引擎 + PR-FW 加权
import { validateAIContent, type ValidationIssue, extractClaimedFacts, verifyClaimsAgainstDb } from "./ai-content-validator.js";
import { fetchJournalCoverMultiSource, generateJournalDataCard, svgToDataUri } from "../crawler/journal-image-crawler.js";
import { persistJournalCover } from "../crawler/journal-cover-persist.js";
import { db } from "../../models/db.js";
import { platformAccounts, tenants, journals } from "../../models/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { buildJournalFieldContract } from "./journal-prompt-fields.js";
import { ARTICLE_PROMPT_VERSION } from "./prompt-version.js";
// 7-28: 分区证据的列清单单一真相源(别再手写 casPartition 这类死列, 见 intl-signal.ts 病史)
import { hasAnyFact, PARTITION_FACT_KEYS } from "../compliance/fabrication-criteria.js";
import { isDomesticKind, toJournalKind } from "../journals/journal-kind.js";
import { nanoid } from "nanoid";
import { buildClicheBanPrompt } from "../../data/ai-cliche.js";
import { pickHookPatterns } from "../../data/hook-patterns.js";
import { buildImageSlotPromptBlock, applyImageSlots } from "../content-engine/image-slots.js";
import { recordUsage, usageCount, exhaustedKeys } from "../content-engine/usage-rotation.js";

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
  /** 8-07: AI 返回抽不出 JSON 的降级产物(标题是拼的, 无深度章节/videoScript)。红线 #14 */
  titleFallback?: boolean;
  title: string;
  body: string;
  summary: string;
  tags: string[];
  wordCount: number;
  videoScript?: string; // PR #241: 视频脚本独立字段
  variationRecipe?: import("./structure-variation.js").VariationRecipe; // PR-FW: 本篇配方, 飞轮归因
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

/**
 * 7-28 阶段1-C: 国内刊判定/指引 + prompt 字段契约已收口到 `journal-prompt-fields.ts`
 * (与 ##已知期刊数据##/##未公开字段##/##禁止字段##/密度要求 四个块同源生成, 见该文件头注释)。
 *
 * 这里保留 re-export 是为了不打断既有 import 路径(单测与 title 侧都从 article-skill 取)。
 * **新代码请直接 import `journal-prompt-fields.js`**, 别再从本文件转一手。
 */
export { isPureDomesticJournal, buildDomesticJournalGuidance } from "./journal-prompt-fields.js";

// ============ 7-28 阶段1-C: 主 prompt 的静态块 ============
//
// 原状: `generateJournalAIContent` 里一个 204 行的模板字面量, 22 个 PR 层层 append, 81 条禁止指令,
//   从不删除、从不合并、块与块之间零交叉校验 —— 这是 4 次"prompt 自相矛盾"事故的温床。
// 现状: 拆成有名字的块。**不含插值的块**提到这里当模块常量(可被单测直接读, 也让方法体只剩接线),
//   **含插值的块**留在方法体内就地拼(见 const prompt = [...] 的组装处)。
// 字段相关的四个块(已知数据/未公开/禁止字段/密度要求)不在这里 —— 它们由 journal-prompt-fields.ts
//   的 buildJournalFieldContract 同源生成, 那才是矛盾检测能成立的前提。
// 改这些块的文本 = 改 prompt 内容 → 记得按 prompt-version.ts 的规则 bump ARTICLE_PROMPT_VERSION。

/** 块: 小编口吻铁律 (7-03 老韩拍板) */
const PROMPT_BLOCK_TONE = `## 小编口吻铁律 (7-03 老韩拍板 — 不是论文摘要, 是小编转述)
1. 【身份与人称】全程以"小编"身份、第一人称口语化转述（"我翻了下它近几年的数据"），像把你研究过的期刊讲给读者听，不是客观陈述堆砌。
2. 【每个硬数据都要带小编解读】报完数字必须跟一句你的主观判断，例："2.4 的 IF 在工程技术 3 区里不算亮眼，但胜在稳" / "5 个月录用，说实话在这个领域算快的"。只报数不评价 = 论文摘要腔，不合格。
3. 【禁学术论文腔】🚫 严禁"本文/该刊具有/本刊系/综上所述/综上/呈现出/表明/据统计显示"这类论文式句式堆砌；想说"该刊具有较快的审稿速度"就改说"它审稿是真的快"。
4. 【小编语气词】适量用"说实话 / 我翻了下 / 划重点 / 注意 / 讲真"拉近距离，但别过量——每段最多一处，全文不超过 5 处，堆多了油腻。
5. 【人设优先】若下方注入了【账号人设】，以人设为准调整狠度/术语密度——"小编转述+给判断"是基调，具体口吻跟人设走；无人设时默认"贴心学术小编"（热心、有判断、不端着）。
6. 【真实为界】口语化只改"怎么说"，不改"说什么"——所有数字/事实仍严格来自 ##已知期刊数据##，主观判断只能基于这些真数据做，严禁为了口气顺编数据。
`;

/** 块: 叙事口吻 + 正文语言要求 (PR #184) */
const PROMPT_BLOCK_NARRATION = `
【叙事口吻】
- recommendation 不要写成干巴巴的总结，要有个人观点和态度（像资深编辑而非百科词条）
- scopeDescription 要专业但不枯燥，适当加入「热门方向」「近年趋势」等吸引读者的表述
- editorComment 要极口语化，像和朋友聊天（"说实话这本刊..."、"赶毕业投这个！"）

【正文语言要求】(PR #184)
- 正文以**中文为主**, 英文只用于期刊名、必要专业术语缩写(IF/SCI/OA 等), 不要整句英文或中英文生硬混杂。
- 🚫🚫 **严禁元话术**: 绝对不要出现 "由于缺乏...数据" / "无法详细分析" / "暂无统一披露" / "数据未公布" / "缺少相关数据" 这类自暴其短的句子。某项没数据就**直接不写那部分**, 当它不存在, 绝不解释为什么没写。`;

/** 块: 深度分析章节说明 (V7 task #11 的 4 个 HTML 字段) */
const PROMPT_BLOCK_DEEP_ANALYSIS = `
【深度分析章节】（V7 task #11，4 个独立 HTML 字段）
🚫 严格禁止基于上方未提及的字段编造数据。
🚫 如某章节缺关键数据 → 该字段直接返回 null (整章不渲染), **绝不要**写"由于缺乏数据无法分析"之类的占位话。宁可少一章, 不要有 AI 感的空话。
- ifHistoryAnalysis（200-400 字）：基于"近 10 年 IF 历史"和"IF 预测"做趋势深度分析。引用具体年份和数字（如"从 2015 年 3.2 涨到 2024 年 7.8"），分析涨跌拐点，给出趋势判断。**无 IF 历史数据时返回 null**。
- carRiskAnalysis（200-400 字）：基于"近 5 年 CAR 指数"和"风险等级 + 预警名单"分析国内学者投稿现状。给出明确建议（"国内学者占比逐年升至 X%，CAR 风险 low/mid/high，风险较低可列入备选 / 谨慎评估 / 强烈避雷"）。🚫 严禁"放心投稿/放心冲/必中/稳过"等替读者拍板的承诺话术（7-03 老韩红线）。**无 CAR 数据时返回 null**。
- scopeAndCitations（200-400 字）：仅基于上方**已提供的可信字段**(学科/JCR分区/收录/版面费等)分析期刊定位与适配方向。🚫 收稿concepts/引用前10/自引率/CAR 等 OpenAlex 派生数据已全部下线, **严禁提及或编造这些**(被谁引用、引用生态、中国学者占比、自引率等一律不写)。**若除学科外无更多可信定位信息 → 该字段直接返回 null**。
- submissionAdvice（300-500 字）：综合"版面费 / 录用率 / 审稿周期 / JCR 详细 / 年发文量"给投稿建议。明确：APC 多少 / 哪类作者适合冲 / 哪类避开 / 性价比评分。引用具体数字。**有几项写几项, 没有的不提**。🚫 **若上方数据中已给出 APC 具体金额, 必须按该金额表述(如"APC 约 USD 3350"), 严禁写"未公开/未披露/未明确/通常 OA 期刊版面费较高"这类模糊或泛化说法**(数据明摆着却说"未公开"是误导)。`;

/** 块: videoScript 数字人口播脚本规范 (6-26 口播强化) */
const PROMPT_BLOCK_VIDEO_SCRIPT = `
【videoScript】数字人口播脚本 — 独立于图文, 发抖音/视频号. ⚠️ 这是"说"的稿子不是"写"的稿子, 标准比图文更高, 当成爆款短视频文案认真写 (6-26 口播强化):
- 长度: **220-320 字**纯文本 (中文 ~4 字/秒 → 目标 55-80 秒; 短一点完播率更高也更省合成费). 🚫 严禁 HTML / markdown / emoji / 分点 / 小标题 — 就是一段能一口气念下来的话.
- 口播铁律 (违反就废, 写完默念一遍, 拗口就重写):
  · **对"一个人"说**, 全程用"你"——"你是不是""你要是""告诉你""帮你省事". 🚫 不准"广大作者""各位""大家".
  · **短句**为主, 一句一个意思, 像说话不像念书. 能口语就口语: 用"说白了""先说结论""划重点""别急""说几个关键的"取代书面连接词.
  · **数字说人话**: "差不多三个月""一千五百块美金左右""十篇里能中七八篇", 🚫 不要"约 12 周""录用率约 78%"这种书面腔.
- **开场 3 秒钩子** (第一句话, 最重要, 决定观众划不划走): 必须是下面任一型, 张嘴就砸结论/痛点, 🚫 严禁"今天给大家介绍一本期刊"这类温吞开场:
  · 痛点扎心型: "投了三个月还卡在外审? 这本审稿快到离谱."
  · 数字冲击型: "影响因子 5 分多, 录用率却高得不像话."
  · 反常识/捡漏型: "别再死磕大刊了, 这本捡漏神刊很多人还不知道."
  · 身份直呼型: "赶毕业的硕博听好了, 这本可能是你的救命稻草."
  · 悬念前置型: "有本 SCI 审稿快、录用友好还便宜, 但有一类人千万别投 — 先说是哪本."
- **中段留钩子防划走** (完播关键): 在"投稿数据"讲完后埋一句悬念再继续, 例: "不过有个坑得提醒你""最关键的一点还在后面""但先别急着投".
- **五段骨架** (段间用句号自然连, 🚫 不要露出段落标题/编号):
  1. 钩子 (一句, 见上).
  2. 报刊定位 (一句话): 刊名 + 学科方向 + IF + 分区, 分区**逐字原文搬运** (PR #232). 例: "说的是 X 期刊, 公共卫生方向的 SCI, 影响因子 X, 中科院 X 区."
  3. 投稿数据 (3-5 个真实数据点, 口语化, 边说边带态度): 录用难度 → 审稿周期 → APC → 风险. 例: "这个价在同档里算良心的."
  4. 适合谁 / 避开谁 (落到具体人): "适合三类人冲… 但你要是做 Y 方向的, scope 对不上, 别硬投."
  5. 行动号召 (一句, 最多两个动作, 可留互动): "想看更多选刊关注我, 拿不准的私信问." 或 "这刊到底冲不冲? 评论区聊聊."
- 数据红线 (同图文正文, 不可破): 分区原文搬运 (PR #232); 收录状态如实, 不写"未被 SCI 收录"否定句 (PR #230/#233); 没有的数据不编造 (PR #229); APC 有就报数字、没有不提 (PR #228); 🚫 严禁"必看/封神/包过/稳过/水刊"等违规夸张词.
- 缺关键数据 → 该段聚焦学科 + scope 讲, 但全文仍要 220+ 字, 🚫 绝不写"暂无数据/数据未公开".`;

/** 块: 输出 JSON schema */
const PROMPT_BLOCK_OUTPUT_JSON = `请输出纯 JSON（不要 markdown）：
{
  "title": "按照上面指定的标题风格生成的标题",
  "openingHook": "开头钩子导语（60-120字/2-3句），文章的第一段, 决定读者划不划走, 也是评分'选题与钩子'维度读的开头。必须按【下方指定的开头钩子模式】写: 用读者真实处境/痛点场景切入(卡审稿/被拒/赶毕业/选刊纠结/评职压力), 小编第一人称口吻(像跟朋友说话), 落到本刊能解决什么。🚫 严禁'该刊是一本…'/'随着…的发展'/'今天给大家介绍'式平铺温吞开场。🚫 钩子里任何数字/分区/判断必须真实(红线, 无数据就用开放式提问, 不给假答案)。",
  "scopeDescription": "收稿范围的详细描述（200-400字），分总述和具体方向列表。用HTML格式，可用<p>和<strong>标签。说明期刊聚焦什么领域、欢迎什么类型的稿件、有什么特色。要专业准确但不枯燥。",
  "recommendation": "推荐总结（150-300字），综合点评期刊的优势、适合什么样的作者投稿，用HTML格式。要有态度和个人观点，不要像百科全书。",
  "editorComment": "一句话小编点评（15-30字），极口语化、接地气，像朋友间推荐，如'说实话审稿快到离谱，赶毕业的同学冲！'",
  "highlightTip": "一个划重点提示（20-40字），提炼最核心的投稿建议或数据亮点",
  "ifPrediction": "影响因子走势预测的简短描述，如'预测今年涨至15分'，如果无法预测就返回null",
  "rating": 推荐星级1-5的数字,
  "ifHistoryAnalysis": "章 1 — HTML，引用真实数据。无 IF 历史数据则返回 null（禁止写空话）。",
  "carRiskAnalysis": "章 2 — HTML，引用真实数据。无 CAR 数据则返回 null（禁止写空话）。",
  "scopeAndCitations": "章 3 — HTML，引用真实数据。无引用数据则只写收稿定位, 禁止提'缺数据'。",
  "submissionAdvice": "章 4 — HTML，引用真实数据。有几项写几项, 没有的不提。",
  "videoScript": "数字人口播脚本，纯文本无 HTML/分点，**220-320 字**(目标 55-80 秒)。第一句是开口3秒强钩子(痛点/数字/反常识/身份/悬念，绝不温吞)。五段一口气念下来：钩子 + 报刊定位 + 投稿数据 + 适合谁/避开谁 + 行动号召；中段留一句悬念防划走。对一个人说话(多用你)、短句、数字说人话。仅供数字人朗读，不进图文。"
}`;



/**
 * 🔴 一次 AI 调用**失败了没有**，在这里问清楚，不要等到抽 JSON 抽不出再猜。
 *
 * 8-14 实证（红线 #14 第七次）：8-13 百炼返回 403（Workspace.AccessDenied /
 * AccessDenied.Unpurchased），主备模型全挂。chat-service 于是把一句人类可读的
 * 道歉文案当作 `content` 返回（这对聊天场景友好，对生成链路是炸弹）。
 * 本函数原来拿着这 18 个字去抽 JSON，抽不出，然后产出
 * 「期刊推荐：图书与情报，影响因子 N/A」落库 needs_review ——
 * **一次外部故障被洗成了一篇成品**。
 *
 * 日志当时全都在（finishReason=error / outputTokens=0 / rawLength=18），
 * 但没有任何**结构化**痕迹说"这篇是外部故障的产物"，所以谁也没法凭数据裁决它。
 *
 * 抛出 AiUnavailableError 后：failure-kind 判 service_down → 进 deferred →
 * 服务恢复自动重跑。上游 403 我们控制不了，把失败洗成成品是我们自己的。
 */
function assertRealAiOutput(
  result: { content?: string | null; finishReason?: string; outputTokens?: number },
  where: string,
): void {
  const text = String(result.content ?? "");
  const reason =
    result.finishReason === "error" ? "call_failed"
    : isAiFallbackText(text) ? "fallback_text"
    // 🔴 正文为空但烧掉了大量 token —— 推理型模型(v4-pro)把预算全花在思维链上,
    //   可见输出一个字都没有。日志实证 3/11: outputTokens=6001(撞满 maxTokens=6000)、
    //   rawLength=0。这才是"截断"的真形态, 而且它**不带任何错误信号**:
    //   finishReason 正常、没有异常、没有兜底文案 —— 只认 error 的守卫会整类漏掉。
    : text.trim().length === 0 ? "empty_output"
    : null;
  if (!reason) return;
  logger.error(
    {
      where,
      reason,
      finishReason: result.finishReason ?? null,
      outputTokens: result.outputTokens ?? null,
      rawLength: text.length,
      rawHead: text.slice(0, 200),
    },
    "🔴 AI 这次等于没返回 —— 本篇转 deferred, 不产出兜底成品",
  );
  throw new AiUnavailableError("exhausted", "unknown", "unknown");
}

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
    // PR-X1: batch worker 注入的账号人设/风格 prompt (独家模式)
    const personaPrompt = (context.metadata?.personaPrompt as string) || "";
    // 7-03 ④: 钩子/措辞轮换 scope — 批量路径 batchId(本批内轮换), 单号路径 accountId, 兜底 tenantId(当天)
    const hookScope = (context.metadata?.batchId as string) || (context.metadata?.accountId as string) || context.tenantId || "";
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
    // PR-G: 无显式模板/偏好时, 在已注册模板间轮换 (env ARTICLE_TEMPLATE_ROTATION=false 则固定默认 shunshi).
    explicitTemplateId = explicitTemplateId ?? (env.ARTICLE_TEMPLATE_ROTATION === "false" ? getDefaultTemplateId() : pickRotatingTemplateId());

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
      personaPrompt, // PR-X1
      hookScope, // 7-03 ④ 钩子轮换
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
          // 7-28 阶段1-C: prompt 版本号落库 —— 质量下滑时才能归因到"哪次 prompt 改动",
          //   也是阶段4 反馈闭环的硬前置(没版本号, 效果数据混着两版 prompt, 均值没意义)。
          //   bump 规则见 prompt-version.ts。
          promptVersion: ARTICLE_PROMPT_VERSION,
          qualityScore: quality.totalScore,
          qualityPassed: quality.passed,
          aiScore: quality.aiScore,
          hardMetrics: quality.hardMetrics,
          ...(article.titleFallback ? { titleFallback: true } : {}),   // 8-07 见红线 #14
          variationRecipe: article.variationRecipe, // PR-FW 飞轮归因
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
          // PR #241 (5-23): 视频脚本独立字段, 不进 article.body. bridge 取此字段给 DVH 朗读;
          //   缺则 fallback 到 extractNarration(title + body 前 80 字).
          videoScript: article.videoScript,
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
          promptVersion: ARTICLE_PROMPT_VERSION, // 7-28 阶段1-C: 副版本同样落 prompt 版本号
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
          publishIntent: raw.publishIntent
            ? { ...raw.publishIntent, platforms: Array.isArray(raw.publishIntent.platforms) ? raw.publishIntent.platforms : [] }
            : { wantPublish: false, platforms: [], timing: "unspecified" },
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
    personaPrompt: string = "", // PR-X1
    hookScope: string = "", // 7-03 ④: 批次/账号级钩子轮换 scope（只作用于主版本, 副版本不重复计数）
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
          topInstitutions: null, scopeDescription: null, acceptanceDifficulty: null,
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
    const primary = await this.generateJournalRecommendation(requirement, finalJournalData, primaryTemplateId, tenantId, personaPrompt, hookScope);

    // 3. 副版本并行跑（共享 finalJournalData，差异来自 LLM temperature 随机性 + 不同 templateId）
    if (requestedVariants > 1) {
      const subPromises: Array<Promise<{
        article: GeneratedArticle;
        quality: QualityReport;
        outline: ArticleOutline;
      }>> = [];
      for (let i = 1; i < requestedVariants; i++) {
        const tid = templateIds[i] ?? primaryTemplateId;
        subPromises.push(this.generateJournalRecommendation(requirement, finalJournalData, tid, tenantId, personaPrompt));
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
        acceptanceDifficulty: null,
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
   * 去重：按刊名查**共享池 + 本租户自建刊**，命中则不再 INSERT。tenantId 缺时跳过（公开 /try 路径无 tenant）。
   *
   * 7-28 (④) 修去重恒不命中：原来查重条件是 `eq(journals.tenantId, tenantId)`，而线上 8743 本
   *   共享刊的 tenant_id 是 **NULL**，`NULL = 'uuid'` 恒不成立 → 一本早就在共享池里的刊，
   *   每个租户各插一条同名 `ai_fabricated` 影子刊（conf=30 的假数据，还会被选刊/客服看到）。
   *   命中共享池刊时**只跳过、不写**：共享池是全局参考数据，租户侧无权改它的 last_verified_at
   *   （读放宽、写严格）。只有命中自己的刊才刷时间戳。
   */
  async persistAIJournal(aiJournal: JournalInfo, tenantId?: string): Promise<void> {
    if (!tenantId) return; // 公开匿名路径无 tenant，不持久化
    const { eq, and } = await import("drizzle-orm");
    const { journalVisibleTo } = await import("../journals/journal-sql.js");
    const [existing] = await db
      .select({ id: journals.id, tenantId: journals.tenantId })
      .from(journals)
      .where(and(journalVisibleTo(tenantId), eq(journals.name, aiJournal.name)))
      .limit(1);

    if (existing) {
      if (existing.tenantId === null) return; // 共享池已有同名刊 → 不插影子刊, 也不碰它
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
    extraPromptSuffix: string = "", // PR-X1: 账号人设/风格画像 (batch 独家模式注入)
    hookScope: string = "", // 7-03 ④: 钩子轮换 scope（batchId/accountId/tenantId）
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
    //
    // 7-28 修一个恒真条件: 原判据是 `!journal.casPartition`, 而 cas_partition **整库 0 行**(死列),
    //   于是这一项恒为真 → needsEnrichment 恒为真 → **每篇文章都在触发富化**,
    //   白烧一次 LetPub 抓取 + 一次 LLM 调用, 而且从未被发现(它不报错, 只是多花钱多耗时)。
    //   原意图是"缺分区数据就去补", 所以改成判**全部四类分区证据**(单一真相源 PARTITION_FACT_KEYS,
    //   病史见 journals/intl-signal.ts 文件头)。
    //
    // 7-29 补上另一半(上一轮标为"已知限制"的那条):
    //   只有国际体系的刊才该因"缺分区证据"去富化。国内刊客观上没有中科院/JCR 分区,
    //   拿它当富化理由等于永远为真, 而 LetPub/Springer 链路对国内刊本来就抓不到东西
    //   —— 白跑一次抓取 + 一次 LLM。生产实测: cn 3593 本 + unknown 538 本全部命中这一项。
    //   注意: 国内刊仍会因缺 abbreviation / foundingYear / website / coverUrl 触发富化,
    //   那些是抓得到的, 本改动只摘掉"分区"这一条不成立的理由, 不是给国内刊关掉富化。
    const isDomestic = isDomesticKind(toJournalKind(journal));
    const lacksPartitionEvidence = !isDomestic && !hasAnyFact(journal, PARTITION_FACT_KEYS);
    const needsEnrichment = !journal.abbreviation || !journal.foundingYear ||
      lacksPartitionEvidence || !journal.website || !journal.coverUrl;
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
          this.provider,
          // 7-25 backlog-C 治本: enrichment 抓到的**可信源**指标同步回写 journals 表, 让
          //   "喂给 LLM 的数据"与"事后校验读的 DB"变成同一份 —— 骑墙刊(sci-core 标签 + DB 空
          //   + LetPub 有真数据)不再被三道编造闸误判。只填空/不覆盖/打 provenance, 见
          //   persistTrustedJournalFacts。同步执行是必需的: 本次生成后续的六维评分与发布闸
          //   都现查 DB, 异步入队就赶不上这一轮, 误判照旧。
          { writeBackJournalId: (journal as { id?: string }).id ?? null },
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
    // PR-X1: 模板骨架 + 结构变化指令(每次随机) + 账号人设/风格 — 三层正交防同质化
    // PR-FW 飞轮: 按该租户已学到的配方权重加权抽取(无数据则均匀随机)
    let recipeWeights;
    try {
      if (tenantId) {
        const { getRecipeWeights } = await import("../metrics/recipe-learning.js");
        recipeWeights = await getRecipeWeights(tenantId);
      }
    } catch { /* 学习失败不影响生成 */ }
    const variation = buildVariation(recipeWeights);
    const fullSuffix = `${templateAware.suffix}${variation.suffix}${extraPromptSuffix}`;
    const aiContentRaw = await this.generateJournalAIContent(journal, fullSuffix, hookScope);

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
    let wrappedBody = templateAware.styleTag
      ? `<article class="bm-template-${templateAware.styleTag}">${articleBody}</article>`
      : articleBody;

    // 7-03 ②: 图位标记 → 真图/表（模板组装后立即替换; 没数据/编造的标记删除。
    // quality-pipeline 还会幂等地再跑一次, 兜住不走本路径的正文。）
    try {
      const slotResult = applyImageSlots(wrappedBody, journal as unknown as Record<string, unknown>);
      if (slotResult.changed) {
        wrappedBody = slotResult.body;
        logger.info({ inserted: slotResult.inserted, droppedMarkers: slotResult.dropped.length }, "7-03 图位标记替换完成");
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "7-03 图位替换失败(非阻塞), 保留原文");
    }

    const article: GeneratedArticle = {
      title: aiContent.title,
      body: wrappedBody,
      summary: `期刊推荐：${journal.nameEn || journal.name}，IF ${journal.impactFactor || "N/A"}，${journal.casPartition || journal.partition || ""}`,
      tags: ["期刊推荐", journal.discipline || "学术", journal.partition || ""].filter(Boolean),
      wordCount: ArticleSkill.stripHtmlAndCount(wrappedBody),
      videoScript: aiContent.videoScript,
      variationRecipe: variation.recipe, // PR-FW
      // 8-07: 降级标记一路透传到 metadata。链路上有**两处**会把它丢掉
      //   (这里的 article 对象 + batch-worker 的 cherry-pick 白名单), 少补一处标记就落不了库,
      //   观测等于白做。红线 #14 的"可区分"要求, 前提是标记真的到得了 DB。
      ...(aiContent.titleFallback ? { titleFallback: true } : {}),
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
  async generateJournalAIContent(journal: JournalInfo, q3PromptSuffix: string = "", hookScope: string = ""): Promise<AIGeneratedContent> {
    // PR #209: IF<=0 是占位值(非真实IF, 如中文法学刊), 一律当"无IF", 防止泄漏成 "IF 0.0"
    const ifText = (journal.impactFactor != null && journal.impactFactor > 0) ? journal.impactFactor.toFixed(1) : "N/A";
    const journalName = journal.nameEn || journal.name;

    // ---- 标题多元化：随机选择句式风格 ----
    // PR #180: 标题风格重写 — 必含期刊名, 禁模板化句式, 禁无数据评价
    // PR #183 (5-20): (1) 年份动态 currentYear 不再硬编码 2025
    //                 (2) IF 为 null 的期刊不放含 IF 的风格 (避免 "IF N/A" 裸露标题)
    //                 (3) 砍掉容易撞车的固定营销话术, 示例标注"仅供骨架参考, 措辞须重写"
    const currentYear = new Date().getFullYear();
    const hasIF = journal.impactFactor != null && journal.impactFactor > 0;
    const rateText = journal.acceptanceRate != null ? `录用率${(journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100).toFixed(0)}%` : "";
    const cycleText = journal.reviewCycle ? `审稿${journal.reviewCycle}` : "";
    // PR #185 (5-20): 标题第二轮 — 加痛点钩子 (运营反馈"标题太干没吸引力").
    // 钩子戳科研人真实纠结 (该不该投/中国人好发吗/避坑/门槛), 但钩子只能用真实数据,
    // 严禁为吸睛编造分区/录用率/收录状态 (见标题硬约束).
    const disc = journal.discipline || "该领域";
    // ---- 钩子型 (优先, 戳真实纠结) ----
    const titleStyles: string[] = [
      `决策纠结型(钩子)：戳"该不该投"的纠结。示例骨架（措辞必须重写，勿照抄）："${disc}选刊纠结？${journalName} 到底适不适合你投"`,
      `避坑提醒型(钩子)：帮读者投前排雷。示例骨架（措辞必须重写，勿照抄）："投 ${journalName} 之前，这几件事先搞清楚"`,
      `适配人群型(钩子)：点出哪类作者适合。示例骨架（措辞必须重写，勿照抄）："什么样的稿子适合投 ${journalName}？一文说清"`,
      // ---- 钩子型续 (PR #200, 学往期爆款"句式结构", 数据严守真实) ----
      `痛点提问型(钩子)：用读者真实处境提问开场 (经费/毕业/评职/赶时间), 落到该刊适配。示例骨架（措辞必须重写，勿照抄）："赶毕业又怕被拒？${journalName} 适不适合你先看这篇"`,
      `信息差揭秘型(钩子)：点出"投前该知道但很多人不知道"的真实信息 (审稿节奏/收稿偏好/版面费), 不得编造。示例骨架（措辞必须重写，勿照抄）："投 ${disc} SCI 前，${journalName} 这些信息差得先搞清楚"`,
      // ---- 信息型 (保留, 多样性) ----
      `学科盘点型：示例骨架（措辞必须重写，勿照抄）："${disc}领域期刊盘点：${journalName} 的定位与特色"`,
      `趋势分析型：示例骨架（措辞必须重写，勿照抄）："${currentYear}年${disc}投稿趋势与 ${journalName} 适配人群分析"`,
    ];
    // 含 IF 的风格 — 仅当期刊有真 IF 时启用 (否则会写出 "IF N/A")
    if (hasIF) {
      titleStyles.push(
        `门槛评估型(钩子)：戳"我够得着吗"。示例骨架（措辞必须重写，勿照抄）："IF ${ifText} 的 ${journalName}，普通课题组冲得动吗"`,
        `数据亮点型：示例骨架（措辞必须重写，勿照抄）："${journalName} IF ${ifText}：${disc}领域深度盘点"`,
      );
    }
    // 中科院预警名单期刊 — 专属避雷钩子 (基于真实 isWarningList 字段)
    if (journal.isWarningList) {
      titleStyles.push(
        `预警提示型(钩子,仅预警刊)：示例骨架（措辞必须重写，勿照抄）："${journalName} 上了预警名单，现在还能投吗"`,
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

    // ---- PR #202 (5-22): 叙事主线 — 破除"每篇同骨架"的公式感 ----
    // 候选主线按"该刊真有什么数据"动态启用 (诚实, 不为多样性编故事), 再随机选一条。
    // 同一信息让不同期刊从不同视角切入, 多篇文章读起来不雷同。
    const angleCandidates: Array<{ key: string; hint: string }> = [];
    const ifHist = (journal.promptIfHistory as unknown[] | undefined) || undefined;
    if (Array.isArray(ifHist) && ifHist.length >= 3) {
      angleCandidates.push({ key: "趋势主线", hint: "以 IF/影响力的多年走势为主线开篇切入 (涨/跌/稳), 正文重点讲趋势与拐点, 其余信息作支撑。" });
    }
    const apcKnown = (journal as { apcFee?: number | null }).apcFee != null || journal.promptPublicationCosts?.apc != null;
    const acceptHigh = journal.acceptanceRate != null && (journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100) >= 20;
    if (apcKnown && (acceptHigh || journal.reviewCycle)) {
      angleCandidates.push({ key: "性价比主线", hint: "以「投入产出/性价比」为主线 (版面费 vs 录用难度/审稿速度), 帮读者算清这笔账, 不夸大不暗示放水。" });
    }
    if (journal.isWarningList) {
      angleCandidates.push({ key: "避坑主线", hint: "以「投前风险排查」为主线 (预警名单/分区波动), 客观提示风险, 给出审慎建议, 不制造恐慌。" });
    }
    if (journal.discipline && (journal.casPartition || journal.partition)) {
      angleCandidates.push({ key: "定位主线", hint: "以「这本刊在本学科的定位与适配人群」为主线, 讲清它收什么稿、适合哪类作者, 帮读者判断是否对口。" });
    }
    // 兜底主线 (任何刊都成立)
    angleCandidates.push({ key: "盘点主线", hint: "以「一文看懂这本刊」为主线, 把已知的硬数据 (IF/分区/JCR/刊期等) 串成清晰盘点, 客观陈述。" });
    const articleAngle = angleCandidates[Math.floor(Math.random() * angleCandidates.length)];
    const angleHint = `\n【本篇叙事主线】${articleAngle.key} — ${articleAngle.hint}\n  注意: 主线只决定「切入角度和详略」, 不改变数据真实性; 仍严禁编造未提供的数字。`;

    // V7（task #11）：sparse null-skip 单字段拼装。某字段缺数据时不出现在 prompt
    // 里 —— 不要给 LLM "我没数据"的明示，避免它根据缺失暗示编造。
    const enrichmentLines: string[] = [];
    if (journal.promptIfHistory && journal.promptIfHistory.length > 0) {
      enrichmentLines.push(`- 近 10 年 IF 历史：${JSON.stringify(journal.promptIfHistory)}`);
      if (journal.promptIfPredicted) {
        enrichmentLines.push(`- IF 预测：${JSON.stringify(journal.promptIfPredicted)}`);
      }
    }
    // PR #210 (5-22): 砍 OpenAlex 派生不准数据 — CAR(中国学者占比)/引用前10/收稿concepts/学科分布
    //   全部来自 OpenAlex 抽样或 concepts, 准确度极低, 不再喂给 AI(避免它据此编造或扩散噪声).
    //   保留事实型(IF/分区/版面费/录用率/审稿/JCR) — 见下方各 block.
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

    // ===== 7-28 阶段1-C: 字段相关的四个块由**同一份契约**生成 =====
    //   ##已知期刊数据##(能写什么) / ##未公开字段##(禁止提) / ##禁止字段##(黑名单) / 密度要求(必须写)
    //   —— 这四块以前各写各的, 块与块之间零交叉校验, 于是"既禁写又要求写"的矛盾复发了 4 次
    //   (PR #228 / #225 / #233 / 7-28)。LLM 收到矛盾指令的理性选择是编一个 → 被防编造闸拦下
    //   → 转人工待审, 这正是"国内刊文章少 / 待审堆积"的直接成因之一。
    //   现在四块全部出自 buildJournalFieldContract(纯函数, 内含 assertNoContradiction 断言:
    //   requiredFields ∩ forbiddenFields === ∅, 开发期抛错 / 生产期记 incident 并自动修正)。
    //   详见 journal-prompt-fields.ts 头注释。
    const fieldContract = buildJournalFieldContract(journal);
    // 刊名不归字段契约管(它永远可写、永远有值), 单独置顶一行。
    const knownDataLines = [
      `- 名称：${journalName}${journal.abbreviation ? `（${journal.abbreviation}）` : ""}`,
      ...fieldContract.knownLines,
    ];
    const unknownBlock = fieldContract.unknownBlock;
    const blacklistBlock = fieldContract.blacklistBlock;
    // 7-28 阶段1-C 修的实际 bug: 国际刊分支这条密度规则原本是**手写死字符串**
    //   ("每 200 字至少 1 个具体数字(IF/两套分区/审稿周期/录用率/版面费/年发文量)"), 无论 DB
    //   里有没有这些字段一律照点名 —— 与上面 ##未公开字段## 的"完全不要提及"直接对撞。
    //   现在与国内刊分支同源生成: 只点名 densityKeys(= 真有数据 ∩ 没被禁写)。
    const densityRule = fieldContract.densityRule;

    // 7-03 老韩②: 图位标记清单（按本刊真实数据动态生成; 无数据图位不出现在清单里）
    const imageSlotBlock = buildImageSlotPromptBlock(journal as unknown as Record<string, unknown>);

    // 7-21 改动3 + 7-28 修死代码(#2): 国内刊独立生成口径(判定见 buildDomesticJournalGuidance)。
    //   动机(生产实测): 主 prompt 的"每200字1个硬数据(IF/分区/审稿/录用率)"+"标题会挑数字做噱头"
    //   对国内刊是逼编造的死循环 —— 国内核心刊 IF 覆盖 7.8%、分区 0.3%, 根本没有这些数, LLM 只能编。
    //   7-21 那批 11 篇国内刊里 6 篇(54.5%)正文编造被评分器压到红线分。治本 = 换一套国内刊真正有的卖点。
    const isDomesticJournal = fieldContract.isDomestic;
    // 7-21 纯国内刊 = 有中文核心标签(北大核心/CSCD/CSSCI) 且 **不含 sci-core**。
    //   独立于 isDomesticJournal(卖点分支): 后者叠加"无真实 IF", enrichment 给骑墙刊填了 IF 就会
    //   走国际分支; 本判定纯看 catalogs, 定的是"正文分区/IF 禁写"红线的适用范围。
    const isPureDomestic = fieldContract.isPureDomestic;
    const domesticGuidance = fieldContract.domesticGuidance;

    // 7-28 阶段1-C: prompt 按"有名字的块"组装(静态块见文件头部 PROMPT_BLOCK_*)。
    //   用 join("\n") 而不是拼一个大字面量: 块的边界就是换行边界, 增删一块不会牵动别块的空行。
    const prompt = [
      // 角色与任务 + 国内刊专属指引(非国内刊为空串)
      `你是这个学术期刊推荐公众号的小编——替读者翻过这本期刊全部资料的人。你的任务不是写论文摘要，而是用自己的话把这本刊**转述**给读者，边报数据边给你的主观判断。根据以下期刊信息，生成内容。
${domesticGuidance}`,
      // 已知期刊数据 / 未公开字段 / 禁止字段 / 补充数据 —— 全部出自 fieldContract
      `
##已知期刊数据## (文章中所有具体数字必须来自这里, 严禁编造)
${knownDataLines.join("\n")}
${unknownBlock}${blacklistBlock}${enrichmentBlock}`,
      PROMPT_BLOCK_TONE,
      // 排版铁律 + 图位标记清单
      `## 排版铁律 (7-03 短段落 + 图文交替)
1. 所有 HTML 正文字段一律切成**短段落**：每个 <p> 最多 3 句、不超过 100 字；一个意思一段，宁可多段不要长段。
2. 200 字以上的分析章节必须拆成至少 2-3 个 <p>，🚫 严禁整章挤成一个大 <p>。
3. 重点结论/数字用 <strong> 标出（每段最多一处）。
${imageSlotBlock ? `${imageSlotBlock}
- 标记写法：在 scopeDescription / ifHistoryAnalysis / scopeAndCitations / submissionAdvice / recommendation 这些 HTML 字段里，用独立段落 <p>{{IMG:xxx}}</p> 插入。
` : ""}`,
      // 数据密度与卖点兑现(国内/国际同源生成) + 缺失字段纪律 + 结尾行动块 + 分区约束 + 纯国内刊红线
      `## 数据密度与卖点兑现 (7-03 供给侧强化)
${densityRule}
3. 【缺失字段纪律 — 严禁推断制造矛盾】##已知期刊数据## 里没有的字段(如分区/录用率/收录状态空缺), 只能写"暂无数据"或直接不提, **严禁自行推断"未被 WOS/SCIE 收录" / "未标注" / "可能不是SCI" / "或许"等**。尤其: 有中科院分区却推断"未被WOS收录"是自相矛盾的低级错误——有分区就说明被收录, 缺 JCR 数据只写"JCR 分区暂无数据", 不许反推"未收录"。
## 结尾行动块 (7-03 实用性)
文章结尾必须给一个读者"能直接抄走"的行动块(而非空泛结语), 三选二或全给: ① 投稿 checklist(如"投稿前自查: □ 至少2个独立实验的统计分析 □ Cover Letter 突出与 scope 契合 □ 格式按官网模板"); ② 时间线(如"审稿约 X 周 → 大修 Y 周 → 录用"); ③ 避坑三条(该刊常见拒稿雷区)。用真实数据/scope 填充, 缺数据的条目跳过不硬编。
## 分区数据约束 (PR #180)
任何 "分区" / "Q1" / "Q2" / "Q3" / "Q4" / "X区顶刊" 等表述,
必须来自 ##已知期刊数据## 中的 partition 或 jifSubjects[].zone.
若两个字段都 NULL → 文章中**禁止提分区**, 也禁止说"顶刊" / "X区刊"。
${isPureDomestic ? `\n🚫🚫🚫 【纯国内核心刊 — 正文分区/IF 禁写红线, 最高优先级】
本刊是纯国内核心期刊(北大核心/CSSCI/CSCD, 非 SCI), **客观上没有中科院分区、没有 JCR 分区、没有影响因子**。
**正文里一个分区字、一个 IF 数字都不许出现** —— 严禁写 "1区"/"2区"/"3区"/"4区"/"一区/二区/三区/四区"/"中科院X区"/"JCR Qx"/"X区顶刊"/"IF X.X"/"影响因子 X.X"。
不要因为"这类刊感觉该有个分区"就顺手编一个 —— 没有就是没有。写了 = 编造 = 生成后校验立刻揪出来把这篇打成红线分转人工 = 白写一篇还占产能。
（7-21 实测: 人口研究/中国科学物理学 两篇纯国内刊正文各编了个"1区"/"2区", 就栽在这。本刊分区数据栏是空的, 正文提分区必是你编的。）` : ""}`,
      // 标题硬约束
      `
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
11. 【收录状态如实】标题涉及 SCI/SSCI/核心 字样时必须与"收录情况"一致: 上方有明确收录证据(如 WOS SCIE/SSCI)→可用; **没明确证据时**, 标题保持中性, **不得主动写"未被 SCI 收录"/"非 SCI 期刊"这类否定**(我们没数据≠真未收录), 也不得假称"SCI 期刊"(避免拔高)。
12. 【钩子要真】标题可以用提问/悬念制造点击欲 (如"该不该投"、"冲得动吗"、"好中吗"), 但**钩子里的任何数据/判断必须真实**: 严禁为吸睛编造分区(如"1区TOP"当 DB 无分区数据)、录用率、收录状态。无数据的就用开放式提问, 不要给假答案。
13. 【禁夸张营销/禁虚假宣传】禁止"投稿前必看!"、"必看"、"绝了"、"封神"、"神刊"、"水刊"、"包过"、"白嫖"、"放水"、"零门槛"、"灌水"、"捡漏"、"水王"、"稳过"、"轻松发" 等标题党/夸大/暗示放水词汇 (这类词或夸大或暗示造假, 一律禁用; 可学往期爆款的"提问/悬念/盘点"句式结构, 但不得搬用其夸大用词)
14. 【SCIE 称谓正确】SCIE (Science Citation Index Expanded) 是 SCI 的现行官方名称 (Clarivate 2020 起 SCI 统称 SCIE), 二者同义。被 SCIE 收录的期刊就是 SCI 期刊, 标题/正文一律可称"SCI"或"SCI(SCIE)"。**严禁**出现"SCIE 期刊未被 SCI 收录""SCIE 不是 SCI"等错误对立表述。
15. 【禁编造分区/TOP】(PR #229) 任何"几区/Q几/TOP 期刊/大类学科(医学/生物学/工程)"等分区标签 **必须严格来自上方"##已知期刊数据##"中"分区"或"新锐分区"字段**。**两字段都不在或在 ##未公开字段##** 时, 文章里**绝对不能**写"X区"/"Q几"/"TOP"/"大类是X"等任何具体分区表述(包括"投稿建议基于已知数据"这种行内总结)。AI 从训练记忆里调出的分区是禁止的——即便你"知道"这本刊是几区,在我们 DB 没有的情况下也不能写。
16. 【DB 真值原文搬运】(PR #232) 当 ##已知期刊数据## 中"分区"或"新锐分区"字段有值时(标记为 [必须原文搬运]), 文章里提到该字段必须**逐字保留原始字符串**, **绝对不得**:
    - 改数字: DB "3区材料科学" 严禁写成 "2区" / "1区"(即便你"记得"它是几区)
    - 改顺序: DB "3区材料科学" 严禁写成 "材料科学3区" / "材料科学2区"(顺序必须是"X区Y学科"的原样)
    - 简化截取: DB "3区材料科学" 严禁只写 "3区" 而省略"材料科学", 也不得只写"材料科学"省略"3区"
    - 二次格式化: 严禁加"的"/"是"/"为"等连接词重组, 必须整体引用
    正确做法: 原 DB "3区材料科学" → 文章引用必须写 "新锐分区为 3区材料科学" / "该刊属 3区材料科学" 等保留完整原文的句式。这条规则比规则 #15 优先级更高: #15 防"无中生有", #16 防"有中改字"。`,
      // 本次标题风格 / 学科定制 / 叙事主线
      `
【本次标题风格】
${chosenStyle}
${disciplineHint}
${angleHint}`,
      PROMPT_BLOCK_NARRATION,
      PROMPT_BLOCK_DEEP_ANALYSIS,
      PROMPT_BLOCK_VIDEO_SCRIPT,
      PROMPT_BLOCK_OUTPUT_JSON,
    ].join("\n");

    // 5-23 PR #162 Phase 2: 双重硬约束 (system + user 各重复一次) — 防 AI 凭训练记忆编 IF / 录用率 / 创刊年
    const baseSystemPrompt = `你是学术期刊公众号的小编（口吻：第一人称转述+主观判断，禁论文腔）兼期刊数据分析专家（纪律：数据只认给定真值），输出严格JSON格式。

##硬规则##
1. 文章中所有具体数字 **以及分区/学科标签** 必须来自 user 消息 ##已知期刊数据## 段, 严禁从训练记忆调任何数字 / 年份 / 国家 / 价格 / **分区(如"1区"/"Q1"/"医学1区TOP"/"生物学1区TOP")** / **学科大类(如"医学"/"生物学"/"工程技术")** / TOP 标记 / SCIE/SSCI 收录状态等任何具体数据点。**(PR #232)** 当 ##已知期刊数据## 已给出"分区"/"新锐分区"字段时, 引用时必须**逐字原文搬运**(包括"X区"和学科名的顺序、数字、字符), 严禁基于训练记忆改写、调换"X区"和学科的顺序、改数字或仅截取部分
2. 未在 ##已知期刊数据## 出现的字段, 严禁虚构, 用兜底语代替
3. **特别注意 — 以下 4 字段是 BossMate database 没有的数据 (backfill 实测 0 源覆盖):**
   - **创刊年**: 禁止提具体年份, 若必须涉及用"历史悠久的"等模糊词
   - **出版国 / 出版地**: 禁止具体国家名, 用"国际期刊""业内"等中性词
   - **具体录用率百分比**: 禁止 "录用率 48%" 类表述, 仅允许"较高/较低/适中"
   - **具体审稿周数**: 禁止 "审稿 5-8 周" 类表述 (除非 ##已知期刊数据## 给了 reviewCycle), 仅允许"较快/较慢/标准"
4. 违反 → validator 拦截 + hasWarnings=true → 文章排除推荐池, 浪费 token`;
    // P0②③预防(7-03): recommendation/scope 开头注入钩子模式 + 全字段禁 AI 腔套话
    // 只挑 1 个模式给模板路径(标题已有自己的钩子体系, 这里管的是正文开头两句)
    // 7-03 ④: 批次内钩子轮换 — 同 scope(批次/账号)当天每个模式限用 2 次, 用满剔除并注入禁选清单(治"全员闭眼冲")
    const HOOK_SCOPE_LIMIT = 2;
    let hookPick: ReturnType<typeof pickHookPatterns>[number] | undefined;
    let hookBanLine = "";
    if (env.ARTICLE_HOOK_INJECT !== "false") {
      const candidates = pickHookPatterns(journal.discipline || undefined, 8);
      if (hookScope) {
        const banned = exhaustedKeys(hookScope, candidates.map((c) => c.name), HOOK_SCOPE_LIMIT);
        const fresh = candidates.filter((c) => usageCount(hookScope, c.name) < HOOK_SCOPE_LIMIT);
        hookPick = fresh[0] ?? candidates[0]; // 全用满时兜底随机(退回旧行为)
        if (hookPick) recordUsage(hookScope, hookPick.name);
        const bannedShow = banned.filter((b) => b !== hookPick?.name);
        if (bannedShow.length > 0) hookBanLine = `\n【钩子轮换】以下开头模式本批次/今天已用满, 禁止再用其结构开头: ${bannedShow.join("、")}。`;
      } else {
        hookPick = candidates[0];
      }
    }
    // 7-03 A: 主钩子落 openingHook(区块0, 评分器读的"开头"); recommendation 结尾再带一句作 CTA 复读位(无害, 非主钩子)。
    const p0Suffix = `${hookPick ? `\n【开头钩子·主】openingHook 字段按【${hookPick.name}】模式写 2-3 句: ${hookPick.structure} 用痛点场景切入、小编口吻, 🚫 禁止"该刊是一本…"式平铺开场。\n【结尾钩子·复读】recommendation 收尾可呼应同一痛点做行动号召(CTA), 但主钩子在 openingHook, 别把开场留空。` : ""}${hookBanLine}${buildClicheBanPrompt(20)}`;
    const finalSystemPrompt = q3PromptSuffix ? `${baseSystemPrompt}${q3PromptSuffix}${p0Suffix}` : `${baseSystemPrompt}${p0Suffix}`;

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
      assertRealAiOutput(result, "generateJournalRecommendation");

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
        // 重生这一次同样要问 —— 第一次成功、重生时服务挂了, 结果一样是废稿。
        assertRealAiOutput(result, "generateJournalRecommendation.retry");
      }

      // 8-07 ② 换成共享 JSON 修复器(唯一归宿, services/content-engine/llm-json.ts)。
      //   原来这里是自己手写的 `content.match(/\{[\s\S]*\}/)` —— 而 llm-json.ts 的文件头
      //   记着这一行对推理型模型不够(思维链/```围栏/中途插解释都会混进来), 六维评分
      //   曾因同一个坑单日 28 次不可解析、历史累计 192 次。修复器修过的坑, 这里原样又踩了一遍。
      //   ⚠️ 但它救不了**截断** —— 没有闭合的 `}` 就没有完整对象可取, 那种情况必须在
      //     客户端层按 finishReason 拦(见下方观测)。
      const extracted = extractJsonObject(result.content);
      if (extracted.value) {
        const parsed = extracted.value as Record<string, any>;
        return {
          title: parsed.title || `期刊推荐：${journalName}`,
          openingHook: typeof parsed.openingHook === "string" && parsed.openingHook.trim().length > 0 ? parsed.openingHook.trim() : undefined, // 7-03 A 区块0
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
          // PR #241: 视频脚本独立字段, 不进图文 body, 仅供 article-bridge 取出给 DVH 朗读.
          videoScript: typeof parsed.videoScript === "string" && parsed.videoScript.trim().length > 0
            ? parsed.videoScript.trim().slice(0, 600)  // PR #241 v2: 上限 600 字 (目标 250-350, buffer 至 600 防 AI 略超)
            : undefined,
        };
      }
      // 8-07 ① 【观测】走到这里 = 拿到了返回但抽不出 JSON。
      //   原来这条路径**完全静默**: try 块正常走完、不抛异常、不进 catch、不打任何日志,
      //   直接掉到下面的兜底 return。实测代价: 08-04 起连续三天, 走本函数的内容
      //   **100% 兜底**(80 篇, videoScript 命中 0/80、深度章节 0/80), 而日志只有 7 条
      //   —— 那 7 条是 JSON.parse 抛错的, 其余全部无声无息。
      //   这是第六次「降级产物与真产物不可区分」(见 CLAUDE.md 红线 #14), 而且是最隐蔽的一次:
      //   连"故障发生过"这件事都没留下痕迹, 8-05 刚建的失败分类/自动重跑根本收不到它。
      logger.error({
        journal: journal.name,
        // 修法完全取决于失败形态, 所以原始返回要留证:
        //   markdown 围栏包着 JSON → 提取器问题; 文本正确但无 JSON → prompt 约束失效;
        //   截断 → maxTokens; 拒答/空返回/限流错误文本 → 模型或额度问题
        rawHead: String(result?.content ?? "").slice(0, 500),
        rawLength: String(result?.content ?? "").length,
        finishReason: result?.finishReason ?? null,   // "max_tokens" = 截断, 一眼定性
        outputTokens: result?.outputTokens ?? null,
        model: `${result?.model ?? "?"}`,             // 进程内实际用的模型, 不是 .env 文件
        repairsTried: extracted?.repairs ?? [],
      }, "🔴 期刊推荐 JSON 抽取失败 — 本篇走兜底标题(内容缺深度章节与视频脚本)");
    } catch (err) {
      // 🔴 AI 主备全挂 ≠ 这篇内容有问题 —— 不许在这里被洗成兜底成品。
      //   放它出去, failure-kind 判 service_down → deferred → 服务恢复后自动重跑。
      if (isAiUnavailableError(err)) throw err;
      logger.warn({ err, journal: journal.name }, "AI 生成期刊推荐内容失败");
    }

    // 降级：使用基本信息
    // 8-07 ③ 删掉原来的 `rating: 4` —— 失败路径不该产出一个像模像样的评分。
    //   硬编码 4 星是"兜底越完整越危险"的典型: 它让下游完全看不出这篇是降级产物。
    //   titleFallback 标记落 metadata, 从此兜底率一条查询就能查, 不用再靠句式指纹考古。
    return {
      title: `期刊推荐：${journalName}，影响因子 ${ifText}`,
      scopeDescription: journal.scopeDescription || "",
      recommendation: "",
      titleFallback: true,
    };
  }
}
