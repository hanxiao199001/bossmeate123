/**
 * T408: AI 质检 v2 — 红线校验 + IP 一致性
 *
 * 在 v1 基础上：
 * - 红线校验：接入 Sub-lib 2（redline）检查违规内容（保留不动）
 * - IP 一致性：接入 Sub-lib 8（style）检查风格匹配度（保留不动）
 * - 平台规则：接入 Sub-lib 9（platform_rule）检查平台合规（保留不动）
 *
 * P0四件套①（7-03）：五维通用评分**替换**为老韩六维（对齐根目录《内容质量评分标准-80分线.md》）：
 *   选题与钩子20% / 数据准确25% / 结构与信息密度20% / 排版15% / 实用性10% / 原创合规10%
 *   每维 0-10，加权总分 0-100；通过线 = 总分 ≥80 且无维度 <6。
 *   每维带 weakestSection（哪节拖后腿）+ fixHint（一句怎么修），供定向重写闭环使用。
 */

import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { semanticSearch } from "../knowledge/knowledge-service.js";
import type { VectorCategory } from "../knowledge/vector-store.js";

// ============ 类型定义 ============

/** 六维 key（与评分标准 md 的表格一一对应） */
export type SixDimKey =
  | "topicHook"              // 选题与钩子 20%
  | "dataAccuracy"           // 数据准确 25%
  | "structureDensity"       // 结构与信息密度 20%
  | "formatting"             // 排版 15%
  | "practicality"           // 实用性 10%
  | "originalityCompliance"; // 原创合规 10%

/** 六维权重（百分比，合计 100）——照抄评分标准 md，别改 */
export const SIX_DIM_WEIGHTS: Record<SixDimKey, number> = {
  topicHook: 20,
  dataAccuracy: 25,
  structureDensity: 20,
  formatting: 15,
  practicality: 10,
  originalityCompliance: 10,
};

export const SIX_DIM_LABELS: Record<SixDimKey, string> = {
  topicHook: "选题与钩子",
  dataAccuracy: "数据准确",
  structureDensity: "结构与信息密度",
  formatting: "排版",
  practicality: "实用性",
  originalityCompliance: "原创合规",
};

export interface SixDimDetail {
  /** 0-10 */
  score: number;
  /** 哪一节拖了后腿（章节标题或"开头"/"结尾"/"全文"） */
  weakestSection: string;
  /** 一句话怎么修（供定向重写当指令用） */
  fixHint: string;
  /** 评分理由；dataAccuracy 维度额外含硬数据密度统计 */
  justification: string;
}

export interface SixDimResult {
  dims: Record<SixDimKey, SixDimDetail>;
  /** 加权总分 0-100 */
  totalScore: number;
  /** 总分 ≥80 且无维度 <6 */
  passed: boolean;
  /** 硬数据密度统计（来自 dataAccuracy 的 justification，如"全文1800字/硬数据11个≈163字/个"） */
  dataDensity: string;
  /** LLM 挂了走兜底时为 true：此时 passed=true（跳过该 pass 不阻塞），分数仅供参考 */
  degraded: boolean;
}

export interface QualityCheckV2Result {
  /** P0①：六维明细（替换原五维 originality/academicRigor/... 结构） */
  scores: SixDimResult["dims"];
  totalScore: number;         // 0-100（六维加权）
  passed: boolean;            // 总分 ≥80 且无维度 <6
  dataDensity: string;
  degraded: boolean;

