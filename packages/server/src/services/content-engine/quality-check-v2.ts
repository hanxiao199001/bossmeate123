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
import { chat, isAiUnavailableError } from "../ai/chat-service.js";
import { isAiFallbackText } from "../ai/fallback-messages.js";
import { semanticSearch } from "../knowledge/knowledge-service.js";
import {
  SIX_DIM_PUBLISH_TOTAL,
  SIX_DIM_PUBLISH_MIN_DIM,
  SIX_DIM_EXCELLENT_SCORE,
  SIX_DIM_WEAK_DIM_HINT,
} from "./quality-thresholds.js";
// 8-02: 排版维改由代码算（Golden Set 实测 LLM 在这一维基本失明），见该文件头注释
import { scoreFormatting } from "./formatting-metrics.js";
import type { VectorCategory } from "../knowledge/vector-store.js";
import { extractJsonObject } from "./llm-json.js";

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

/**
 * 发布达标线（总分部分）的**生效值**。8-20 外化，见 runtime-params 的 publish.sixDimTotalLine。
 *
 * 读失败一律退回代码常量 —— 参数系统挂了应该表现为「回到外化之前的行为」，
 * 而不是让质检判据变成 undefined/NaN 把所有内容判成不达标。
 */
async function getPublishTotalLine(): Promise<number> {
  try {
    const { getParam } = await import("../ops/runtime-params.js");
    return await getParam<number>("publish.sixDimTotalLine");
  } catch {
    return SIX_DIM_PUBLISH_TOTAL;
  }
}

export interface SixDimResult {
  dims: Record<SixDimKey, SixDimDetail>;
  /**
   * 加权总分 0-100；**null = 没评上分**（≠ 评了 0 分）。
   *
   * 7-28 阶段1-C 类型强制: 这里原本是 `number`，降级时填 0 当类型占位 —— 于是"没评上分"
   * 在类型上与"评了 0 分"完全不可区分，全靠消费方记得先看 `degraded`。7-27 事故正是这么来的
   * (20 篇未评分被当 0 分 → 红线剔除 → 零产出)，同构点在 content-worker / smart-assign /
   * quality-check-engine / crawl-data-sink 各有一处，人工 review 找不全。
   *
   * 改成 `number | null` 后，编译器会在**每一个**把它当数字用的地方报错，逼消费方显式
   * 回答"未评分时该怎么办"。判据永远是 `totalScore === null`（等价于 degraded=true），
   * 别再写 `|| 0` / `?? 0` / `|| 70` 这类默认值 —— 那是把问题重新埋回去。
   * 正确范式参考 `services/review/ai-reviewer-rules.ts` 的 `!Number.isFinite(total)` → 不入池。
   */
  totalScore: number | null;
  /** 总分 ≥publishTotalLine 且无维度 <6；没评上分时恒 false */
  passed: boolean;
  /**
   * 🔴 8-20: 本次判定**实际用的**总分线（读 publish.sixDimTotalLine，默认 80）。
   *
   * 为什么要带出来：给运营看的文案「未达 N 分发布线」必须用**判定时那条线**。
   * 用代码常量的话，参数一改，显示的线和实际判定的线就是两个数 —— 红线 #20 的形态。
   * 降级/未评分路径为 undefined（没判定过，也就没有"当时那条线"）。
   */
  publishTotalLine?: number;
  /** 硬数据密度统计（来自 dataAccuracy 的 justification，如"全文1800字/硬数据11个≈163字/个"） */
  dataDensity: string;
  /**
   * LLM 挂了走兜底时为 true。
   * ⚠️ 7-27 起语义收紧: degraded=true 表示**没评上分**，与"真的评了 0 分"完全不是一回事。
   * 7-28 起 `totalScore === null` 与本字段严格同义（两者由同一处构造，见 degradedSixDim）；
   * 保留 degraded 是为了带上 degradedReason，且消费方读哪个都不会错。
   */
  degraded: boolean;
  /** 7-27: 降级原因(AI 超时/无响应 vs 评分输出解析失败), 供简报与排查区分故障类型 */
  degradedReason?: string;
  /**
   * 7-27: 这次的分**是谁给的**。
   *   primary  = 路由表主评分模型(推理型, 与历史分数同一把尺子)
   *   fallback = 主模型超时/挂了后自动换的快模型(qwen-plus) —— 分数可用, 但与历史分数不完全同尺,
   *              落 metadata 是为了日后能把这批分单独捞出来做可信度审计(别混进标定样本)。
   * degraded=true(没评上分)时本字段为 undefined。
   */
  scoredBy?: "primary" | "fallback";
  /** 实际出分的模型名(如 deepseek-v4-pro / qwen-plus), 与 scoredBy 一起落 metadata 备查 */
  scorerModel?: string;
  /**
   * 8-03: 没评上分时, **是哪一类失败**导致的(见 services/ops/failure-kind.ts)。
   *
   * 【为什么必须带出来】8-03 百炼欠费, 质检主备模型同时失败(它们共用一个阿里云账户 ——
   *   7-27 切 DEEPSEEK_VIA=bailian 时无意造成的单点), 9 篇内容判 needs_review 卡住。
   *   这 9 篇**内容一点问题没有**, 只是评分器当时不可用; 充值之后它们本该被自动重评,
   *   但下游只看得到一个 degraded 布尔 —— 分不清"评分器挂了"和"内容评不出分",
   *   于是只能一律转人工。带上分类, 上游(batch-worker)才能给它们打 deferred 标记。
   * degraded=false 时为 undefined。
   */
  degradedKind?: import("../ops/failure-kind.js").FailureKind;
  /** 8-03: 原始错误摘要(排障 + 供 classifyFailure 二次判定, 不给运营看) */
  degradedError?: string;
}

export interface QualityCheckV2Result {
  /** P0①：六维明细（替换原五维 originality/academicRigor/... 结构） */
  scores: SixDimResult["dims"];
  /** 0-100（六维加权）；**null = 没评上分**，语义与 SixDimResult.totalScore 完全一致（直接透传） */
  totalScore: number | null;
  passed: boolean;            // 总分 ≥80 且无维度 <6
  dataDensity: string;
  degraded: boolean;

