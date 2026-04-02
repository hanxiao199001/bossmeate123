/**
 * 知识库冷启动流程
 * 6步：行业模板 → 种子竞品 → 内容爬取 → AI分析 → 关键词初始化 → IP问卷
 */

import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { competitors, keywords, industryKeywords } from "../../models/schema.js";
import { eq } from "drizzle-orm";
import { createEntries, type CreateKnowledgeInput } from "./knowledge-service.js";
import { runBatchAudit } from "./audit-pipeline.js";
import { crawlAll } from "../crawler/index.js";
import type { VectorCategory } from "./vector-store.js";

// ============ 冷启动状态 ============

export interface ColdStartProgress {
  tenantId: string;
  currentStep: number;
  totalSteps: 6;
  steps: StepResult[];
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
}

export interface StepResult {
  step: number;
  name: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed";
  itemCount?: number;
  message?: string;
}

export interface ColdStartConfig {
  tenantId: string;
  industry: string;              // 行业：医学 | 教育 | 科技 | 金融 | ...
  subIndustry?: string;          // 子领域
  seedCompetitors?: string[];    // 种子竞品账号列表
  platforms?: string[];          // 目标平台（默认全选）
  ipQuestionnaire?: IPQuestionnaire;
}

export interface IPQuestionnaire {
  brandName: string;             // 品牌/IP 名称
  targetAudience: string;        // 目标受众描述
  toneOfVoice: string;           // 语气调性：专业严谨 | 轻松幽默 | 权威感 | ...
  contentGoals: string[];        // 内容目标：获客 | 品牌 | 教育 | ...
  tabooTopics?: string[];        // 禁忌话题
  referenceAccounts?: string[];  // 参考对标账号
}

// ============ 行业模板种子数据 ============

interface IndustryTemplate {
  terms: Array<{ title: string; content: string }>;
  redlines: Array<{ title: string; content: string }>;
  audiences: Array<{ title: string; content: string }>;
  platformRules: Array<{ title: string; content: string }>;
}

const INDUSTRY_TEMPLATES: Record<string, IndustryTemplate> = {
  医学: {
    terms: [
      { title: "SCI期刊", content: "Science Citation Index，科学引文索引，是全球公认的自然科学领域最权威的文献检索工具之一。SCI收录期刊分为Q1-Q4四个分区，影响因子(IF)是衡量期刊学术影响力的核心指标。" },
      { title: "影响因子", content: "Impact Factor (IF)，由 Clarivate Analytics 发布，计算方式为某期刊前两年发表论文在统计年被引用的总次数除以该期刊前两年发表论文总数。影响因子越高，期刊的学术影响力越大。" },
      { title: "Meta分析", content: "Meta-analysis，荟萃分析，对同一主题的多项独立研究结果进行系统的定量综合分析。在循证医学中被视为最高级别的证据等级。" },
    ],
    redlines: [
      { title: "医疗广告法合规", content: "禁止在非医疗专业内容中出现具体疗效承诺、治愈率数据、患者个人隐私信息。不得替代医嘱，所有健康建议须标注「仅供参考，请遵医嘱」。" },
      { title: "学术诚信红线", content: "严禁数据造假、图片篡改、一稿多投、抄袭他人成果。引用数据必须标明出处，统计方法必须规范。涉及动物/人体实验须注明伦理审批号。" },
    ],
    audiences: [
      { title: "科研人员画像", content: "目标人群：高校及科研院所的硕博研究生、青年教师、独立PI。核心痛点：论文写作效率低、选刊困难、影响因子焦虑。触达渠道：微信公众号、知乎学术区、小红书学术分享。" },
      { title: "B2B医药企业画像", content: "目标人群：医药企业学术推广经理、医学部MSL、品牌市场经理。核心需求：学术论文辅助写作、竞品文献监控、KOL关系管理。决策链：部门经理→学术总监→VP。" },
    ],
    platformRules: [
      { title: "微信公众号医学内容规则", content: '医疗类内容需遵守《互联网广告管理办法》，不得出现「保证治愈」等绝对化用语。敏感词包括：偏方、秘方、祖传、100%有效。推荐使用科普形式，标注免责声明。' },
      { title: "小红书医学内容规则", content: "健康类笔记不得包含诊断建议、用药推荐。推荐使用经验分享+免责标注形式。标签建议：#学术干货 #科研日常 #论文写作。" },
    ],
  },
  教育: {
    terms: [
      { title: "核心素养", content: "Core Competencies，指学生应具备的能够适应终身发展和社会发展需要的必备品格和关键能力。包括文化基础、自主发展、社会参与三大方面。" },
      { title: "STEAM教育", content: "Science, Technology, Engineering, Arts, Mathematics 的缩写，强调跨学科融合、项目式学习和创新思维培养。在K12和高等教育中广泛应用。" },
    ],
    redlines: [
      { title: "教育广告合规", content: "不得对升学、通过考试、获得学位等作出明示或暗示的保证性承诺。不得利用学术机构、教育主管部门名义进行推荐。" },
    ],
    audiences: [
      { title: "教育从业者画像", content: "目标人群：K12教师、教育培训机构运营者、教育科技公司产品经理。核心痛点：课程设计效率、学生engagement、教学成果量化。" },
    ],
    platformRules: [
      { title: "微信公众号教育内容规则", content: '教育类内容避免虚假宣传，不使用「名师」「顶级」等无法验证的用语。课程推广需标注广告。' },
    ],
  },
};

