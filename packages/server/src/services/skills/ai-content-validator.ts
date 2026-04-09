/**
 * AI 生成内容校验器
 *
 * 解决的问题：
 * AI（大模型）生成的文章标题、收稿范围、推荐语中可能包含与真实数据不符的数字或事实。
 * 本模块对 AI 输出进行交叉校验，发现不一致时自动用真实数据修正。
 *
 * 校验范围：
 * 1. 数值一致性 —— IF 分数、录用率、审稿天数、版面费、发文量等
 * 2. 分区一致性 —— Q1/Q2/1区/2区 等是否与数据库一致
 * 3. 事实一致性 —— 预警状态、出版商名称等
 * 4. 合理性检查 —— IF 预测是否离谱、评分是否合理
 */

import type { JournalInfo } from "../data-collection/journal-content-collector.js";
import type { AIGeneratedContent } from "./journal-template.js";

// ============ 校验结果 ============

export interface ValidationResult {
  /** 校验通过？ */
  passed: boolean;
  /** 修正后的 AI 内容 */
  corrected: AIGeneratedContent;
  /** 发现的问题 */
  issues: ValidationIssue[];
  /** 统计 */
  stats: {
    totalChecks: number;
    passedChecks: number;
    correctedChecks: number;
    blockedChecks: number;
  };
}

export interface ValidationIssue {
  /** 严重等级 */
  severity: "info" | "warning" | "error";
  /** 出错字段 */
  field: string;
  /** 问题描述 */
  message: string;
  /** AI 原始值 */
  aiValue?: string;
  /** 真实值 */
  realValue?: string;
  /** 是否已自动修正 */
  autoCorrected: boolean;
}

// ============ 主校验入口 ============

/**
 * 校验 AI 生成的期刊推荐内容，与真实期刊数据交叉验证
 *
 * @param aiContent - AI 生成的原始内容
 * @param journal - 真实期刊数据（来自爬虫/数据库）
 * @returns 校验结果 + 修正后的内容
 */
export function validateAIContent(
  aiContent: AIGeneratedContent,
  journal: JournalInfo
): ValidationResult {
  const issues: ValidationIssue[] = [];
  // 深拷贝，在副本上修正
  const corrected: AIGeneratedContent = JSON.parse(JSON.stringify(aiContent));

  // ---- 1. 标题中的数值校验 ----
  validateNumbersInText(corrected, "title", corrected.title, journal, issues);

  // ---- 2. 推荐语中的数值校验 ----
  validateNumbersInText(corrected, "recommendation", corrected.recommendation, journal, issues);

  // ---- 3. 收稿范围中的数值校验 ----
  validateNumbersInText(corrected, "scopeDescription", corrected.scopeDescription, journal, issues);

  // ---- 4. 小编点评中的数值校验 ----
  if (corrected.editorComment) {
    validateNumbersInText(corrected, "editorComment", corrected.editorComment, journal, issues);
  }

  // ---- 5. 划重点中的数值校验 ----
  if (corrected.highlightTip) {
    validateNumbersInText(corrected, "highlightTip", corrected.highlightTip, journal, issues);
  }

  // ---- 6. 分区标签一致性 ----
  validatePartitionClaims(corrected, journal, issues);

  // ---- 7. IF 预测合理性 ----
  validateIFPrediction(corrected, journal, issues);

  // ---- 8. 评分合理性 ----
  validateRating(corrected, journal, issues);

  // ---- 9. 预警状态一致性 ----
  validateWarningStatus(corrected, journal, issues);

  // ---- 10. 出版商名称一致性 ----
  validatePublisherName(corrected, journal, issues);

  // 统计
  const stats = {
    totalChecks: issues.length > 0 ? issues.length : 10, // 至少跑了 10 项检查
    passedChecks: 10 - issues.length,
    correctedChecks: issues.filter(i => i.autoCorrected).length,
    blockedChecks: issues.filter(i => i.severity === "error" && !i.autoCorrected).length,
  };

  return {
    passed: issues.filter(i => i.severity === "error").length === 0,
    corrected,
    issues,
    stats: {
      totalChecks: Math.max(stats.totalChecks, stats.passedChecks + stats.correctedChecks + stats.blockedChecks),
      passedChecks: Math.max(0, stats.totalChecks - issues.length),
      correctedChecks: stats.correctedChecks,
      blockedChecks: stats.blockedChecks,
    },
  };
}