  // v2 检查
  redlineCheck: {
    /**
     * "这次检查**没查出** critical 违规"。
     * ⚠️ 7-28: 它**不等于**"内容合规" —— 检查压根没跑成时它也是 true。
     * 判"能不能发"必须 `passed && available` 两个都看(overallPassed 已经这么算)。
     */
    passed: boolean;
    violations: Array<{ rule: string; snippet: string; severity: "critical" | "warning" }>;
    /**
     * 7-28 ②a: 这道检查**是否真的跑成了**。
     * false = 规则检索挂了 / AI 没响应 / 输出解析不出来 —— 结论"不可用", 不是"合格"。
     * 刻意与 passed 分成两个字段: "检查不可用" ≠ "违规"(7-27「0分≠未评分」的同类教训) ——
     * 混成一个 boolean 的后果是二选一的灾难: 判 true 则坏了还在出货, 判 false 则评分器一抖
     * 全部内容被当信任事故打死(7-27 零产出的原样重演)。
     */
    available: boolean;
    /** 不可用的具体原因(rules_unavailable / ai_unavailable / parse_failed / error) */
    unavailableReason?: string;
  };
  styleCheck: {
    consistency: number;      // 0-100 一致性分数
    deviations: string[];     // 风格偏差描述
    /**
     * 7-28 ②c: 同上。false 时 consistency 是**占位数字不是评估结果** ——
     * 原来这里挂了硬返 75(及格线 50 → 必过), 等于给没检查过的内容发合格证。
     * 现在不可用时把 style 项整个**移出** overallPassed 的计算(不再拿假数字背书),
     * 但不因它单独把内容打成待审: 风格是修饰性维度, 不是安全闸(红线/平台才是)。
     */
    available: boolean;
    unavailableReason?: string;
  };
  platformCheck: {
    platform: string;
    passed: boolean;
    issues: string[];
    /** 7-28 ②c: 同 redline —— 平台规则查不了就不能判"能发" */
    available: boolean;
    unavailableReason?: string;
  };

  // v3 新增：HTML 字面量泄漏检测（同步本地正则，零 token 成本）
  htmlIntegrity: {
    passed: boolean;
    /** 命中的字面量片段示例（最多 5 条），用于排查 */
    leakedPatterns: string[];
  };

  overallPassed: boolean;     // 综合判定

  /**
   * 7-28 ②a/②c: 哪些检查"没能跑成"。非空 = **本次质检结论不完整**, 而不是"内容有问题"。
   *
   * 消费方铁律(与 7-27 的「未评上分 ≠ 0 分」完全同构):
   *   - overallPassed 会因此为 false → 内容转 needs_review 走人工复核 ✅
   *   - 但 needsReviewReason 必须写 QUALITY_GATE_UNAVAILABLE_REASON, **绝不能写红线类原因** ——
   *     红线类会被 draft-distributor 永久剔除出草稿箱(留人工), 那是给"信任事故"准备的处置,
   *     用在"我们自己的检查器挂了"上, 就是 7-27 零产出事故的原样重演。
   */
  unavailableChecks: Array<{ check: "redline" | "style" | "platform"; reason: string }>;

  feedback: string;
}

/**
 * 7-28: 因"闸没检查成"转人工时统一用这个 needsReviewReason。
 * draft-distributor 侧对应 GATE_UNAVAILABLE_REASONS —— **进池、排队尾、不当红线剔除**。
 */
export const QUALITY_GATE_UNAVAILABLE_REASON = "quality_gate_unavailable";

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

  // ==== 7-28 ②a/②c: 把"没检查成"从"检查通过"里拆出来 ====
  const unavailableChecks: QualityCheckV2Result["unavailableChecks"] = [];
  if (!redlineResult.available) unavailableChecks.push({ check: "redline", reason: redlineResult.unavailableReason ?? "unknown" });
  if (!styleResult.available) unavailableChecks.push({ check: "style", reason: styleResult.unavailableReason ?? "unknown" });
  if (platformResult && !platformResult.available) unavailableChecks.push({ check: "platform", reason: platformResult.unavailableReason ?? "unknown" });

  const overallPassed =
    sixDim.passed &&
    // 红线: 既要没查出违规, 也要**真的查成了** —— 解析失败判合格是最坏的默认值
    redlineResult.passed && redlineResult.available &&
    // 风格: 检查不可用时把这一项整个移出判定(不拿硬编码的 75 分冒充"风格合格");
    //   但不因它单独把内容打成待审 —— 风格是修饰性维度, 红线/平台才是安全闸。
    (!styleResult.available || styleResult.consistency >= 50) &&
    // 平台规则: 与红线同级 —— 查不了就不能判"能发"
    (!platformResult || (platformResult.passed && platformResult.available)) &&
    htmlIntegrity.passed;

  const result: QualityCheckV2Result = {
    scores: sixDim.dims,
    totalScore: sixDim.totalScore,
    passed: sixDim.passed,
    dataDensity: sixDim.dataDensity,
    degraded: sixDim.degraded,
    redlineCheck: redlineResult,
    styleCheck: styleResult,
    platformCheck: platformResult || { platform: "none", passed: true, issues: [], available: true },
    htmlIntegrity,
    overallPassed,
    unavailableChecks,
    feedback: generateFeedback(sixDim, redlineResult, styleResult, platformResult, htmlIntegrity, unavailableChecks),
  };

  // 7-28: 闸没检查成 → 落 ops_incidents。语义与 quality_check_unavailable(没评上分)平行:
  //   都是"我们的检查器挂了", 都转人工, 都**不是**内容违规。简报按 kind 分开汇总。
  if (unavailableChecks.length > 0) {
    reportGateUnavailable(tenantId, title, unavailableChecks);
  }

  logger.info(
    {
      totalScore: result.totalScore,
      sixDimPassed: sixDim.passed,
      redlinePassed: result.redlineCheck.passed,
      redlineAvailable: result.redlineCheck.available,
      styleConsistency: result.styleCheck.consistency,
      unavailableChecks: unavailableChecks.map((u) => u.check),
      overallPassed: result.overallPassed,
    },
    "🔍 质检 V2 完成"
  );

  return result;
}

/** 7-28: "闸没检查成"落告警(旁路, 失败不影响质检结论)。同一租户 10 分钟一条, 免刷屏。 */
function reportGateUnavailable(
  tenantId: string,
  title: string,
  checks: QualityCheckV2Result["unavailableChecks"],
): void {
  void (async () => {
    try {
      const { recordIncidentThrottled } = await (incidentsModule ??= import("../ops/incidents.js"));
      const names = checks.map((c) => `${c.check}(${c.reason})`).join("、");
      await recordIncidentThrottled({
        kind: "quality_gate_unavailable",
        severity: "warn",
        tenantId,
        message: `质检闸未跑成: ${names} —— 该内容转人工复核(不是内容违规, 是检查器不可用): 《${title.slice(0, 40)}》`,
        detail: { title: title.slice(0, 120), checks },
      }, { key: `quality_gate_unavailable:${tenantId}` });
    } catch { /* 告警旁路 */ }
  })();
}

// ============ 红线校验 ============