// 通用模板（行业未匹配时使用）
const DEFAULT_TEMPLATE: IndustryTemplate = {
  terms: [
    { title: "ROI", content: "Return on Investment，投资回报率。衡量营销投入产出比的核心指标。计算公式：(收益-成本)/成本 × 100%。" },
    { title: "SEO", content: "Search Engine Optimization，搜索引擎优化。通过优化内容质量、关键词布局、站内结构等提升搜索引擎排名和自然流量。" },
  ],
  redlines: [
    { title: "广告法通用红线", content: '禁止使用「最佳」「第一」「国家级」等极限词。不得虚假宣传、引人误解。对比广告需有事实依据。' },
  ],
  audiences: [
    { title: "中小企业主画像", content: "目标人群：中小企业创始人/合伙人、市场负责人。核心痛点：获客成本高、品牌知名度低、内容产出效率低。决策特征：注重性价比，偏好有案例佐证的方案。" },
  ],
  platformRules: [
    { title: "微信公众号通用规则", content: "文章推送频次建议：服务号每月4次，订阅号每天1次。标题字数18-22字为佳，避免标题党。" },
  ],
};

// ============ 6 步冷启动执行 ============

/**
 * 执行冷启动流程
 */
export async function runColdStart(
  config: ColdStartConfig,
  onProgress?: (progress: ColdStartProgress) => void
): Promise<ColdStartProgress> {
  const progress: ColdStartProgress = {
    tenantId: config.tenantId,
    currentStep: 0,
    totalSteps: 6,
    steps: Array.from({ length: 6 }, (_, i) => ({
      step: i + 1,
      name: [
        "行业模板导入",
        "种子竞品录入",
        "内容爬取触发",
        "AI 分析生成",
        "关键词初始化",
        "IP 问卷入库",
      ][i],
      status: "pending" as const,
    })),
    status: "running",
  };

  const notify = () => onProgress?.(progress);

  try {
    // ====== 步骤 1：行业模板导入 ======
    progress.currentStep = 1;
    progress.steps[0].status = "running";
    notify();

    const step1Count = await step1IndustryTemplates(config);
    progress.steps[0].status = "completed";
    progress.steps[0].itemCount = step1Count;
    progress.steps[0].message = `导入 ${step1Count} 条行业种子知识`;
    notify();

    // ====== 步骤 2：种子竞品录入 ======
    progress.currentStep = 2;
    progress.steps[1].status = "running";
    notify();

    const step2Count = await step2SeedCompetitors(config);
    progress.steps[1].status = step2Count > 0 ? "completed" : "skipped";
    progress.steps[1].itemCount = step2Count;
    progress.steps[1].message = step2Count > 0
      ? `录入 ${step2Count} 个种子竞品`
      : "未提供种子竞品，跳过";
    notify();

    // ====== 步骤 3：内容爬取触发 ======
    progress.currentStep = 3;
    progress.steps[2].status = "running";
    notify();

    const step3Count = await step3TriggerCrawl(config);
    progress.steps[2].status = "completed";
    progress.steps[2].itemCount = step3Count;
    progress.steps[2].message = `已触发 ${step3Count} 个爬取任务（异步执行）`;
    notify();

    // ====== 步骤 4：AI 分析生成洞察 ======
    progress.currentStep = 4;
    progress.steps[3].status = "running";
    notify();

    const step4Count = await step4AIAnalysis(config);
    progress.steps[3].status = "completed";
    progress.steps[3].itemCount = step4Count;
    progress.steps[3].message = `生成 ${step4Count} 条洞察知识`;
    notify();

    // ====== 步骤 5：关键词初始化 ======
    progress.currentStep = 5;
    progress.steps[4].status = "running";
    notify();

    const step5Count = await step5InitKeywords(config);
    progress.steps[4].status = "completed";
    progress.steps[4].itemCount = step5Count;
    progress.steps[4].message = `初始化 ${step5Count} 个行业关键词`;
    notify();

    // ====== 步骤 6：IP 问卷入库 ======
    progress.currentStep = 6;
    progress.steps[5].status = "running";
    notify();

    const step6Count = await step6IPQuestionnaire(config);
    progress.steps[5].status = step6Count > 0 ? "completed" : "skipped";
    progress.steps[5].itemCount = step6Count;
    progress.steps[5].message = step6Count > 0
      ? "IP 定位信息已入库"
      : "未提供 IP 问卷，跳过";
    notify();

    progress.status = "completed";
    logger.info(
      { tenantId: config.tenantId, industry: config.industry },
      "冷启动完成"
    );
  } catch (err) {
    progress.status = "failed";
    progress.error = err instanceof Error ? err.message : String(err);
    const failedStep = progress.steps.find((s) => s.status === "running");
    if (failedStep) failedStep.status = "failed";
    logger.error(err, "冷启动失败");
  }

  notify();
  return progress;
}