  // v2 检查（保留不动）
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
 * P0①：支持传入 precomputedSixDim（quality-pipeline 已打过分时复用，省 1 次 LLM 调用）
 */
export async function qualityCheckV2(params: {
  tenantId: string;
  title: string;
  body: string;
  platform?: string;
  precomputedSixDim?: SixDimResult;
}): Promise<QualityCheckV2Result> {
  const { tenantId, title, body, platform, precomputedSixDim } = params;

  logger.info({ tenantId, title: title.slice(0, 30) }, "🔍 质检 V2 开始");

  // 并行执行检查（六维已有现成结果就不再打分）
  const [redlineResult, styleResult, platformResult, sixDim] = await Promise.all([
    checkRedlines(tenantId, title, body),
    checkStyleConsistency(tenantId, title, body),
    platform ? checkPlatformRules(tenantId, body, platform) : null,
    precomputedSixDim ? Promise.resolve(precomputedSixDim) : sixDimQualityCheck({ tenantId, title, body }),
  ]);

  // v3: 同步 HTML 字面量检测（无需 LLM，毫秒级）
  const htmlIntegrity = checkHtmlIntegrity(body);

  const overallPassed =
    sixDim.passed &&
    redlineResult.passed &&
    (styleResult.consistency >= 50) &&
    (!platformResult || platformResult.passed) &&
    htmlIntegrity.passed;

  const result: QualityCheckV2Result = {
    scores: sixDim.dims,
    totalScore: sixDim.totalScore,
    passed: sixDim.passed,
    dataDensity: sixDim.dataDensity,
    degraded: sixDim.degraded,
    redlineCheck: redlineResult,
    styleCheck: styleResult,
    platformCheck: platformResult || { platform: "none", passed: true, issues: [] },
    htmlIntegrity,
    overallPassed,
    feedback: generateFeedback(sixDim, redlineResult, styleResult, platformResult, htmlIntegrity),
  };

  logger.info(
    {
      totalScore: result.totalScore,
      sixDimPassed: sixDim.passed,
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

// ============ P0①: 老韩六维评分 ============

/**
 * 六维评分（单次 LLM 调用）。
 * 每维的"8 分什么样"照抄《内容质量评分标准-80分线.md》，让 LLM 有锚可打。
 * 兜底：LLM 挂/解析失败 → degraded=true 且 passed=true（跳过该 pass 不阻塞生成，
 * 也不会让垃圾默认分触发无意义的重写循环）。
 */
export async function sixDimQualityCheck(params: {
  tenantId: string;
  title: string;
  body: string;
}): Promise<SixDimResult> {
  const { tenantId, title, body } = params;
  const plain = body.replace(/<[^>]+>/g, "");
  const plainLen = plain.replace(/\s+/g, "").length;
  // 章节标题列表：让 LLM 的 weakestSection 落在真实章节名上，重写闭环才能定位
  const headings = [
    ...body.matchAll(/^##\s+(.+?)\s*$/gm),
    ...body.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi),
  ].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean).slice(0, 12);

  // 7-03 评分降级修复: deepseek-reasoner 偶发降级会污染首过率(旧 degradedSixDim 伪装 passed=true)。
  // 降级 → 自动重打 1 次; 两次都挂才判 degraded(下游转 needs_review, 不计入首过率)。
  for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-score-sixdim",
      message: `你是公众号内容总编"老韩"，按下面六个维度给这篇图文文章打分（每维 0-10 分）。这是发布线评审：8 分 = 能直接发的水平，普通 AI 初稿通常只有 5-6 分，别客气。

【六维评分标准（"8 分什么样"）】
1. 选题与钩子（权重20%）：8分 = 标题+开头抓人、直戳投稿/选刊痛点。痛点场景切入 / 开放式提问 / 真实数据反差 / 身份代入 / 悬念前置 等**任一钩子技法到位即算满分**；平铺直叙介绍背景 ≤5分。⚠️ **不得因"开头没有具体真实人物/学校/投稿经历案例"扣分**——本产品红线禁止编造案例, 缺"真人真事"不是扣分项, 也别在 fixHint 里要求补具体案例/学校/研究方向(那等于要求编造)。
2. 数据准确（权重25%）：8分 = 期刊硬指标（IF/分区/录用率/审稿周期）真实无误、口径一致；同时要求信息密度：**每 200 字至少 1 个具体硬数据（数字/指标/事实）**。请在 justification 里给出密度统计（如"全文约1800字，硬数据11个，约163字/个"）。空谈无数据 ≤4分。⚠️ 数据来自本产品核验过的期刊库, **不得因"没标注数据出处/来源链接/引用年份"扣分**(产品正文不外链出处), 只看数字是否真实、口径是否一致; 别在 fixHint 里要求补数据出处/来源/URL(那等于要求编造出处)。
3. 结构与信息密度（权重20%）：8分 = 逻辑清晰、干货密、无水分；有明显凑字/复读/套话段落 ≤5分
4. 排版（权重15%）：8分 = 手机端阅读舒适：**短段落（每段≤3句/≤100字）+ 图文交替（每2-3小段有图/图表/数据卡区隔）+ 重点强调**（小标题、加粗）；出现连续大段文字（单段>5句或>200字、或连续4段以上无图无卡片）≤5分
5. 实用性（权重10%）：8分 = 读完能直接用（投稿建议具体可操作，落到"谁该投/怎么投/避什么坑"）
6. 原创合规（权重10%）：8分 = 无违禁词、不像搬运、无 AI 腔套话堆砌

【待评文章】
标题: ${title}
全文纯文本字数: 约${plainLen}字
${headings.length > 0 ? `章节列表: ${headings.join(" / ")}` : ""}
正文（前4000字）:
${body.slice(0, 4000)}

对每一维输出：score（0-10 整数）、weakestSection（拖后腿最严重的一节，必须从章节列表选，或写"开头"/"结尾"/"全文"）、fixHint（一句话怎么修，要具体可执行）、justification（一句评分理由）。

直接输出 JSON（不要 markdown 包裹）:
{
  "topicHook": {"score": 6, "weakestSection": "开头", "fixHint": "…", "justification": "…"},
  "dataAccuracy": {"score": 7, "weakestSection": "…", "fixHint": "…", "justification": "全文约X字，硬数据N个，约Y字/个；…"},
  "structureDensity": {"score": 6, "weakestSection": "…", "fixHint": "…", "justification": "…"},
  "formatting": {"score": 7, "weakestSection": "…", "fixHint": "…", "justification": "…"},
  "practicality": {"score": 6, "weakestSection": "…", "fixHint": "…", "justification": "…"},
  "originalityCompliance": {"score": 7, "weakestSection": "…", "fixHint": "…", "justification": "…"}
}`,
      skillType: "quality_check",
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("六维评分输出无 JSON");
    const parsed = JSON.parse(jsonMatch[0]);

    const dims = {} as Record<SixDimKey, SixDimDetail>;
    for (const key of Object.keys(SIX_DIM_WEIGHTS) as SixDimKey[]) {
      const d = parsed[key] || {};
      dims[key] = {
        score: clamp(Math.round(Number(d.score)), 0, 10),
        weakestSection: String(d.weakestSection || "全文"),
        fixHint: String(d.fixHint || ""),
        justification: String(d.justification || ""),
      };
    }

    // 加权总分：每维 score(0-10) × 权重(%)，除以 10 → 0-100
    // 例：全维 8 分 → 8×100/10 = 80 分（正好压在发布线上）
    const total = Math.round(
      (Object.keys(SIX_DIM_WEIGHTS) as SixDimKey[]).reduce(
        (sum, k) => sum + dims[k].score * SIX_DIM_WEIGHTS[k],
        0
      ) / 10
    );

    // 通过标准照 md：总分 ≥80 且无维度 <6
    const passed = total >= 80 && (Object.values(dims) as SixDimDetail[]).every((d) => d.score >= 6);

    return {
      dims,
      totalScore: total,
      passed,
      dataDensity: dims.dataAccuracy.justification,
      degraded: false,
    };
  } catch (err) {
    const last = attempt >= 2;
    logger.warn(
      { err: err instanceof Error ? err.message : err, attempt },
      last ? "P0① 六维评分两次均失败 → degraded(转 needs_review, 不计入首过率)" : "P0① 六维评分 LLM 失败，自动重打 1 次"
    );
    if (last) return degradedSixDim();
    // else: 继续 for 循环重打一次
  }
  }
  return degradedSixDim(); // 循环内必 return, 此行仅满足类型
}

/**
 * LLM 两次均失败兜底：degraded=true + passed=false。
 * 7-03 改: 旧版 passed=true+80分 会把"没打成分"伪装成"过线", 污染首过率并让降级文章直接放行。
 * 改为 passed=false → batch-worker 转 needs_review(人工复核); degraded 标记让首过率统计把它排除在分母外。
 * (degraded 仍跳过重写循环, 见 quality-pipeline 的 sixDim.degraded 判断, 不会拿默认分瞎重写烧钱)
 */
function degradedSixDim(): SixDimResult {
  const dims = {} as Record<SixDimKey, SixDimDetail>;
  for (const key of Object.keys(SIX_DIM_WEIGHTS) as SixDimKey[]) {
    dims[key] = { score: 0, weakestSection: "全文", fixHint: "", justification: "评分服务降级，分数不可信" };
  }
  return { dims, totalScore: 0, passed: false, dataDensity: "评分服务降级，无统计", degraded: true };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Number.isFinite(v) ? v : 0, min), max);
}

function generateFeedback(
  sixDim: SixDimResult,
  redline: QualityCheckV2Result["redlineCheck"],
  style: QualityCheckV2Result["styleCheck"],
  platform: QualityCheckV2Result["platformCheck"] | null,
  htmlIntegrity?: QualityCheckV2Result["htmlIntegrity"]
): string {
  const parts: string[] = [];

  if (sixDim.totalScore >= 90) parts.push("内容质量优秀");
  else if (sixDim.passed) parts.push("内容质量达到 80 分发布线");
  else parts.push("内容质量未达 80 分发布线");

  // 列出 <8 的低分维度（老韩打分流程：标出 <8 的维度逐个抬）
  const lows = (Object.keys(sixDim.dims) as SixDimKey[])
    .filter((k) => sixDim.dims[k].score < 8)
    .map((k) => `${SIX_DIM_LABELS[k]}${sixDim.dims[k].score}分(${sixDim.dims[k].weakestSection}：${sixDim.dims[k].fixHint})`);
  if (lows.length > 0 && !sixDim.degraded) {
    parts.push(`低分维度：${lows.join("；")}`);
  }

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