// ============ 各项校验逻辑 ============

/**
 * 从文本中提取数字，与真实数据交叉验证，不一致则替换
 */
function validateNumbersInText(
  corrected: AIGeneratedContent,
  field: string,
  text: string,
  journal: JournalInfo,
  issues: ValidationIssue[]
): void {
  if (!text) return;
  let fixedText = text;

  // --- IF 分数校验 ---
  // 匹配 "IF 12.3" / "影响因子12.3" / "IF12.3分" / "影响因子 12.3 分" / "IF高达12.3" 等
  const ifPatterns = [
    /(?:IF|影响因子|Impact\s*Factor)\s*[:：]?\s*(?:高达|仅|为|达到|涨至|达)?\s*(\d+\.?\d*)/gi,
  ];
  if (journal.impactFactor != null) {
    const realIF = journal.impactFactor.toFixed(1);
    for (const pattern of ifPatterns) {
      let match: RegExpExecArray | null;
      // Reset lastIndex
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const aiIF = match[1];
        // 容差：±0.5 以内算正确
        if (Math.abs(parseFloat(aiIF) - journal.impactFactor) > 0.5) {
          issues.push({
            severity: "warning",
            field,
            message: `IF 数值不一致：AI写"${aiIF}"，实际为 ${realIF}`,
            aiValue: aiIF,
            realValue: realIF,
            autoCorrected: true,
          });
          fixedText = fixedText.replace(new RegExp(escRegex(match[0]), "g"), match[0].replace(aiIF, realIF));
        }
      }
    }
  }

  // --- 录用率校验 ---
  // 匹配 "录用率35%" / "接收率 35%" / "录用率约35%" 等
  const acceptPatterns = [
    /(?:录用率|接收率|acceptance\s*rate)\s*(?:约|大约|仅|高达)?\s*(\d+)\s*%/gi,
  ];
  if (journal.acceptanceRate != null) {
    const realRate = journal.acceptanceRate >= 1 ? journal.acceptanceRate : journal.acceptanceRate * 100;
    const realRateStr = realRate.toFixed(0);
    for (const pattern of acceptPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const aiRate = parseInt(match[1]);
        // 容差：±5个百分点
        if (Math.abs(aiRate - realRate) > 5) {
          issues.push({
            severity: "warning",
            field,
            message: `录用率不一致：AI写"${aiRate}%"，实际为 ${realRateStr}%`,
            aiValue: `${aiRate}%`,
            realValue: `${realRateStr}%`,
            autoCorrected: true,
          });
          fixedText = fixedText.replace(new RegExp(escRegex(match[0]), "g"), match[0].replace(String(aiRate), realRateStr));
        }
      }
    }
  }

  // --- 审稿周期校验 ---
  // 匹配 "审稿30天" / "审稿周期 30-45天" / "审稿仅30天" / "20天出结果" 等
  const reviewPatterns = [
    /(?:审稿|review)\s*(?:周期|时间)?\s*(?:约|仅|只需|最快)?\s*(\d+)(?:\s*[-~到至]\s*(\d+))?\s*天/gi,
    /(\d+)(?:\s*[-~到至]\s*(\d+))?\s*天\s*(?:出|审|给)\s*(?:结果|意见|稿)/gi,
  ];
  if (journal.reviewCycle) {
    const realMatch = journal.reviewCycle.match(/(\d+)/);
    if (realMatch) {
      const realDays = parseInt(realMatch[0]);
      for (const pattern of reviewPatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          const aiDays = parseInt(match[1]);
          // 容差：±15 天
          if (Math.abs(aiDays - realDays) > 15) {
            issues.push({
              severity: "warning",
              field,
              message: `审稿周期不一致：AI写"${match[0]}"，实际为 ${journal.reviewCycle}`,
              aiValue: match[0],
              realValue: journal.reviewCycle,
              autoCorrected: true,
            });
            fixedText = fixedText.replace(match[0], journal.reviewCycle);
          }
        }
      }
    }
  }

  // --- 版面费校验 ---
  const apcPatterns = [
    /(?:版面费|APC|Article Processing Charge)\s*[:：]?\s*\$?\s*(\d[\d,]*)/gi,
    /\$\s*(\d[\d,]*)\s*(?:美元)?/gi,
  ];
  if (journal.apcFee != null) {
    for (const pattern of apcPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const aiAPC = parseInt(match[1].replace(/,/g, ""));
        // 容差：±200
        if (Math.abs(aiAPC - journal.apcFee) > 200) {
          issues.push({
            severity: "warning",
            field,
            message: `版面费不一致：AI写"$${aiAPC}"，实际为 $${journal.apcFee}`,
            aiValue: `$${aiAPC}`,
            realValue: `$${journal.apcFee}`,
            autoCorrected: true,
          });
          fixedText = fixedText.replace(match[1], String(journal.apcFee));
        }
      }
    }
  }

  // --- 年发文量校验 ---
  const volumePatterns = [
    /(?:年发文|年发表|年刊发|发文量)\s*(?:约|量)?\s*(\d[\d,]*)\s*篇/gi,
    /(\d[\d,]*)\s*篇\s*(?:文章|论文)/gi,
  ];
  if (journal.annualVolume != null) {
    for (const pattern of volumePatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const aiVol = parseInt(match[1].replace(/,/g, ""));
        // 容差：±30%
        if (Math.abs(aiVol - journal.annualVolume) / journal.annualVolume > 0.3) {
          issues.push({
            severity: "info",
            field,
            message: `发文量偏差较大：AI写"${aiVol}篇"，实际为 ${journal.annualVolume} 篇`,
            aiValue: String(aiVol),
            realValue: String(journal.annualVolume),
            autoCorrected: true,
          });
          fixedText = fixedText.replace(match[1], String(journal.annualVolume));
        }
      }
    }
  }

  // 回写修正后的文本
  if (fixedText !== text) {
    (corrected as unknown as Record<string, unknown>)[field] = fixedText;
  }
}