async function checkRedlines(
  tenantId: string,
  title: string,
  body: string
): Promise<QualityCheckV2Result["redlineCheck"]> {
  // 从 Sub-lib 2 检索相关红线规则
  const redlines = await safeSearch(tenantId, `${title} ${body.slice(0, 500)}`, "redline", 10);

  // 7-28 ②c: 检索**异常** ≠ 检索到 0 条。
  //   前者是"规则库查不了"(向量库/DB 挂了) → 红线这道最高级别的闸等于没跑, 绝不能判通过;
  //   后者是"这个租户本来就没配红线规则" → 是配置状态不是故障, 维持原样放行
  //     (若把"空规则库"也判成不通过, 全部租户的内容会一夜之间集体转人工 —— 那是把
  //      堵 fail-open 做成了 fail-shut, 同样是事故)。
  if (!redlines.ok) {
    return { passed: true, violations: [], available: false, unavailableReason: "rules_unavailable" };
  }
  if (redlines.results.length === 0) {
    return { passed: true, violations: [], available: true };
  }

  const rulesText = redlines.results.map((r) => r.content).join("\n");
  const contentPreview = `${title}\n${body.slice(0, 2000)}`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-redline",
      // 7-28 ②b: 主备全挂**抛错**而不是把一句道歉文案当模型输出 ——
      //   否则下面 match(/\{[\s\S]*\}/) 匹配不到 JSON, "AI 根本没响应"被记成"模型输出格式不对"。
      throwOnExhausted: true,
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

    // 7-28 ②a: 这三条原来全是 `return { passed: true, violations: [] }` —— **红线是最高级别的
    //   检查, 把"解析失败"默认成"合格"是最坏的默认值**。改成判"检查不可用"(available=false),
    //   由 qualityCheckV2 统一转 needs_review; 对齐 kf-responder.ts:230「解析失败→转人工」的正确范式。
    if (isAiFallbackText(response.content)) {
      return { passed: true, violations: [], available: false, unavailableReason: "ai_unavailable" };
    }
    // 7-30: 同六维那处, 换成确定性 JSON 修复(剥围栏/剥 think/括号配平/去尾逗号), 见 llm-json.ts
    const jsonMatch = extractJsonObject(response.content).value as Record<string, any> | null;
    if (!jsonMatch) return { passed: true, violations: [], available: false, unavailableReason: "parse_failed" };

    const parsed = jsonMatch;
    const violations = parsed.violations || [];

    return {
      passed: !violations.some((v: { severity: string }) => v.severity === "critical"),
      violations,
      available: true,
    };
  } catch (err) {
    logger.warn({ tenantId, err: errText(err) }, "7-28 红线校验不可用(转人工, ≠ 判违规)");
    return {
      passed: true, violations: [], available: false,
      unavailableReason: isAiUnavailableError(err) ? "ai_unavailable" : "error",
    };
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

  // 7-28 ②c: 同 checkRedlines —— 检索异常(库挂了)判"不可用"; 检索到 0 条(没配风格模板)维持原样。
  if (!styles.ok) {
    return { consistency: 75, deviations: [], available: false, unavailableReason: "rules_unavailable" };
  }
  if (styles.results.length === 0) {
    return { consistency: 80, deviations: [], available: true };
  }

  const styleDescriptions = styles.results.map((s) => s.content).join("\n");
  const contentPreview = `${title}\n${body.slice(0, 1500)}`;

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-style",
      throwOnExhausted: true, // 7-28 ②b
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

    // 7-28 ②c: 原来这两条硬返 consistency:75 —— 及格线是 50, 于是"风格检查挂了"永远变成"风格合格",
    //   一个凭空造出来的数字替真实评估背了书。现在标 available=false, 上层不再拿它当依据。
    if (isAiFallbackText(response.content)) {
      return { consistency: 75, deviations: [], available: false, unavailableReason: "ai_unavailable" };
    }
    // 7-30: 同六维那处, 换成确定性 JSON 修复(剥围栏/剥 think/括号配平/去尾逗号), 见 llm-json.ts
    const jsonMatch = extractJsonObject(response.content).value as Record<string, any> | null;
    if (!jsonMatch) return { consistency: 75, deviations: [], available: false, unavailableReason: "parse_failed" };

    const parsed = jsonMatch;
    return {
      consistency: Math.min(Math.max(parsed.consistency || 75, 0), 100),
      deviations: parsed.deviations || [],
      available: true,
    };
  } catch (err) {
    logger.warn({ tenantId, err: errText(err) }, "7-28 风格一致性检查不可用(不再硬返 75 分冒充合格)");
    return {
      consistency: 75, deviations: [], available: false,
      unavailableReason: isAiUnavailableError(err) ? "ai_unavailable" : "error",
    };
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

  // 7-28 ②c: 同上 —— 检索异常判"不可用"; 0 条规则(没配)维持原样放行。
  if (!rules.ok) {
    return { platform, passed: true, issues: [], available: false, unavailableReason: "rules_unavailable" };
  }
  if (rules.results.length === 0) {
    return { platform, passed: true, issues: [], available: true };
  }

  const rulesText = rules.results.map((r) => r.content).join("\n");

  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-platform",
      throwOnExhausted: true, // 7-28 ②b
      message: `检查内容是否符合 ${platform} 平台的发布规则。

平台规则：
${rulesText}

内容（前1500字）：
${body.slice(0, 1500)}

直接输出 JSON:
{"passed": true, "issues": ["问题1"]}`,
      skillType: "formatting",
    });

    if (isAiFallbackText(response.content)) {
      return { platform, passed: true, issues: [], available: false, unavailableReason: "ai_unavailable" };
    }
    // 7-30: 同六维那处, 换成确定性 JSON 修复(剥围栏/剥 think/括号配平/去尾逗号), 见 llm-json.ts
    const jsonMatch = extractJsonObject(response.content).value as Record<string, any> | null;
    if (!jsonMatch) return { platform, passed: true, issues: [], available: false, unavailableReason: "parse_failed" };

    const parsed = jsonMatch;
    return { platform, passed: parsed.passed !== false, issues: parsed.issues || [], available: true };
  } catch (err) {
    logger.warn({ tenantId, platform, err: errText(err) }, "7-28 平台规则检查不可用(转人工, ≠ 判违规)");
    return {
      platform, passed: true, issues: [], available: false,
      unavailableReason: isAiUnavailableError(err) ? "ai_unavailable" : "error",
    };
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
 *
 * ⚠️ 7-20 修「示例锚定」bug：输出 JSON 模板里原本写着具体分数 6/7/6/7/6/7，
 *   模型大面积照抄。生产实测（近30天 213 篇有评分的文章）：
 *     - 打分组合 `6/7/6/7/6/7` 占 **62%**，排名 2-8 的组合全是它只改一两维的变体
 *     - 总分恰好 65 的：国际刊 96/137(70%)、国内刊 39/76(51%)
 *     - 逐维均分国内 vs 国际几乎一致（数据准确 6.43 vs 6.98，其余差 <0.1）
 *   → 65 分天花板不是"内容只值 65"，也不是"用 SCI 标准评国内刊"，
 *     而是**评分器在复读 prompt 里的示例数字**。
 *   故模板改为 `<0-10整数>` 占位符 + 显式打分纪律（禁止六维分数雷同、别用 6/7 和稀泥）。
 *
 *   注：`data-collection/quality-check-engine.ts` 的 prompt 有同类问题（示例全是 "score": 0），
 *   是另一条独立评分链路，本次刻意不动 —— 一次只改一个变量，保证分布变化可归因。
 */
export async function sixDimQualityCheck(params: {
  tenantId: string;
  title: string;
  body: string;
  /**
   * 7-20 反"奖励编造": 传该刊 DB 事实, 正文出现无据的 IF/分区 → dataAccuracy 压到红线分。
   * 不传 = 完全退回原行为(零回归)。复用 compliance/content-check 的同一套判断, 不新造标准。
   */
  journalFacts?: import("../compliance/content-check.js").TitleDataDbFields;
  /** 7-27: 有则带进 ops_incidents.detail —— 简报报出"哪几篇没评上分"时能直接点开那篇 */
  contentId?: string;
}): Promise<SixDimResult> {
  const { tenantId, title, body, journalFacts, contentId } = params;
  // 7-20 反"奖励编造"(信任红线): 确定性前置扫描, 不靠 LLM 自觉。
  //   标题侧编造已由 batch-worker/ai-reviewer 的 checkTitleDataConsistency 转 needs_review;
  //   正文侧这里压分 —— 两侧合起来才是闭环。命中即 dataAccuracy 封顶 FABRICATION_CAP。
  const { findBodyFabrication } = await import("../compliance/content-check.js");
  const fabHits = findBodyFabrication(body, journalFacts);
  const plain = body.replace(/<[^>]+>/g, "");
  const plainLen = plain.replace(/\s+/g, "").length;
  // 7-03 评分视图去噪: shunshi 模板 HTML ~92% 是内联 <svg> 图表 + style 样式(32k HTML vs 2.5k 正文)。
  // 旧版喂 body.slice(0,4000) 原始 HTML → 前4000字符全被封面/数据卡/SVG 吃光, 评分器读不到后面的投稿实操段
  // → 实用/结构/密度 被误判低分 + "戛然而止"幻觉。改: 剥 SVG/style/注释保结构(<p>/<h3>/<img>), 放大预算装全篇。
  const scorerView = body
    .replace(/<svg[\s\S]*?<\/svg>/gi, "【图表】")
    .replace(/\sstyle="[^"]*"/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 9000);
  // 章节标题列表：让 LLM 的 weakestSection 落在真实章节名上，重写闭环才能定位
  const headings = [
    ...body.matchAll(/^##\s+(.+?)\s*$/gm),
    ...body.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi),
  ].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean).slice(0, 12);

  // 7-03 评分降级修复: deepseek-reasoner 偶发降级会污染首过率(旧 degradedSixDim 伪装 passed=true)。
  // 降级 → 自动重打 1 次; 两次都挂才判 degraded(下游转 needs_review, 不计入首过率)。
  //
  // ═══ 7-27 质检自愈: 主模型挂了自动换快模型, 别让整条产线停在一个模型上 ═══
  // 事故: 六维质检是全系统**唯一没有跨厂商兜底**的 LLM 链路(路由表 quality_check 的 primary 与
  //   fallback 都是 deepseek-v4-pro, 被去重后等于没有备选)。当天 v4-pro 60s 超时, 重打一次还是
  //   超时(同一个模型、同一条长提示, 第二次凭什么快?) → 20/25 条没评上分 → 零进草稿箱。
  // 打法(最多 3 次调用, 有上限不烧钱):
  //   ① primary(v4-pro) →
  //   ② 超时类失败 **直接换快模型**(不再原模型重打 —— 那是纯粹的 120s + 一次推理钱打水漂);
  //      输出解析类失败(模型有响应, 只是 JSON 坏了) 才保留"原模型重打 1 次"的旧行为 →
  //   ③ 仍失败 → 快模型(qwen-plus)。
  //   快模型也挂 → 停手, 判"没评上分"(quality_check_unavailable), 绝不无限重试。
  const MAX_SCORE_ATTEMPTS = 3;
  let tier: "primary" | "fallback" = "primary";
  let slowRetryUsed = false;   // 原模型的那 1 次重打用掉没有
  let timeoutReported = false; // quality_check_timeout 每篇只报一条, 不按 attempt 刷屏
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_SCORE_ATTEMPTS; attempt++) {
  try {
    const response = await chat({
      tenantId,
      userId: "system",
      conversationId: "quality-score-sixdim",
      message: `你是公众号内容总编"老韩"，按下面六个维度给这篇图文文章打分（每维 0-10 分）。这是发布线评审：8 分 = 能直接发的水平，普通 AI 初稿通常只有 5-6 分，别客气。

【六维评分标准（"8 分什么样"）】
1. 选题与钩子（权重20%）：8分 = 标题+开头抓人、直戳投稿/选刊痛点。痛点场景切入 / 开放式提问 / 真实数据反差 / 身份代入 / 悬念前置 等**任一钩子技法到位即算满分**；平铺直叙介绍背景 ≤5分。⚠️ **不得因"开头没有具体真实人物/学校/投稿经历案例"扣分**——本产品红线禁止编造案例, 缺"真人真事"不是扣分项, 也别在 fixHint 里要求补具体案例/学校/研究方向(那等于要求编造)。
2. 数据准确（权重25%）：8分 = 期刊硬指标（IF/分区/录用率/审稿周期）真实无误、口径一致；同时要求信息密度：**每 200 字至少 1 个具体硬数据（数字/指标/事实）**。请在 justification 里给出密度统计（如"全文约1800字，硬数据11个，约163字/个"）。空谈无数据 ≤4分。⚠️ 数据来自本产品核验过的期刊库, **不得因"没标注数据出处/来源链接/引用年份"扣分**(产品正文不外链出处), 只看数字是否真实、口径是否一致; 别在 fixHint 里要求补数据出处/来源/URL(那等于要求编造出处)。
3. 结构（权重20%）：8分 = 逻辑清晰、层次分明、无水分；有明显凑字/复读/套话段落 ≤5分。⚠️ **本维只看组织方式，不看有没有硬数据** —— 硬数据的多寡由第 2 维(数据准确)负责，在这里再扣一次就是同一件事扣两遍。缺数据的文章只要结构立得住，本维照给高分
4. 排版（权重15%）：8分 = 手机端阅读舒适：**短段落（每段≤3句/≤100字）+ 图文交替（每2-3小段有图/图表/数据卡区隔）+ 重点强调**（小标题、加粗）；出现连续大段文字（单段>5句或>200字、或连续4段以上无图无卡片）≤5分
5. 实用性（权重10%）：8分 = **读完能直接做成一件事** —— 读者合上页面就知道下一步动手做什么，且做得到。⚠️ **不限定是哪一类动作**：可以是投稿决策（谁该投/怎么投/避什么坑），也可以是自己去核对一个事实、按给出的口径筛一遍候选、判断自己的稿子够不够格、把某个清单拿去对照。判档：给出了具体可执行的下一步且信息足够执行 = 8分；只给方向不给做法（"要重视选题"这类）= 5分；通篇只有描述、读完不产生任何可做的事 ≤3分。🔴 **绝不因为"没写投稿建议"扣分** —— 那是体裁差异，不是实用性差异
6. 原创合规（权重10%）：8分 = 无违禁词、不像搬运、无 AI 腔套话堆砌

【待评文章】
标题: ${title}
全文纯文本字数: 约${plainLen}字
${headings.length > 0 ? `章节列表: ${headings.join(" / ")}` : ""}
正文（已去图表SVG/样式噪声, 保留段落结构; 全篇约${plainLen}字）:
${scorerView}

对每一维输出：score（0-10 整数）、weakestSection（拖后腿最严重的一节，必须从章节列表选，或写"开头"/"结尾"/"全文"）、fixHint（一句话怎么修，要具体可执行）、justification（一句评分理由）。

⚠️ **打分纪律**：下面只是**字段格式示例**，其中的分数占位符不是参考答案，更不是默认值。
每一维必须独立评估、给出你自己的判断分。六个维度的质量本来就参差不齐，**分数理应有高有低**；
如果你给出的六个分数高度接近或呈规律排列，说明你没有逐维真评，而是在套模板 —— 这是不合格的评分。
好的地方就给 8-9，差的地方就给 3-4，别用 6、7 和稀泥。

直接输出 JSON（不要 markdown 包裹，把 <> 占位符替换成真实值）:
{
  "topicHook": {"score": <0-10整数>, "weakestSection": "<章节名>", "fixHint": "<一句话怎么修>", "justification": "<一句评分理由>"},
  "dataAccuracy": {"score": <0-10整数>, "weakestSection": "<章节名>", "fixHint": "<一句话怎么修>", "justification": "全文约<X>字，硬数据<N>个，约<Y>字/个；<理由>"},
  "structureDensity": {"score": <0-10整数>, "weakestSection": "<章节名>", "fixHint": "<一句话怎么修>", "justification": "<一句评分理由>"},
  "formatting": {"score": <0-10整数>, "weakestSection": "<章节名>", "fixHint": "<一句话怎么修>", "justification": "<一句评分理由>"},
  "practicality": {"score": <0-10整数>, "weakestSection": "<章节名>", "fixHint": "<一句话怎么修>", "justification": "<一句评分理由>"},
  "originalityCompliance": {"score": <0-10整数>, "weakestSection": "<章节名>", "fixHint": "<一句话怎么修>", "justification": "<一句评分理由>"}
}`,
      // 7-27: primary → 路由表 quality_check 槽(推理型 v4-pro); fallback → quality_check_fast 槽(qwen-plus)
      skillType: tier === "primary" ? "quality_check" : "quality_check_fast",
      // 7-28 ②b: 主备全挂直接抛错。下面那行 isAiFallbackText 判据保留 —— 它防的是**别的路径**
      //   (如上游把兜底文案原样透传)混进来, 两道判据不冲突, 少一道就少一层网。
      throwOnExhausted: true,
    });

    // 7-27: chat() 主备全挂时**不抛错**, 而是返回一句兜底文案。原来这里只会得到
    //   "六维评分输出无 JSON" —— 于是"AI 根本没响应"被记成了"模型输出格式不对", 两种完全
    //   不同的故障混成一类, 告警也就无从区分。先显式识别兜底文案, 标成 AI 不可用。
    if (isAiFallbackText(response.content)) throw new QualityCheckAiUnavailable("AI 兜底文案(模型超时/主备全挂), 未评分");

    // 7-30: 原来是 `match(/\{[\s\S]*\}/)` + JSON.parse —— 对推理型模型不够。
    //   v4-pro 输出前跑思维链, reasoning/围栏/中途插话都会混进来; 而那个贪婪正则还会把
    //   JSON 之后正文里任何一个 `}` 也吞进来。生产实测单日 28 次不可解析, 每次都白花一次
    //   推理调用重打。改走确定性修复(剥围栏/剥 think/括号配平/去尾逗号/截断回退), 见 llm-json.ts。
    const { value: parsedRaw, repairs } = extractJsonObject(response.content);
    if (!parsedRaw || typeof parsedRaw !== "object") throw new Error("六维评分输出无 JSON");
    const parsed = parsedRaw as Record<string, { score?: unknown; weakestSection?: unknown; fixHint?: unknown; justification?: unknown }>;
    if (repairs.length > 0) {
      logger.info({ tenantId, contentId, tier, repairs, model: response.model },
        "P0① 六维评分 JSON 经修复后可解析(省下一次重打)");
    }

    /**
     * 🔴 8-22：**维度缺失 = 评分失败，绝不静默填 0**（老韩拍板）。
     *
     * ═══ 事故 ═══
     *
     * 同尺 5 轮标定实测：**7.6% 的评分调用产出垃圾分**，而且模式极其规整 ——
     *
     * ```
     *              topicH dataAc struct format practi origin   总分
     * 教育学报 r3        5     0      0      0      0      0     10
     * 江苏高教 r4        8     3      7      0      0      0     38
     * 图书情报 r1        8     0      0      0      0      0     16
     * ```
     *
     * **每次都是「前 N 维有分、后面全 0」** —— 模型输出被截断，
     * `extractJsonObject` 把残缺 JSON「修好」（补花括号），
     * 缺失的尾部维度经 `clamp(Number(undefined) → NaN → 0)` 变成 0 分。
     *
     * 零维频率严格按 JSON 出场顺序单调递增（topicHook 0 次 → originalityCompliance 19 次），
     * 这是截断的指纹，不可能是模型真的给 0。
     *
     * ═══ 后果 ═══
     *
     * 一篇中位 78 分的内容有 7.6% 概率被记成 16 分 → `sixDimPassed=false`
     * → 进不了草稿箱 / 被 <60 闸拦。**下游完全无法区分「内容差」和「评分挂了」。**
     * 而 7-27 那次血的教训写着：「我们的评分器挂了」≠「内容有问题」，
     * 当时的处置是把「没评上分」从红线里移出去 —— 但那条路只对**整体**失败生效，
     * 对这种**部分**失败完全失明，因为它伪装成了一个正常的低分。
     *
     * 这是红线 #14 的第七次，浓缩在一个三元表达式里：
     * `Number.isFinite(v) ? v : 0` —— 「解析不出来」被写成了「0 分」。
     *
     * ═══ 修法 ═══
     *
     * 任一维度缺失或分数不是有限数 → **抛错**，走既有的重打/降级链路，
     * 最终仍失败则判「没评上分」(quality_check_unavailable)。
     * 绝不返回一个数字 —— 数字会被当成结论。
     *
     * ⚠️ 不要改 `clamp` 去掉 NaN 兜底就算完：那只会让 NaN 传到总分变成 NaN，
     * 同样是静默的坏值。判据必须在**知道哪一维缺了**的这一层做。
     */
    const dims = {} as Record<SixDimKey, SixDimDetail>;
    const missing: string[] = [];
    for (const key of Object.keys(SIX_DIM_WEIGHTS) as SixDimKey[]) {
      const d = parsed[key];
      const rawScore = d && typeof d === "object" ? Number((d as { score?: unknown }).score) : Number.NaN;
      if (!Number.isFinite(rawScore)) {
        missing.push(key);
        continue;
      }
      dims[key] = {
        score: clamp(Math.round(rawScore), 0, 10),
        weakestSection: String(d.weakestSection || "全文"),
        fixHint: String(d.fixHint || ""),
        justification: String(d.justification || ""),
      };
    }
    if (missing.length > 0) {
      // 记一条足够定位的日志：缺了哪几维 + 是否经过修复 + 输出长度（截断的直接证据）
      logger.warn(
        { tenantId, contentId, tier, missing, repairs, model: response.model,
          outputLen: String(response.content ?? "").length,
          finishReason: (response as { finishReason?: string }).finishReason ?? null },
        "🔴 六维评分输出缺维(疑截断) —— 判为评分失败, 绝不按 0 分计",
      );
      throw new Error(`六维评分缺少维度: ${missing.join(",")}（疑输出截断）`);
    }

    // 7-20 反"奖励编造": 正文有无据 IF/分区 → dataAccuracy 硬压到 ≤3, 覆盖 LLM 给的分。
    //   编造不是"数据准确"而是数据造假 —— 编出来的数字恰恰会让密度/准确看起来达标(实测那篇
    //   编造 IF9.0+1区 的国内刊拿了 78 分, 全样本第二高), 所以必须由代码罚, 不能指望 LLM 自罚。
    //   只降不升: 若 LLM 本就给了 ≤3, 保持原分。
    if (fabHits.length > 0 && dims.dataAccuracy.score > FABRICATION_CAP) {
      const llmScore = dims.dataAccuracy.score;
      dims.dataAccuracy = {
        ...dims.dataAccuracy,
        score: FABRICATION_CAP,
        fixHint: `删除正文中无数据来源的指标: ${fabHits.join("、")}（该刊库内无此数据，写了即编造）`,
        justification: `【数据造假红线】正文出现 ${fabHits.length} 处无据指标(${fabHits.join("、")})，LLM 原评 ${llmScore} 分已压至 ${FABRICATION_CAP} 分。${dims.dataAccuracy.justification}`,
      };
      logger.warn({ tenantId, title: title.slice(0, 40), fabHits, llmScore }, "六维: 正文编造指标, dataAccuracy 压至红线分");
    }

    // 8-02 排版改由代码算，覆盖 LLM 给的分 —— 同 dataAccuracy 那处"代码罚"的道理。
    //
    //   Golden Set 归因实测(老板标 50 篇): 「排版乱/排版没法看」被抱怨 27 次,
    //   而 LLM 的 formatting 维平均给 7.0~7.4 —— 人一眼看出没法看, 它觉得挺好。
    //   病根不是判据没写对(prompt 里"单段>200字""连续4段无图"已经很精确), 是:
    //     ① LLM 不数数, 精确判据它只能"感觉一下"
    //     ② 它只看 body.slice(0,1500), 而排版是越到后面越松
    //   规则版判据照抄 prompt 那条, 只是改由代码精确执行 + 看全文, 见 formatting-metrics.ts。
    //
    //   与 dataAccuracy 的"只降不升"不同, 这里是**完全替换**: 那一维 LLM 只是偶尔漏判,
    //   这一维实测基本失效, 保留它的分只会引入噪音。LLM 原分记进 justification 供事后对比。
    //   逃生开关 FORMATTING_RULE_SCORE=0 可切回 LLM 评分。
    if (process.env.FORMATTING_RULE_SCORE !== "0") {
      const fmt = scoreFormatting(body);
      const llmScore = dims.formatting.score;
      const detail = fmt.deductions.filter((d) => d.points > 0).map((d) => d.reason).join("；") || "无明显问题";
      dims.formatting = {
        score: fmt.score,
        weakestSection: dims.formatting.weakestSection,
        fixHint: fmt.fixHint,
        justification: `【规则评分】${detail}。(LLM 原评 ${llmScore} 分，仅记录不采用)`,
      };
      if (Math.abs(fmt.score - llmScore) >= 3) {
        logger.info(
          { tenantId, title: title.slice(0, 40), ruleScore: fmt.score, llmScore, metrics: fmt.metrics },
          "六维: 排版规则分与 LLM 分差距 ≥3, 供校准阈值用"
        );
      }
    }

    // 加权总分：每维 score(0-10) × 权重(%)，除以 10 → 0-100
    // 例：全维 8 分 → 8×100/10 = 80 分（正好压在发布线上）
    const total = Math.round(
      (Object.keys(SIX_DIM_WEIGHTS) as SixDimKey[]).reduce(
        (sum, k) => sum + dims[k].score * SIX_DIM_WEIGHTS[k],
        0
      ) / 10
    );

    // 通过标准照 md：总分 ≥线 且无维度 <6
    //
    // 🔴 8-20: 总分线外化成 publish.sixDimTotalLine（默认仍是 SIX_DIM_PUBLISH_TOTAL=80，行为不变）。
    //   原因：8-20 确认公众号阅读回流永远不会有数据，「80 该不该是 80」从此没有数据答案、
    //   只能由人拍 —— 那就得让人改得动，并在参数页上写明「人工设定，无数据依据」。
    //
    // ⚠️ 每维 ≥6 的地板**刻意不外化**：它防的是"五项优秀掩盖一项致命"，
    //   是个约束不是偏好，不该和总分线放进同一个可互相补偿的旋钮里。
    const publishTotalLine = await getPublishTotalLine();
    const passed =
      total >= publishTotalLine &&
      (Object.values(dims) as SixDimDetail[]).every((d) => d.score >= SIX_DIM_PUBLISH_MIN_DIM);

    // 7-27: 分是降级快模型给的 → 落 incident(供简报统计 + 日后抽检降级分的可信度)。
    //   不阻塞: 降级分照常参与发布判定 —— 若一降级就转人工, 主模型一抖照样全线停产, 等于没自愈。
    if (tier === "fallback") {
      reportQualityIncident("quality_check_degraded", "warn",
        `六维质检由降级模型 ${response.model} 出分(主模型不可用): 《${title.slice(0, 40)}》 总分 ${total}`,
        { tenantId, title, contentId, extra: { scorerModel: response.model, totalScore: total, attempt } });
    }

    return {
      dims,
      totalScore: total,
      passed,
      publishTotalLine,
      dataDensity: dims.dataAccuracy.justification,
      degraded: false,
      scoredBy: tier,
      scorerModel: response.model,
    };
  } catch (err) {
    lastErr = err;
    const cls = classifyQualityFailure(err);
    // 主模型超时 → 立刻记一条(**每篇只记一条**), 不等最终结果: 即使降级救回来了, "主评分模型在超时"
    //   本身就是要报的信号(钱花了没拿到东西 + 分数换了把尺子), 等全挂才告警就晚了。
    if (tier === "primary" && cls === "timeout" && !timeoutReported) {
      timeoutReported = true;
      reportQualityIncident("quality_check_timeout", "warn",
        `六维质检主模型超时/无响应, 转降级模型重评: 《${title.slice(0, 40)}》`,
        { tenantId, title, contentId, extra: { attempt, error: errText(err) } });
    }

    const willBeLast = attempt >= MAX_SCORE_ATTEMPTS || tier === "fallback";
    logger.warn(
      { err: errText(err), attempt, tier, cls },
      willBeLast
        ? "P0① 六维评分主/降级模型均失败 → 未评上分(转 needs_review, 不计入首过率)"
        : tier === "primary" && (cls === "timeout" || slowRetryUsed)
          ? "P0① 六维评分主模型不可用, 自动换降级快模型重评"
          : "P0① 六维评分输出不可解析, 原模型重打 1 次"
    );
    if (willBeLast) break;

    if (cls === "timeout" || slowRetryUsed) tier = "fallback"; // 超时不原地重打(白等 + 白花钱)
    else slowRetryUsed = true;                                  // 输出坏 → 保留旧的"原模型重打 1 次"
  }
  }

  // 主模型 + 降级模型都没救回来 → 这篇**没评上分**(≠ 评了 0 分), 见 degradedSixDim 的注释
  const reason = classifyQualityFailure(lastErr) === "timeout" ? "AI 超时/无响应" : "评分输出解析失败";
  // 8-03: 主备全挂时**是什么原因**要一路带给上游 —— 欠费(quota_exceeded)和服务抖动
  //   (service_down)都是"内容没问题, 外部服务当时不可用", 充值/恢复后应该自动重评;
  //   只有 content_error(比如正文本身让模型解析不出 JSON)才是真该转人工的那一类。
  const { classifyFailure } = await import("../ops/failure-kind.js");
  const degradedKind = classifyFailure(lastErr);
  reportQualityIncident("quality_check_unavailable", "error",
    `六维质检未评上分(${reason}, 主+降级模型均失败): 《${title.slice(0, 40)}》 — ${errText(lastErr).slice(0, 120)}`,
    { tenantId, title, contentId, extra: { reason, failureKind: degradedKind, error: errText(lastErr).slice(0, 200) } });
  return { ...degradedSixDim(reason), degradedKind, degradedError: errText(lastErr).slice(0, 300) };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

