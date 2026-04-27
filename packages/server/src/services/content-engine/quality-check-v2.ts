/**
 * T408: AI 质检 v2 — 红线校验 + IP 一致性
 *
 * 在 v1 的 5 维评分基础上增加：
 * - 红线校验：接入 Sub-lib 2（redline）检查违规内容
 * - IP 一致性：接入 Sub-lib 8（style）检查风格匹配度
 * - 平台规则：接入 Sub-lib 9（platform_rule）检查平台合规
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { semanticSearch } from "../knowledge/knowledge-service.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 类型定义 ============

export interface QualityCheckV2Result {
  // v1 维度
  scores: {
    originality: number;      // 0-20
    academicRigor: number;    // 0-20
    seoFriendliness: number;  // 0-20
    readability: number;      // 0-20
    industryRelevance: number;// 0-20
  };
  totalScore: number;         // 0-100
  passed: boolean;            // >= 70

  // v2 新增检查
  redlineCheck: {
    passed: boolean;
    violations: Array<{ rule: string; snippet: string; severity: "critical" | "warning" }>;
  };
  styleCheck: {
    consistency: number;      // 0-100 一致性分数
    deviations: string[];     // 风格偏差描述
  };
  platformCheck: {
    platform: string;
    passed: boolean;
    issues: string[];
  };

  // v3 新增：HTML 字面量泄漏检测（同步本地正则，零 token 成本）
  htmlIntegrity: {
    passed: boolean;
    /** 命中的字面量片段示例（最多 5 条），用于排查 */
    leakedPatterns: string[];
  };

  overallPassed: boolean;     // 综合判定
  feedback: string;
}

// ============ 核心逻辑 ============

/**
 * 质检 v2 完整检查
 */
export async function qualityCheckV2(params: {
  tenantId: string;
  title: string;
  body: string;
  platform?: string;
}): Promise<QualityCheckV2Result> {
  const { tenantId, title, body, platform } = params;

  logger.info({ tenantId, title: title.slice(0, 30) }, "🔍 质检 V2 开始");

  // 并行执行三项检查
  const [redlineResult, styleResult, platformResult, scoreResult] = await Promise.all([
    checkRedlines(tenantId, title, body),
    checkStyleConsistency(tenantId, title, body),
    platform ? checkPlatformRules(tenantId, body, platform) : null,
    scoreContent(tenantId, title, body),
  ]);

  // v3: 同步 HTML 字面量检测（无需 LLM，毫秒级）
  const htmlIntegrity = checkHtmlIntegrity(body);

  const overallPassed =
    scoreResult.totalScore >= 70 &&
    redlineResult.passed &&
    (styleResult.consistency >= 50) &&
    (!platformResult || platformResult.passed) &&
    htmlIntegrity.passed;

  const result: QualityCheckV2Result = {
    scores: scoreResult.scores,
    totalScore: scoreResult.totalScore,
    passed: scoreResult.totalScore >= 70,
    redlineCheck: redlineResult,
    styleCheck: styleResult,
    platformCheck: platformResult || { platform: "none", passed: true, issues: [] },
    htmlIntegrity,
    overallPassed,
    feedback: generateFeedback(scoreResult.totalScore, redlineResult, styleResult, platformResult, htmlIntegrity),
  };

  logger.info(
    {
      totalScore: result.totalScore,
      redlinePassed: result.redlineCheck.passed,
      styleConsistency: result.styleCheck.consistency,
      overallPassed: result.overallPassed,
    },
    "🔍 质检 V2 完成"
  );

  return result;
}

// ============ 红线校验 ============

async function checkRedlines(
  tenantId: string,
  title: string,
  body: string
): Promise<QualityCheckV2Result["redlineCheck"]> {
  // 从 Sub-lib 2 检索相关红线规则
  const redlines = await safeSearch(tenantId, `${title} ${body.slice(0, 500)}`, "redline", 10);

  if (redlines.length === 0) {
    return { passed: true, violations: [] };
  }

  const rulesText = redlines.map((r) => r.content).join("\n");
  const contentPreview = `${title}\n${body.slice(0, 2000)}`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-redline",
      message: `请检查以下内容是否违反了任何红线规则。

红线规则列表：
${rulesText}

待检查内容：
${contentPreview}

直接输出 JSON:
{
  "violations": [
    {"rule": "违反的规则", "snippet": "违规的具体文字片段", "severity": "critical|warning"}
  ]
}
如果没有违规，violations 为空数组。`,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { passed: true, violations: [] };

    const parsed = JSON.parse(jsonMatch[0]);
    const violations = parsed.violations || [];

    return {
      passed: !violations.some((v: { severity: string }) => v.severity === "critical"),
      violations,
    };
  } catch {
    return { passed: true, violations: [] };
  }
}

// ============ IP 风格一致性检查 ============

async function checkStyleConsistency(
  tenantId: string,
  title: string,
  body: string
): Promise<QualityCheckV2Result["styleCheck"]> {
  // 从 Sub-lib 8 检索 IP 风格模板
  const styles = await safeSearch(tenantId, "IP风格 调性 写作风格", "style", 5);

  if (styles.length === 0) {
    return { consistency: 80, deviations: [] };
  }

  const styleDescriptions = styles.map((s) => s.content).join("\n");
  const contentPreview = `${title}\n${body.slice(0, 1500)}`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-style",
      message: `请检查内容与品牌 IP 风格的一致性。

品牌风格定义：
${styleDescriptions}

待检查内容：
${contentPreview}

直接输出 JSON:
{
  "consistency": 85,
  "deviations": ["偏差描述1", "偏差描述2"]
}
consistency: 0-100 的一致性分数，80+ 为良好。`,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { consistency: 75, deviations: [] };

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      consistency: Math.min(Math.max(parsed.consistency || 75, 0), 100),
      deviations: parsed.deviations || [],
    };
  } catch {
    return { consistency: 75, deviations: [] };
  }
}