// ============ 各步骤实现 ============

/**
 * 步骤1：根据行业导入种子模板到向量库
 */
async function step1IndustryTemplates(config: ColdStartConfig): Promise<number> {
  const template = INDUSTRY_TEMPLATES[config.industry] || DEFAULT_TEMPLATE;
  const { tenantId, industry } = config;
  const source = `cold-start:industry-template:${industry}`;

  const inputs: CreateKnowledgeInput[] = [
    ...template.terms.map((t) => ({
      tenantId,
      category: "term" as const,
      title: t.title,
      content: t.content,
      source,
      metadata: { industry, coldStart: true },
    })),
    ...template.redlines.map((t) => ({
      tenantId,
      category: "redline" as const,
      title: t.title,
      content: t.content,
      source,
      metadata: { industry, coldStart: true },
    })),
    ...template.audiences.map((t) => ({
      tenantId,
      category: "audience" as const,
      title: t.title,
      content: t.content,
      source,
      metadata: { industry, coldStart: true },
    })),
    ...template.platformRules.map((t) => ({
      tenantId,
      category: "platform_rule" as const,
      title: t.title,
      content: t.content,
      source,
      metadata: { industry, coldStart: true },
    })),
  ];

  const entries = await createEntries(inputs);
  logger.info({ count: entries.length, industry }, "步骤1: 行业模板导入");
  return entries.length;
}