/** chat() 返回兜底文案(= 这次调用等于没响应)时抛它, 与"输出解析失败"区分开 */
class QualityCheckAiUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityCheckAiUnavailable";
  }
}

/** 失败归类: timeout = AI 压根没给出内容(超时/主备全挂); degraded = 给了内容但评分不可用 */
export function classifyQualityFailure(err: unknown): "timeout" | "degraded" {
  if (err instanceof QualityCheckAiUnavailable) return "timeout";
  // 7-28 ②b: chat({throwOnExhausted}) 抛的"主备全挂"同属"AI 压根没给出内容"这一类,
  //   靠类型判而不是靠错误文案里有没有 "timeout" 这个词(文案随时会改, 类型不会)。
  if (isAiUnavailableError(err)) return "timeout";
  const msg = (err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "")).toLowerCase();
  return /abort|timeout|timed out|etimedout|超时/.test(msg) ? "timeout" : "degraded";
}

/**
 * 7-27: 质检异常 → 落 ops_incidents。**这是昨天新建告警体系最大的盲区**:
 *   当天 25 条内容里 20 条因 LLM 60s 超时评分为 0 → 被红线剔除、零进草稿箱,
 *   而 ops_incidents 一条都没有, 只能靠人肉翻日志才看出来。
 *
 * 三个 kind 各自的语义(简报按 kind 分别汇总):
 *   quality_check_timeout     主评分模型超时, 已自动转降级模型(每篇至多一条)
 *   quality_check_degraded    这篇的分是降级快模型给的(分可用, 尺子换了)
 *   quality_check_unavailable 主+降级都失败, 这篇**没评上分**
 *
 * 刻意**不节流**: 一条事件 = 一篇内容的遭遇, 条数本身就是要看的量(简报那句"今日有 N 条内容
 *   没评上分"就是数它)。量级可控: 每篇每个 kind 至多一条, 且降级后 quality-pipeline 会跳过
 *   重写循环, 不会对同一篇反复打分。—— 与 llm_timeout(上游一坏就几十次)刻意不同, 那类才节流。
 * 旁路: 整段包在 void async + try/catch 里, 告警失败绝不影响生成。
 */
