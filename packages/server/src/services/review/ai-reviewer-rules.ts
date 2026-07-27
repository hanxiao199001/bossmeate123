/**
 * 7-05 ④ AI 审稿员 — 纯函数规则层 (无 DB/env 依赖, 供单测直接 import)。
 *
 * 职责边界:
 *   - 入池过滤: 只接"六维低分"类待审 (60-79 分灰区); 红线类(标题矛盾/数字编造/评分降级)永远留人工。
 *   - few-shot 构建: 从人工校准样本(contents.metadata.calibration, source=human)取采用/驳回各 2-3 条,
 *     作"老韩的标准"锚定; 没有样本时用保守通用标准并降 confidence。
 *   - LLM 输出解析: JSON {verdict, confidence, reason}, 解析失败一律 unsure(宁可留人)。
 */

/** 红线类待审原因 — AI 永远不碰, 留人工 (信任事故类, 不是"质量灰区") */
export const REDLINE_REVIEW_REASONS = new Set([
  "title_body_inconsistent", // 标题-正文矛盾 (标题喊保录, 正文有风险信号)
  "title_data_fabricated",   // 标题数字 DB 无据 (疑编造审稿周期/录用率)
  "sixdim_degraded",         // 评分器降级 (分数本身不可信, 复审无锚) — 7-27 前旧名, 库里有存量
  "quality_check_unavailable", // 7-27 新名: 主+降级模型均失败, 这篇**没评上分** — 无分数锚, AI 复审无从下手, 留人工
  "body_fabrication",        // 正文编造 IF/分区 (7-21 发布硬闸打的标, 数据造假红线)
  "output_unhealthy",        // 7-27 出稿健康闸: 占位文/截断/复读 —— 不是"质量灰区"而是废稿, 复审毫无意义
]);

/** 灰区分数带: 六维总分 60-79 (80 是发布线; <60 太差没有复审价值, 直接留人) */
export const GRAY_ZONE_MIN = 60;
export const GRAY_ZONE_MAX = 79;

export interface EligibilityInput {
  status: string | null;
  metadata: Record<string, unknown> | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
}

/**
 * 入池条件: status=needs_review 且 reviewReason 属"六维低分"类 且 总分 60-79。
 * 已有 aiReview 记录的不重复审 (幂等, 也防每小时扫描重复烧 token)。
 */
export function isEligibleForAiReview(c: EligibilityInput): EligibilityResult {
  if (c.status !== "needs_review") return { eligible: false, reason: `状态非待审 (${c.status})` };
  const md = (c.metadata ?? {}) as Record<string, unknown>;
  if (md.aiReview) return { eligible: false, reason: "已有 AI 审稿记录" };
  const nrr = typeof md.needsReviewReason === "string" ? md.needsReviewReason : null;
  if (nrr && REDLINE_REVIEW_REASONS.has(nrr)) {
    return { eligible: false, reason: `红线类待审(${nrr}), 留人工` };
  }
  const total = Number(md.sixDimTotal);
  if (!Number.isFinite(total)) return { eligible: false, reason: "无六维总分(非六维低分类待审)" };
  if (total < GRAY_ZONE_MIN || total > GRAY_ZONE_MAX) {
    return { eligible: false, reason: `总分 ${total} 不在灰区 ${GRAY_ZONE_MIN}-${GRAY_ZONE_MAX}` };
  }
  return { eligible: true, reason: "六维低分灰区" };
}

// ===== few-shot 人工锚定样本 =====

export interface CalibrationSampleLite {
  verdict: "accept" | "reject";
  reason?: string | null;
  sixDimTotal?: number | null;
  title?: string | null;
  at?: string | null;
}

export interface FewShotResult {
  block: string;       // 拼进 prompt 的样本文本 (空字符串 = 无样本)
  hasSamples: boolean; // false → 调用方须降 confidence (保守通用标准)
  used: { accept: number; reject: number };
}

const FEWSHOT_PER_VERDICT = 3; // 采用/驳回各取最多 3 条

/**
 * 构建 few-shot 锚定块。输入应已按时间倒序 (最近的在前)。
 * 采用/驳回各取 2-3 条含理由的最近样本; 无理由的样本兜底也可用 (只是锚定弱一点)。
 */