/**
 * 校验分区声称是否与真实数据一致
 */
function validatePartitionClaims(
  corrected: AIGeneratedContent,
  journal: JournalInfo,
  issues: ValidationIssue[]
): void {
  const allText = [corrected.title, corrected.recommendation, corrected.editorComment, corrected.highlightTip]
    .filter(Boolean).join(" ");

  // 检查是否声称了更高的分区
  const realPartition = journal.casPartition || journal.partition || "";

  // AI 说 Q1/1区 但实际不是
  if (/[QⅠ]1|1区|一区/i.test(allText) && !/(Q1|1区)/i.test(realPartition)) {
    issues.push({
      severity: "error",
      field: "partition",
      message: `AI 声称该期刊为 Q1/1区，但实际分区为"${realPartition || "未知"}"`,
      aiValue: "Q1/1区",
      realValue: realPartition || "未知",
      autoCorrected: true,
    });
    // 修正：把完整的分区短语替换（避免"医学 2区区"这种问题）
    if (realPartition) {
      const replacePartition = (text: string) => text
        // "Q1区" → 真实值（避免替换后出现 "X区区"）
        .replace(/Q1[区]?/gi, realPartition)
        // "1区" / "一区" → 真实值（但要避免二次替换）
        .replace(/(?<![\d])[1一]区/g, realPartition);
      corrected.title = replacePartition(corrected.title);
      if (corrected.recommendation) corrected.recommendation = replacePartition(corrected.recommendation);
      if (corrected.editorComment) corrected.editorComment = replacePartition(corrected.editorComment);
      if (corrected.highlightTip) corrected.highlightTip = replacePartition(corrected.highlightTip);
    }
  }

  // AI 说 TOP 但实际不是
  if (/TOP/i.test(allText) && !(journal.casPartitionNew || "").toUpperCase().includes("TOP")) {
    issues.push({
      severity: "warning",
      field: "partition",
      message: "AI 声称该期刊为 TOP 期刊，但实际数据中无 TOP 标记",
      aiValue: "TOP",
      realValue: journal.casPartitionNew || "无TOP标记",
      autoCorrected: true,
    });
    // 移除 TOP 声称（包括前后可能的空格和标点）
    const removeTOP = (text: string) => text
      .replace(/\s*[,，]?\s*TOP\s*/gi, "")
      .replace(/\s{2,}/g, " ");
    corrected.title = removeTOP(corrected.title);
    if (corrected.recommendation) corrected.recommendation = removeTOP(corrected.recommendation);
    if (corrected.editorComment) corrected.editorComment = removeTOP(corrected.editorComment);
    if (corrected.highlightTip) corrected.highlightTip = removeTOP(corrected.highlightTip);
  }
}

