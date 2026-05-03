/**
 * Stage 自动推进 (B.4)
 *
 * Transition table 锁定（设计文档 D3）：
 *   new          → contacted     首次 inbound 触发（保留 B.3 行为）
 *   contacted    → qualified     inboundTurnCount ≥ 3 且 intent ≥ 60
 *   qualified    → negotiating   intent ≥ 80 且本轮含正向词
 *   negotiating / need_human / won / lost  不再 AI 自动推（销售手动 PATCH）
 *
 * 关键约束：
 *   - hard guard 命中 → caller 已 short-circuit return，不会走到这里
 *   - LLM 失败 → caller 跳过 evaluateStageTransition（保留 B.1 行为）
 *   - 阈值 60/80 + 正向词 v1 硬编码，浸泡期可调
 *   - lead_stage_history 审计表 B.5b 后置；当前用 logger.info 在 caller 内打 transition 事件
 */

const POSITIVE_KEYWORDS = ["投稿", "推荐", "看起来不错", "OK"];
const QUALIFIED_TURN_THRESHOLD = 3;
const QUALIFIED_INTENT_THRESHOLD = 60;
const NEGOTIATING_INTENT_THRESHOLD = 80;

export interface StageTransitionInput {
  currentStage: string;
  intentScore: number;
  inboundTurnCount: number;
  latestInbound: string;
}

export interface StageTransitionResult {
  newStage: string;
  changed: boolean;
  reason: string;
}

/**
 * 纯函数：根据当前 stage / intent / 轮数 / 本轮文本，决定是否推进。
 * 不命中任何 transition → newStage = currentStage, changed = false。
 */
export function evaluateStageTransition(input: StageTransitionInput): StageTransitionResult {
  const { currentStage, intentScore, inboundTurnCount, latestInbound } = input;

  if (currentStage === "new") {
    return { newStage: "contacted", changed: true, reason: "first_response" };
  }

  if (
    currentStage === "contacted" &&
    inboundTurnCount >= QUALIFIED_TURN_THRESHOLD &&
    intentScore >= QUALIFIED_INTENT_THRESHOLD
  ) {
    return { newStage: "qualified", changed: true, reason: "qualified_threshold" };
  }

  if (
    currentStage === "qualified" &&
    intentScore >= NEGOTIATING_INTENT_THRESHOLD &&
    POSITIVE_KEYWORDS.some((k) => latestInbound.includes(k))
  ) {
    return { newStage: "negotiating", changed: true, reason: "negotiating_positive_signal" };
  }

  // negotiating / need_human / won / lost / 未达阈值 → 不动
  return { newStage: currentStage, changed: false, reason: "no_transition" };
}