// 动态 import 记忆化: 一篇内容可能连发两条事件(如 timeout + degraded), 两次并发 import()
// 同一模块在 vitest 的模块运行器下第二个 promise 会永远不 resolve(单测实测), 生产上也省重复解析。
let incidentsModule: Promise<typeof import("../ops/incidents.js")> | null = null;

function reportQualityIncident(
  kind: "quality_check_timeout" | "quality_check_degraded" | "quality_check_unavailable",
  severity: "warn" | "error",
  message: string,
  ctx: { tenantId: string; title: string; contentId?: string; extra?: Record<string, unknown> },
): void {
  void (async () => {
    try {
      const { recordIncident } = await (incidentsModule ??= import("../ops/incidents.js"));
      await recordIncident({
        kind,
        severity,
        tenantId: ctx.tenantId,
        message: message.slice(0, 500),
        detail: { ...(ctx.contentId ? { contentId: ctx.contentId } : {}), title: ctx.title.slice(0, 120), ...(ctx.extra ?? {}) },
      });
    } catch {
      /* 告警旁路失败不影响生成 */
    }
  })();
}

/**
 * LLM 两次均失败兜底：degraded=true + passed=false。
 * 7-03 改: 旧版 passed=true+80分 会把"没打成分"伪装成"过线", 污染首过率并让降级文章直接放行。
 * 改为 passed=false → batch-worker 转 needs_review(人工复核); degraded 标记让首过率统计把它排除在分母外。
 * (degraded 仍跳过重写循环, 见 quality-pipeline 的 sixDim.degraded 判断, 不会拿默认分瞎重写烧钱)
 */