export function buildFewShotBlock(samples: CalibrationSampleLite[]): FewShotResult {
  const pick = (v: "accept" | "reject") => {
    const all = samples.filter((s) => s.verdict === v);
    // 含理由的优先 (锚定信息量大), 不足再拿无理由的补位
    const withReason = all.filter((s) => s.reason && String(s.reason).trim());
    const rest = all.filter((s) => !s.reason || !String(s.reason).trim());
    return [...withReason, ...rest].slice(0, FEWSHOT_PER_VERDICT);
  };
  const accepts = pick("accept");
  const rejects = pick("reject");
  if (accepts.length === 0 && rejects.length === 0) {
    return { block: "", hasSamples: false, used: { accept: 0, reject: 0 } };
  }
  const fmt = (s: CalibrationSampleLite, label: string) => {
    const bits = [
      s.title ? `《${String(s.title).slice(0, 40)}》` : null,
      Number.isFinite(Number(s.sixDimTotal)) ? `六维总分 ${s.sixDimTotal}` : null,
      s.reason && String(s.reason).trim() ? `理由: ${String(s.reason).slice(0, 120)}` : null,
    ].filter(Boolean);
    return `- 人工判「${label}」${bits.length ? " — " + bits.join("; ") : ""}`;
  };
  const lines = [
    "【老韩(人工)的历史裁决锚定 — 你的标准要向这些看齐】",
    ...accepts.map((s) => fmt(s, "采用")),
    ...rejects.map((s) => fmt(s, "驳回")),
  ];
  return {
    block: lines.join("\n"),
    hasSamples: true,
    used: { accept: accepts.length, reject: rejects.length },
  };
}

// ===== LLM 输出解析 =====

export type AiVerdict = "approve" | "reject" | "unsure";

export interface ParsedVerdict {
  verdict: AiVerdict;
  confidence: number; // 0-1
  reason: string;
}

/**
 * 解析 LLM 输出的 JSON {verdict, confidence, reason}。
 * 容错: markdown 包裹/前后废话 → 提取第一个 {...}; 任何解析失败 → unsure/0 (宁可留人, 绝不误放行)。
 */
export function parseVerdict(raw: string): ParsedVerdict {
  const fallback: ParsedVerdict = { verdict: "unsure", confidence: 0, reason: "LLM 输出无法解析" };
  if (!raw || typeof raw !== "string") return fallback;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const v = String(j.verdict ?? "").toLowerCase();
    const verdict: AiVerdict = v === "approve" || v === "reject" ? (v as AiVerdict) : "unsure";
    let confidence = Number(j.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));
    const reason = String(j.reason ?? "").slice(0, 300) || "(无理由)";
    return { verdict, confidence, reason };
  } catch {
    return fallback;
  }
}

// ===== live 模式安全阀 =====

/**
 * 日上限判定: 该租户今日 live 自动裁决数 >= cap → 本条只能按 shadow 记录。
 * (纯函数; 计数由调用方查 DB 得来)
 */
export function isUnderDailyCap(actionedTodayCount: number, cap: number): boolean {
  if (!Number.isFinite(cap) || cap <= 0) return false; // cap<=0 = 完全禁止 live 动作
  return actionedTodayCount < cap;
}

/**
 * live 决策: 结合 verdict/confidence/阈值/日上限/few-shot 缺失, 得出最终动作。
 *   - 无人工样本 → confidence 上限压到 0.6 (保守通用标准不足以自动放行)
 *   - approve 且 confidence>=阈值 且 未超日上限 → action=approve
 *   - reject (任意 confidence, 但也需未超日上限) → action=reject; 低于 0.5 的 reject 视为拿不准 → hold
 *   - 其余 → hold (留 needs_review)
 */
export function decideLiveAction(params: {
  verdict: AiVerdict;
  confidence: number;
  minConfidence: number;
  underCap: boolean;
  hasFewShot: boolean;
}): { action: "approve" | "reject" | "hold"; effectiveConfidence: number } {
  let conf = params.confidence;
  if (!params.hasFewShot) conf = Math.min(conf, 0.6); // 无锚定样本 → 保守降信心
  if (!params.underCap) return { action: "hold", effectiveConfidence: conf };
  if (params.verdict === "approve" && conf >= params.minConfidence) {
    return { action: "approve", effectiveConfidence: conf };
  }
  if (params.verdict === "reject" && conf >= 0.5) {
    return { action: "reject", effectiveConfidence: conf };
  }
  return { action: "hold", effectiveConfidence: conf };
}