/**
 * 步骤2：录入种子竞品账号到 PG
 */
async function step2SeedCompetitors(config: ColdStartConfig): Promise<number> {
  if (!config.seedCompetitors || config.seedCompetitors.length === 0) return 0;

  const platforms = config.platforms || ["wechat"];
  let count = 0;

  for (const accountName of config.seedCompetitors) {
    for (const platform of platforms) {
      await db.insert(competitors).values({
        tenantId: config.tenantId,
        accountId: accountName,
        accountName,
        platform,
        crawlDate: new Date().toISOString().slice(0, 10),
        metadata: { coldStart: true, industry: config.industry },
      });
      count++;
    }
  }

  logger.info({ count }, "步骤2: 种子竞品录入");
  return count;
}

/**
 * 步骤3：触发内容爬取（异步执行，不阻塞冷启动流程）
 */
async function step3TriggerCrawl(config: ColdStartConfig): Promise<number> {
  const platforms = config.platforms || ["wechat", "zhihu", "xiaohongshu"];
  const tasks = platforms.map((p) => ({
    platform: p,
    industry: config.industry,
    tenantId: config.tenantId,
    type: "cold_start_crawl",
  }));

  // 异步触发爬取，不等待结果（避免阻塞 HTTP 响应）
  setImmediate(async () => {
    try {
      logger.info({ platforms }, "冷启动爬取任务开始执行");
      await crawlAll();
      logger.info({ platforms }, "冷启动爬取任务执行完成");
    } catch (err) {
      logger.error(err, "冷启动爬取任务执行失败（不影响冷启动结果）");
    }
  });

  logger.info({ platforms, taskCount: tasks.length }, "步骤3: 爬取任务已异步触发");
  return tasks.length;
}

/**
 * 步骤4：AI 分析生成初始洞察
 * 基于步骤1的模板数据生成 insight 类知识
 */
async function step4AIAnalysis(config: ColdStartConfig): Promise<number> {
  const { tenantId, industry } = config;

  // 生成行业基础洞察条目
  const insights: CreateKnowledgeInput[] = [
    {
      tenantId,
      category: "insight",
      title: `${industry}行业内容策略基础洞察`,
      content: `${industry}行业内容营销核心策略：1) 专业内容建立信任感；2) 数据驱动选题，关注行业热点与受众痛点交叉区；3) 差异化定位避开红海竞争；4) 多平台适配分发，根据平台特性调整内容形式。`,
      source: `cold-start:ai-analysis:${industry}`,
      metadata: { industry, coldStart: true, type: "strategy" },
    },
    {
      tenantId,
      category: "insight",
      title: `${industry}行业内容形式推荐`,
      content: `${industry}行业推荐内容形式：1) 深度长文（公众号/知乎）适合专业解读；2) 短视频科普（抖音/小红书）适合泛流量获取；3) 案例拆解（全平台）适合建立专业形象；4) 白皮书/报告（官网/公众号）适合B2B获客。`,
      source: `cold-start:ai-analysis:${industry}`,
      metadata: { industry, coldStart: true, type: "content_format" },
    },
  ];

  const { accepted } = await runBatchAudit(
    insights.map((i) => ({
      tenantId: i.tenantId,
      category: i.category as VectorCategory,
      title: i.title,
      content: i.content,
      source: i.source,
      metadata: i.metadata,
    }))
  );

  logger.info({ count: accepted.length }, "步骤4: AI 分析洞察生成");
  return accepted.length;
}

/**
 * 步骤5：初始化行业关键词到 industry_keywords 表和向量库
 */