function degradedSixDim(reason = "评分服务降级"): SixDimResult {
  const dims = {} as Record<SixDimKey, SixDimDetail>;
  for (const key of Object.keys(SIX_DIM_WEIGHTS) as SixDimKey[]) {
    dims[key] = { score: 0, weakestSection: "全文", fixHint: "", justification: `${reason}，未评上分(不是 0 分)` };
  }
  // 7-28 阶段1-C: totalScore 由 0(类型占位) 改为 **null**(= 没评上分)。
  //   语义没变, 变的是"消费方忘了看 degraded"这件事从此编译不过 —— 见 SixDimResult.totalScore 的注释。
  //   dims 里各维仍是 0: 那是 SixDimDetail.score 的类型(number), 但 justification 已写明"未评上分",
  //   且 degraded=true 时任何消费方都不该读 dims(generateFeedback 的低分维度列表就跳过了)。
  return { dims, totalScore: null, passed: false, dataDensity: `${reason}，无统计`, degraded: true, degradedReason: reason };
}

/** 7-20 编造红线封顶分: 正文出现无据 IF/分区 时 dataAccuracy 的上限。
 *  取 3 是因为发布线要求"总分≥80 且无维度<6" —— 压到 3 必然挡住发布, 且在重写闭环里
 *  会成为最弱维度被优先修(fixHint 直接告诉它删掉哪几个无据数字)。 */