/**
 * IF 预测合理性校验
 */
function validateIFPrediction(
  corrected: AIGeneratedContent,
  journal: JournalInfo,
  issues: ValidationIssue[]
): void {
  if (!corrected.ifPrediction || journal.impactFactor == null) return;

  // 提取预测中的数字
  const predMatch = corrected.ifPrediction.match(/(\d+\.?\d*)/);
  if (!predMatch) return;

  const predicted = parseFloat(predMatch[1]);
  const current = journal.impactFactor;

  // 预测涨幅超过 50% 或跌幅超过 30% 视为不合理
  if (predicted > current * 1.5) {
    issues.push({
      severity: "warning",
      field: "ifPrediction",
      message: `IF 预测值 ${predicted} 相比当前 ${current.toFixed(1)} 涨幅过大（>${((predicted / current - 1) * 100).toFixed(0)}%），已移除`,
      aiValue: String(predicted),
      realValue: current.toFixed(1),
      autoCorrected: true,
    });
    corrected.ifPrediction = undefined;
  } else if (predicted < current * 0.7) {
    issues.push({
      severity: "warning",
      field: "ifPrediction",
      message: `IF 预测值 ${predicted} 相比当前 ${current.toFixed(1)} 跌幅过大，已移除`,
      aiValue: String(predicted),
      realValue: current.toFixed(1),
      autoCorrected: true,
    });
    corrected.ifPrediction = undefined;
  }

  // 如果有历史数据，检查预测是否符合趋势
  if (journal.ifHistory && journal.ifHistory.length >= 3) {
    const recentYears = journal.ifHistory.slice(-3);
    const avgGrowth = (recentYears[recentYears.length - 1].value - recentYears[0].value) / recentYears[0].value;
    const maxReasonable = current * (1 + avgGrowth * 1.5); // 最多比趋势再多 50%

    if (predicted > maxReasonable && corrected.ifPrediction) {
      issues.push({
        severity: "info",
        field: "ifPrediction",
        message: `IF 预测值 ${predicted} 显著偏离近年增长趋势（年均增长约 ${(avgGrowth / (recentYears.length - 1) * 100).toFixed(0)}%），建议谨慎`,
        autoCorrected: false,
      });
    }
  }
}

/**
 * 推荐评分合理性校验
 */
function validateRating(
  corrected: AIGeneratedContent,
  journal: JournalInfo,
  issues: ValidationIssue[]
): void {
  if (!corrected.rating) return;

  // 预警期刊不应该给 5 星
  if (journal.isWarningList && corrected.rating >= 4) {
    issues.push({
      severity: "error",
      field: "rating",
      message: `预警期刊不应给 ${corrected.rating} 星评价，已降至 2 星`,
      aiValue: String(corrected.rating),
      realValue: "2",
      autoCorrected: true,
    });
    corrected.rating = 2;
  }

  // IF < 2 且分区 Q3/Q4 不应给 5 星
  if (
    corrected.rating === 5 &&
    journal.impactFactor != null &&
    journal.impactFactor < 2 &&
    /(Q[34]|[34]区)/.test(journal.casPartition || journal.partition || "")
  ) {
    issues.push({
      severity: "warning",
      field: "rating",
      message: `IF ${journal.impactFactor} + ${journal.casPartition || journal.partition} 不宜给 5 星，已降至 3 星`,
      aiValue: "5",
      realValue: "3",
      autoCorrected: true,
    });
    corrected.rating = 3;
  }
}

