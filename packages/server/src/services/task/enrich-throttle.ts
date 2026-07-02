/**
 * B.3 batch enrich-all 节流 + 反爬硬护栏 helpers。
 *
 * 抽出来便于单测（不需要起 BullMQ / Redis）。
 *
 * 反爬检测策略（不改 fetcher / orchestrator 的边界内）：
 * 用 successFields 是否含 LetPub 派生字段（if_history / jcr_full / publication_stats）
 * 作为 "LetPub 这条拿到数据了" 的代理信号。连续 ≥5 条都没拿到 → 大概率反爬或 LetPub
 * 库系统性失败，立即 abort 整个批次保护 IP / 退避到下次手动触发。
 *
 * 注：BMJ-style 单条 URL 模式问题（task #70）会假阳性触发 streak，但 B.3 策略保守一致 —
 * 5 条连续没拿到数据无论原因都该停下来排查。
 */

import type { LetpubOutcomeKind } from "../journal-enricher/types.js";

export const MAX_LETPUB_FAIL_STREAK = 5;
const LETPUB_DERIVED_FIELDS = ["if_history", "jcr_full", "publication_stats"] as const;

/** orchestrator successFields 中是否含 LetPub 派生字段 */
export function letpubGotData(successFields: string[]): boolean {
  return LETPUB_DERIVED_FIELDS.some((f) => successFields.includes(f));
}

/** 计算下一次 sleep 时长：delayMs ± jitterMs 均匀随机 */
export function nextDelayMs(delayMs: number, jitterMs: number): number {
  if (delayMs <= 0) return 0;
  const j = jitterMs > 0 ? Math.floor(Math.random() * jitterMs * 2) - jitterMs : 0;
  return Math.max(0, delayMs + j);
}

/**
 * Fisher-Yates 洗牌（B.3.1 修：seed 数据按学科聚集，连续 5 条中文法学期刊触发 streak
 * 假阳性 abort 整个批次）。打散到批次随机位置避免 N 连击。
 * 不变 input；返回新数组。
 */
export function shuffleFisherYates<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 串行 worker 内的失败计数器（concurrency=1 前提，所以单实例够用）。
 * worker 重启自动归零。
 */
export class LetPubFailStreakTracker {
  private streak = 0;
  private okCount = 0;
  private notFoundCount = 0;
  private blockedCount = 0;
  /**
   * 7-02 分级计数(取代旧的"没数据就+1"):
   *  - "blocked"(真反爬: HTTP 4xx/5xx/超时/解析异常页) → streak+1(才可能触发 5 连败 abort)
   *  - "ok" → streak 归零
   *  - "not_found"(正常返回页面但无匹配=自然查无) → 不动 streak, 可继续(计入软封统计)
   *  - "skipped"(ENRICH_SKIP_LETPUB, LetPub 压根没跑) → 完全不计(修 B-10 bug)
   */
  observe(outcome: LetpubOutcomeKind): void {
    if (outcome === "skipped") return;
    if (outcome === "ok") { this.streak = 0; this.okCount += 1; }
    else if (outcome === "blocked") { this.streak += 1; this.blockedCount += 1; }
    else if (outcome === "not_found") { this.notFoundCount += 1; }
  }
  shouldAbort(): boolean {
    return this.streak >= MAX_LETPUB_FAIL_STREAK;
  }
  current(): number {
    return this.streak;
  }
  reset(): void {
    this.streak = 0;
  }
  /**
   * 软封检测统计: ran=真正跑过 LetPub 的条数(不含 skipped)。
   * notFoundRate 异常高(如 >0.7)= 疑似软封(LetPub 返回空页而非报错, 断路器会失明), 调用方据此 warn。
   */
  stats(): { ok: number; notFound: number; blocked: number; ran: number; notFoundRate: number } {
    const ran = this.okCount + this.notFoundCount + this.blockedCount;
    return {
      ok: this.okCount, notFound: this.notFoundCount, blocked: this.blockedCount,
      ran, notFoundRate: ran ? this.notFoundCount / ran : 0,
    };
  }
}