const FABRICATION_CAP = 3;

/**
 * ⚠️ 8-22：`Number.isFinite(v) ? v : 0` 这一段曾是 7.6% 垃圾分的病灶 ——
 * 维度解析不出来时 NaN 被静默写成 0 分，下游读成"这一维极差"。
 *
 * 现在**缺维在上游就抛错**（见六维解析处的 missing 判据），
 * 本函数的 NaN 兜底只作最后一道防御，**不再承担任何判据职责**。
 * 🔴 不要把"某维是否有效"的判断退回到这里 —— 它看不到是哪一维、也没法重试。
 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Number.isFinite(v) ? v : 0, min), max);
}

const UNAVAILABLE_CHECK_LABEL: Record<string, string> = { redline: "红线校验", style: "风格一致性", platform: "平台规则" };
const UNAVAILABLE_REASON_LABEL: Record<string, string> = {
  rules_unavailable: "规则库查不了",
  ai_unavailable: "AI 没响应",
  parse_failed: "AI 输出解析不出来",
  error: "检查异常",
  unknown: "原因未知",
};

function generateFeedback(
  sixDim: SixDimResult,
  redline: QualityCheckV2Result["redlineCheck"],
  style: QualityCheckV2Result["styleCheck"],
  platform: QualityCheckV2Result["platformCheck"] | null,
  htmlIntegrity?: QualityCheckV2Result["htmlIntegrity"],
  unavailableChecks?: QualityCheckV2Result["unavailableChecks"],
): string {
  const parts: string[] = [];

  // 7-28: "没检查成"排在最前, 且措辞必须与"违规"泾渭分明 —— 运营看到这句要知道
  //   「内容本身没查出问题, 是我们的检查器当时不可用」, 而不是去删稿。
  if (unavailableChecks && unavailableChecks.length > 0) {
    const names = unavailableChecks
      .map((u) => `${UNAVAILABLE_CHECK_LABEL[u.check] ?? u.check}(${UNAVAILABLE_REASON_LABEL[u.reason] ?? u.reason})`)
      .join("、");
    parts.push(`⚠️ 以下检查未能完成: ${names} —— 这不是内容违规, 是检查器当时不可用, 已转人工复核`);
  }

  // 7-28 阶段1-C: 没评上分(totalScore=null) 必须单独说, 绝不能落进"未达 80 分发布线" ——
  //   运营看到"未达 80 分"会去改内容, 而真相是评分器当时挂了, 内容一个字都没被看过。
  //   这正是 7-27 事故在**人机界面**上的同一个错: 把"没评"说成"评差了"。
  if (sixDim.totalScore === null) {
    parts.push(`⚠️ 未评上分(${sixDim.degradedReason ?? "评分服务降级"}) —— 这不是"0 分", 是评分器当时不可用, 已转人工复核`);
  } else if (sixDim.totalScore >= SIX_DIM_EXCELLENT_SCORE) parts.push("内容质量优秀");
  // 🔴 这里显示的线必须是**当时判定用的那条线**, 不能是代码常量 ——
  //   参数改过之后两者会不一致, 运营看到"未达 80"而系统按 75 判, 正是红线 #20 的形态。
  //   sixDim.publishTotalLine 由判定处一同带出。
  else if (sixDim.passed) parts.push(`内容质量达到 ${sixDim.publishTotalLine ?? SIX_DIM_PUBLISH_TOTAL} 分发布线`);
  else parts.push(`内容质量未达 ${sixDim.publishTotalLine ?? SIX_DIM_PUBLISH_TOTAL} 分发布线`);

  // 列出 <8 的低分维度（老韩打分流程：标出 <8 的维度逐个抬）
  const lows = (Object.keys(sixDim.dims) as SixDimKey[])
    .filter((k) => sixDim.dims[k].score < SIX_DIM_WEAK_DIM_HINT)
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

/**
 * 7-28 ②c: 知识库检索 —— **失败态必须能被上层区分**。
 *
 * 旧版异常时 `return []`, 于是"检索挂了"和"这个租户没配规则"长得一模一样。
 * 后果是 7-25「三道闸同源」的新同构点: semanticSearch 一挂, 红线 + 风格 + 平台
 * 三道检查同时拿到空数组 → 三个都走"无规则可查 → passed" → 一次故障同时打穿三道闸。
 * 三道闸只要都读同一份数据源, 就不是三道闸, 是一道闸抄了三遍(CLAUDE.md 里的原话)。
 *
 * 现在返回 { ok, results }: ok=false 明确是"查不了", 调用方据此判"不可用"而不是"通过"。
 */
async function safeSearch(
  tenantId: string,
  query: string,
  category: VectorCategory,
  limit: number
): Promise<{ ok: boolean; results: Awaited<ReturnType<typeof semanticSearch>> }> {
  try {
    return { ok: true, results: await semanticSearch({ tenantId, query, category, limit, minScore: 0.1 }) };
  } catch (err) {
    logger.warn({ tenantId, category, err: errText(err) }, "7-28 知识库检索失败 → 该道检查判「不可用」(不再当作无规则放行)");
    return { ok: false, results: [] };
  }
}