/**
 * 预警状态一致性校验
 */
function validateWarningStatus(
  corrected: AIGeneratedContent,
  journal: JournalInfo,
  issues: ValidationIssue[]
): void {
  const allText = [corrected.title, corrected.recommendation, corrected.editorComment]
    .filter(Boolean).join(" ");

  // 实际在预警名单，但 AI 说"安全" / "放心投"
  if (journal.isWarningList && /(?:安全|放心|没问题|不在预警)/.test(allText)) {
    issues.push({
      severity: "error",
      field: "warningStatus",
      message: "该期刊在预警名单中，但 AI 文本声称安全/放心，已删除相关表述",
      autoCorrected: true,
    });
    const removeUnsafe = (text: string) => text
      .replace(/[，,]?\s*(?:安全可靠|可以放心投稿|不在预警名单中?|安全放心)[，,。！]?/g, "");
    corrected.title = removeUnsafe(corrected.title);
    if (corrected.recommendation) corrected.recommendation = removeUnsafe(corrected.recommendation);
    if (corrected.editorComment) corrected.editorComment = removeUnsafe(corrected.editorComment);
  }

  // 实际不在预警名单，但 AI 说"预警" / "谨慎"
  if (!journal.isWarningList && /(?:预警名单|被预警|需谨慎|有风险)/.test(allText)) {
    issues.push({
      severity: "error",
      field: "warningStatus",
      message: "该期刊不在预警名单中，但 AI 文本提到预警/风险，已删除相关表述",
      autoCorrected: true,
    });
    const removeFalseWarning = (text: string) => text
      .replace(/[，,]?\s*(?:在预警名单|被预警|需要?谨慎|有一定风险)[，,。！]?/g, "");
    corrected.title = removeFalseWarning(corrected.title);
    if (corrected.recommendation) corrected.recommendation = removeFalseWarning(corrected.recommendation);
  }
}

/**
 * 出版商名称一致性校验
 */
function validatePublisherName(
  corrected: AIGeneratedContent,
  journal: JournalInfo,
  issues: ValidationIssue[]
): void {
  if (!journal.publisher) return;

  const allText = [corrected.recommendation, corrected.scopeDescription].filter(Boolean).join(" ");

  // 常见出版商名称混淆
  const publisherMappings: Array<[RegExp, string[]]> = [
    [/Elsevier/i, ["Springer", "Wiley", "MDPI", "Frontiers"]],
    [/Springer/i, ["Elsevier", "Wiley", "MDPI", "Frontiers"]],
    [/Wiley/i, ["Elsevier", "Springer", "MDPI", "Frontiers"]],
    [/MDPI/i, ["Elsevier", "Springer", "Wiley", "Frontiers"]],
    [/Frontiers/i, ["Elsevier", "Springer", "Wiley", "MDPI"]],
    [/IEEE/i, ["Elsevier", "Springer", "ACM"]],
  ];

  for (const [realPattern, wrongNames] of publisherMappings) {
    if (realPattern.test(journal.publisher)) {
      for (const wrong of wrongNames) {
        if (new RegExp(wrong, "i").test(allText) && !new RegExp(wrong, "i").test(journal.publisher)) {
          issues.push({
            severity: "error",
            field: "publisher",
            message: `AI 提到出版商"${wrong}"，但该期刊实际由"${journal.publisher}"出版`,
            aiValue: wrong,
            realValue: journal.publisher,
            autoCorrected: true,
          });
          // 替换错误的出版商名称
          if (corrected.recommendation) {
            corrected.recommendation = corrected.recommendation.replace(new RegExp(wrong, "gi"), journal.publisher);
          }
          if (corrected.scopeDescription) {
            corrected.scopeDescription = corrected.scopeDescription.replace(new RegExp(wrong, "gi"), journal.publisher);
          }
        }
      }
      break;
    }
  }
}

// ============ 工具函数 ============

/** 转义正则特殊字符 */
function escRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
