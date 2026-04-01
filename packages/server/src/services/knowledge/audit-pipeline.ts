/**
 * 知识入库审核管线
 * 5 道审核：相关度 → 质量 → 入库原因 → 向量去重 → 时效标记
 * 全部通过后自动入库
 */

import { logger } from "../../config/logger.js";
import { getEmbedding } from "./embedding-service.js";
import { searchVectors, type VectorCategory } from "./vector-store.js";
import { createEntry, type CreateKnowledgeInput } from "./knowledge-service.js";

// ============ 审核结果类型 ============

export interface AuditResult {
  pass: boolean;
  stage: string;
  reason: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface PipelineResult {
  accepted: boolean;
  stages: AuditResult[];
  entry?: { id: string };
  timeliness?: TimelinessTag;
}

export type TimelinessTag = "permanent" | "long_term" | "short_term" | "ephemeral";

export interface AuditInput {
  tenantId: string;
  category: VectorCategory;
  title: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

// ============ 阈值配置 ============

const THRESHOLDS = {
  /** 相关度：内容与分区的最低相关度 */
  RELEVANCE_MIN_LENGTH: 20,
  RELEVANCE_MIN_KEYWORDS: 1,

  /** 质量：最低内容质量 */
  QUALITY_MIN_LENGTH: 50,
  QUALITY_MAX_REPEAT_RATIO: 0.5,

  /** 向量去重：与已有条目的相似度阈值，超过则判定为重复 */
  DEDUP_SIMILARITY_THRESHOLD: 0.92,

  /** 时效性：默认标签 */
  DEFAULT_TIMELINESS: "long_term" as TimelinessTag,
};

// ============ 分区关键词表（相关度审核用）============

const CATEGORY_KEYWORDS: Record<VectorCategory, string[]> = {
  term: ["术语", "定义", "概念", "名词", "词汇", "释义", "专业词", "行话", "缩写", "term", "glossary"],
  redline: ["红线", "禁止", "违规", "合规", "底线", "不得", "严禁", "敏感词", "审核", "风险", "法律"],
  audience: ["人群", "画像", "受众", "用户", "客户", "B2B", "目标群体", "痛点", "需求", "决策者", "采购"],
  content_format: ["图文", "视频", "直播", "短视频", "长文", "海报", "白皮书", "案例", "拆解", "形式", "格式"],
  keyword: ["关键词", "热词", "语义", "搜索词", "长尾词", "SEO", "话题", "标签", "热度"],
  style: ["风格", "IP", "人设", "调性", "语气", "模板", "口吻", "品牌", "视觉", "排版"],
  platform_rule: ["平台", "规则", "算法", "推荐", "限流", "微信", "抖音", "小红书", "知乎", "B站", "头条"],
  insight: ["洞察", "策略", "趋势", "分析", "机会", "数据", "复盘", "方法论", "行业"],
  hot_event: ["热点", "事件", "热搜", "突发", "舆情", "trending", "刷屏", "爆款", "出圈"],
  domain_knowledge: ["领域", "行业", "专业", "知识", "学科", "期刊", "论文", "研究", "技术", "标准"],
};

// ============ 5 道审核 ============

/**
 * 第 1 道：相关度审核
 * 检查内容是否与目标分区相关
 */
function auditRelevance(input: AuditInput): AuditResult {
  const stage = "relevance";

  // 长度检查
  if (input.content.length < THRESHOLDS.RELEVANCE_MIN_LENGTH) {
    return { pass: false, stage, reason: `内容过短（${input.content.length} 字符，最低 ${THRESHOLDS.RELEVANCE_MIN_LENGTH}）` };
  }

  // 关键词命中检查
  const keywords = CATEGORY_KEYWORDS[input.category];
  const text = `${input.title} ${input.content}`.toLowerCase();
  const hits = keywords.filter((kw) => text.includes(kw.toLowerCase()));

  if (hits.length < THRESHOLDS.RELEVANCE_MIN_KEYWORDS) {
    return {
      pass: false,
      stage,
      reason: `与分区 [${input.category}] 相关性不足，未命中任何关键词`,
      metadata: { checkedKeywords: keywords.length, hits: hits.length },
    };
  }

  return {
    pass: true,
    stage,
    reason: `命中 ${hits.length} 个关键词`,
    score: hits.length / keywords.length,
    metadata: { hitKeywords: hits },
  };
}

/**
 * 第 2 道：质量审核
 * 检查内容质量（长度、重复率、可读性）
 */
function auditQuality(input: AuditInput): AuditResult {
  const stage = "quality";
  const content = input.content;

  // 最低长度
  if (content.length < THRESHOLDS.QUALITY_MIN_LENGTH) {
    return {
      pass: false,
      stage,
      reason: `内容过短（${content.length} 字符，最低 ${THRESHOLDS.QUALITY_MIN_LENGTH}）`,
    };
  }

  // 重复率检测（按句子分割，计算重复句子比例）
  const sentences = content
    .split(/[。！？.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  if (sentences.length > 0) {
    const uniqueSentences = new Set(sentences);
    const repeatRatio = 1 - uniqueSentences.size / sentences.length;

    if (repeatRatio > THRESHOLDS.QUALITY_MAX_REPEAT_RATIO) {
      return {
        pass: false,
        stage,
        reason: `重复率过高（${(repeatRatio * 100).toFixed(1)}%，上限 ${THRESHOLDS.QUALITY_MAX_REPEAT_RATIO * 100}%）`,
        score: 1 - repeatRatio,
      };
    }
  }

  // 标题检查
  if (!input.title || input.title.trim().length === 0) {
    return { pass: false, stage, reason: "缺少标题" };
  }

  return {
    pass: true,
    stage,
    reason: "质量检查通过",
    score: Math.min(content.length / 500, 1), // 粗略质量分
  };
}

/**
 * 第 3 道：入库原因审核
 * 记录入库动机，确保每条知识都有明确的入库理由
 */
function auditReason(input: AuditInput): AuditResult {
  const stage = "reason";

  // 必须有来源
  if (!input.source || input.source.trim().length === 0) {
    return { pass: false, stage, reason: "缺少数据来源（source 字段为空）" };
  }

  // 自动推断入库理由
  const reasons: string[] = [];

  if (input.source.startsWith("http")) {
    reasons.push("外部网页抓取");
  } else if (input.source.includes("crawl")) {
    reasons.push("爬虫自动入库");
  } else if (input.source.includes("manual") || input.source.includes("user")) {
    reasons.push("人工录入");
  } else if (input.source.includes("api")) {
    reasons.push("API 导入");
  } else {
    reasons.push("自动入库");
  }

  return {
    pass: true,
    stage,
    reason: reasons.join("，"),
    metadata: { ingestReasons: reasons, source: input.source },
  };
}

/**
 * 第 4 道：向量去重审核
 * 检查是否已存在高度相似的条目
 */
async function auditDedup(input: AuditInput): Promise<AuditResult> {
  const stage = "dedup";

  const embeddingText = `${input.title}\n${input.content}`;
  const { vector } = await getEmbedding(embeddingText);

  const similar = await searchVectors({
    vector,
    tenantId: input.tenantId,
    category: input.category,
    limit: 3,
  });

  if (similar.length === 0) {
    return { pass: true, stage, reason: "无重复条目" };
  }

  const topMatch = similar[0];
  const similarity = 1 / (1 + topMatch._distance);

  if (similarity >= THRESHOLDS.DEDUP_SIMILARITY_THRESHOLD) {
    return {
      pass: false,
      stage,
      reason: `与已有条目高度相似（相似度 ${(similarity * 100).toFixed(1)}%）`,
      score: similarity,
      metadata: {
        duplicateId: topMatch.id,
        duplicateTitle: topMatch.title,
        similarity,
      },
    };
  }

  return {
    pass: true,
    stage,
    reason: `最高相似度 ${(similarity * 100).toFixed(1)}%，低于去重阈值`,
    score: similarity,
  };
}

/**
 * 第 5 道：时效标记
 * 根据内容特征自动标记时效性（始终通过，仅做标记）
 */
function auditTimeliness(input: AuditInput): AuditResult & { tag: TimelinessTag } {
  const stage = "timeliness";
  const text = `${input.title} ${input.content}`.toLowerCase();

  // 时效性特征词
  const ephemeralPatterns = ["今日", "今天", "刚刚", "breaking", "速报", "快讯"];
  const shortTermPatterns = ["本周", "本月", "近日", "最新", "最近", "hot", "trending"];
  const permanentPatterns = ["定义", "概念", "原理", "基础", "标准", "规范", "百科"];

  let tag: TimelinessTag = THRESHOLDS.DEFAULT_TIMELINESS;

  if (ephemeralPatterns.some((p) => text.includes(p))) {
    tag = "ephemeral";
  } else if (shortTermPatterns.some((p) => text.includes(p))) {
    tag = "short_term";
  } else if (permanentPatterns.some((p) => text.includes(p))) {
    tag = "permanent";
  }

  // 术语/红线/领域知识 → 倾向长期有效
  if (input.category === "term" || input.category === "redline" || input.category === "domain_knowledge") {
    tag = tag === "ephemeral" ? "short_term" : "long_term";
  }
  // 热点事件 → 倾向短期
  if (input.category === "hot_event" && tag === "long_term") {
    tag = "short_term";
  }

  return {
    pass: true,
    stage,
    reason: `时效标记: ${tag}`,
    tag,
    metadata: { timeliness: tag },
  };
}

// ============ 管线执行 ============

/**
 * 执行完整审核管线
 * 5 道审核全部通过后自动入库
 */
export async function runAuditPipeline(
  input: AuditInput
): Promise<PipelineResult> {
  const stages: AuditResult[] = [];

  // 第 1 道：相关度
  const r1 = auditRelevance(input);
  stages.push(r1);
  if (!r1.pass) {
    logger.debug({ stage: r1.stage, reason: r1.reason }, "审核未通过");
    return { accepted: false, stages };
  }

  // 第 2 道：质量
  const r2 = auditQuality(input);
  stages.push(r2);
  if (!r2.pass) {
    logger.debug({ stage: r2.stage, reason: r2.reason }, "审核未通过");
    return { accepted: false, stages };
  }

  // 第 3 道：入库原因
  const r3 = auditReason(input);
  stages.push(r3);
  if (!r3.pass) {
    logger.debug({ stage: r3.stage, reason: r3.reason }, "审核未通过");
    return { accepted: false, stages };
  }

  // 第 4 道：向量去重
  const r4 = await auditDedup(input);
  stages.push(r4);
  if (!r4.pass) {
    logger.debug({ stage: r4.stage, reason: r4.reason }, "审核未通过");
    return { accepted: false, stages };
  }

  // 第 5 道：时效标记（始终通过）
  const r5 = auditTimeliness(input);
  stages.push(r5);

  // 全部通过 → 入库
  const entry = await createEntry({
    ...input,
    metadata: {
      ...input.metadata,
      timeliness: r5.tag,
      auditedAt: new Date().toISOString(),
      auditStages: stages.map((s) => ({
        stage: s.stage,
        pass: s.pass,
        score: s.score,
      })),
    },
  });

  logger.info(
    { id: entry.id, category: input.category, timeliness: r5.tag },
    "审核通过，已入库"
  );

  return {
    accepted: true,
    stages,
    entry: { id: entry.id },
    timeliness: r5.tag,
  };
}

/**
 * 批量审核（逐条过管线）
 */
export async function runBatchAudit(
  inputs: AuditInput[]
): Promise<{ accepted: PipelineResult[]; rejected: PipelineResult[] }> {
  const accepted: PipelineResult[] = [];
  const rejected: PipelineResult[] = [];

  for (const input of inputs) {
    const result = await runAuditPipeline(input);
    if (result.accepted) {
      accepted.push(result);
    } else {
      rejected.push(result);
    }
  }

  logger.info(
    { total: inputs.length, accepted: accepted.length, rejected: rejected.length },
    "批量审核完成"
  );

  return { accepted, rejected };
}