async function step5InitKeywords(config: ColdStartConfig): Promise<number> {
  const { tenantId, industry } = config;

  // 行业通用种子关键词
  const INDUSTRY_SEED_KEYWORDS: Record<string, string[]> = {
    医学: ["SCI论文", "影响因子", "核心期刊", "论文写作", "学术发表", "投稿", "审稿周期", "开源期刊", "文献综述", "研究方法"],
    教育: ["核心素养", "新课标", "教学设计", "STEAM", "项目式学习", "双减", "素质教育", "教育信息化", "课程改革", "AI教育"],
  };

  const seedWords = INDUSTRY_SEED_KEYWORDS[industry] || [
    "行业趋势", "内容营销", "品牌建设", "获客", "私域流量",
    "短视频", "直播", "SEO", "数据分析", "用户增长",
  ];

  // 写入 industry_keywords 表
  let count = 0;
  for (const word of seedWords) {
    try {
      await db.insert(industryKeywords).values({
        tenantId,
        word,
        level: "primary",
        category: industry,
        weight: 1.0,
        isSystem: true,
        isActive: true,
        source: "cold_start",
      });
      count++;
    } catch {
      // 忽略唯一索引冲突（重复执行冷启动）
    }
  }

  // 同步写入向量库（keyword 分区）
  const keywordEntries: CreateKnowledgeInput[] = seedWords.map((word) => ({
    tenantId,
    category: "keyword" as const,
    title: word,
    content: `${industry}行业关键词: ${word}`,
    source: `cold-start:keyword-init:${industry}`,
    metadata: { industry, coldStart: true, level: "primary" },
  }));

  await createEntries(keywordEntries);

  logger.info({ count, industry }, "步骤5: 关键词初始化");
  return count;
}

/**
 * 步骤6：IP 问卷数据入库
 */
async function step6IPQuestionnaire(config: ColdStartConfig): Promise<number> {
  if (!config.ipQuestionnaire) return 0;

  const { tenantId } = config;
  const q = config.ipQuestionnaire;

  // 写入 style 分区（IP 风格模板）
  const styleEntry: CreateKnowledgeInput = {
    tenantId,
    category: "style",
    title: `${q.brandName} IP 风格定位`,
    content: [
      `品牌名称: ${q.brandName}`,
      `目标受众: ${q.targetAudience}`,
      `语气调性: ${q.toneOfVoice}`,
      `内容目标: ${q.contentGoals.join("、")}`,
      q.tabooTopics?.length ? `禁忌话题: ${q.tabooTopics.join("、")}` : "",
      q.referenceAccounts?.length ? `参考账号: ${q.referenceAccounts.join("、")}` : "",
    ].filter(Boolean).join("\n"),
    source: "cold-start:ip-questionnaire",
    metadata: {
      coldStart: true,
      questionnaire: q,
    },
  };

  // 禁忌话题写入 redline 分区
  const redlineEntries: CreateKnowledgeInput[] = (q.tabooTopics || []).map(
    (topic) => ({
      tenantId,
      category: "redline" as const,
      title: `IP禁忌: ${topic}`,
      content: `品牌 ${q.brandName} 的内容红线：禁止涉及"${topic}"相关话题。来源：IP定位问卷。`,
      source: "cold-start:ip-questionnaire",
      metadata: { coldStart: true, brandName: q.brandName },
    })
  );

  // 受众画像写入 audience 分区
  const audienceEntry: CreateKnowledgeInput = {
    tenantId,
    category: "audience",
    title: `${q.brandName} 目标受众画像`,
    content: `品牌 ${q.brandName} 的目标受众: ${q.targetAudience}。内容目标: ${q.contentGoals.join("、")}。调性要求: ${q.toneOfVoice}。`,
    source: "cold-start:ip-questionnaire",
    metadata: { coldStart: true, brandName: q.brandName },
  };

  const allEntries = [styleEntry, audienceEntry, ...redlineEntries];
  await createEntries(allEntries);

  logger.info({ brandName: q.brandName, entryCount: allEntries.length }, "步骤6: IP 问卷入库");
  return allEntries.length;
}