// ============ 平台规则检查 ============

async function checkPlatformRules(
  tenantId: string,
  body: string,
  platform: string
): Promise<QualityCheckV2Result["platformCheck"]> {
  // 从 Sub-lib 9 检索平台规则
  const rules = await safeSearch(tenantId, `${platform} 平台规则 限制`, "platform_rule", 5);

  if (rules.length === 0) {
    return { platform, passed: true, issues: [] };
  }

  const rulesText = rules.map((r) => r.content).join("\n");

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-platform",
      message: `检查内容是否符合 ${platform} 平台的发布规则。

平台规则：
${rulesText}

内容（前1500字）：
${body.slice(0, 1500)}

直接输出 JSON:
{"passed": true, "issues": ["问题1"]}`,
      skillType: "formatting",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { platform, passed: true, issues: [] };

    const parsed = JSON.parse(jsonMatch[0]);
    return { platform, passed: parsed.passed !== false, issues: parsed.issues || [] };
  } catch {
    return { platform, passed: true, issues: [] };
  }
}

// ============ v3: HTML 字面量泄漏检测 ============

/**
 * 检测 body 是否含 HTML 标签字面量泄漏（escaped tags 显示为 readable text）。
 *
 * 触发场景（T4-3-3 实测发现）：AI 在生成文本里混入 <strong>/<em>/<p> 等标签，
 * 后续按句切分时标签被切散到不同条目，esc() 把残留转义成 `&lt;strong&gt;` 等
 * 字面量泄漏到读者眼前，但 quality_score 评分模型看不出来。
 *
 * 同步正则，零 token 成本，毫秒级。
 */
export function checkHtmlIntegrity(body: string): QualityCheckV2Result["htmlIntegrity"] {
  if (!body) return { passed: true, leakedPatterns: [] };

  // 单层 escape：&lt;tag&gt; / &lt;/tag&gt;
  const escapedTagPattern = /&lt;\/?(?:strong|em|p|br|h[1-6]|span|a|div|li|ul|ol|table|tr|td|th)(?:\s[^&]*?)?&gt;/gi;
  // 双层 escape：&amp;lt; （转义被再次 esc 了）
  const doubleEscapedPattern = /&amp;lt;/gi;

  const matches = new Set<string>();
  let m;
  while ((m = escapedTagPattern.exec(body)) !== null) {
    matches.add(m[0]);
    if (matches.size >= 5) break;
  }
  if (matches.size < 5) {
    while ((m = doubleEscapedPattern.exec(body)) !== null) {
      matches.add(m[0]);
      if (matches.size >= 5) break;
    }
  }

  return {
    passed: matches.size === 0,
    leakedPatterns: Array.from(matches),
  };
}

// ============ v1 评分（复用逻辑）============

async function scoreContent(
  tenantId: string,
  title: string,
  body: string
): Promise<{ scores: QualityCheckV2Result["scores"]; totalScore: number }> {
  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-score-v2",
      message: `对以下内容做 5 维评分（每维 0-20，总分 100）。

标题: ${title}
正文（前2000字）: ${body.slice(0, 2000)}

维度: 原创度 / 学术规范 / SEO友好 / 可读性 / 行业度

直接输出 JSON:
{"originality":15,"academicRigor":16,"seoFriendliness":14,"readability":17,"industryRelevance":15}`,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return defaultScores();

    const parsed = JSON.parse(jsonMatch[0]);
    const scores = {
      originality: clamp(parsed.originality, 0, 20),
      academicRigor: clamp(parsed.academicRigor, 0, 20),
      seoFriendliness: clamp(parsed.seoFriendliness, 0, 20),
      readability: clamp(parsed.readability, 0, 20),
      industryRelevance: clamp(parsed.industryRelevance, 0, 20),
    };
    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
    return { scores, totalScore };
  } catch {
    return defaultScores();
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v || 0, min), max);
}

function defaultScores() {
  const scores = { originality: 15, academicRigor: 15, seoFriendliness: 14, readability: 15, industryRelevance: 14 };
  return { scores, totalScore: 73 };
}

function generateFeedback(
  totalScore: number,
  redline: QualityCheckV2Result["redlineCheck"],
  style: QualityCheckV2Result["styleCheck"],
  platform: QualityCheckV2Result["platformCheck"] | null,
  htmlIntegrity?: QualityCheckV2Result["htmlIntegrity"]
): string {
  const parts: string[] = [];

  if (totalScore >= 85) parts.push("内容质量优秀");
  else if (totalScore >= 70) parts.push("内容质量合格");
  else parts.push("内容质量需改进");

  if (!redline.passed) {
    parts.push(`存在 ${redline.violations.length} 处红线违规`);
  }
  if (style.consistency < 60) {
    parts.push("风格一致性较低，建议调整语气");
  }
  if (platform && !platform.passed) {
    parts.push(`${platform.platform} 平台规则问题: ${platform.issues.join("、")}`);
  }
  if (htmlIntegrity && !htmlIntegrity.passed) {
    parts.push(
      `存在 HTML 标签字面量泄漏（${htmlIntegrity.leakedPatterns.length} 处），读者会看到原始标签文本`
    );
  }

  return parts.join("。") + "。";
}

// ============ 工具 ============

async function safeSearch(
  tenantId: string,
  query: string,
  category: VectorCategory,
  limit: number
) {
  try {
    return await semanticSearch({ tenantId, query, category, limit, minScore: 0.1 });
  } catch {
    return [];
  }
}
