/**
 * B.3 throttle helpers 单测（不起 BullMQ / Redis）。
 *
 * 覆盖：
 *  - letpubGotData：success 字段判定
 *  - nextDelayMs：jitter 范围 + 边界
 *  - LetPubFailStreakTracker：streak 累加 / reset / abort 触发
 */

import { describe, it, expect } from "vitest";
import {
  letpubGotData,
  nextDelayMs,
  LetPubFailStreakTracker,
  MAX_LETPUB_FAIL_STREAK,
} from "../services/task/enrich-throttle.js";

describe("letpubGotData", () => {
  it("returns true when at least one LetPub-derived field succeeded", () => {
    expect(letpubGotData(["if_history", "recommendation_score"])).toBe(true);
    expect(letpubGotData(["jcr_full"])).toBe(true);
    expect(letpubGotData(["publication_stats"])).toBe(true);
  });
  it("returns false when only non-LetPub fields succeeded (score-only or DOAJ-only)", () => {
    expect(letpubGotData(["recommendation_score"])).toBe(false);
    expect(letpubGotData(["publication_costs", "recommendation_score"])).toBe(false);
    expect(letpubGotData([])).toBe(false);
  });
});

describe("nextDelayMs", () => {
  it("returns 0 when delayMs <= 0 (single-enrich path, no throttle)", () => {
    expect(nextDelayMs(0, 0)).toBe(0);
    expect(nextDelayMs(0, 5000)).toBe(0);
    expect(nextDelayMs(-1, 1000)).toBe(0);
  });
  it("delayMs only (jitter=0): returns exactly delayMs", () => {
    expect(nextDelayMs(10000, 0)).toBe(10000);
  });
  it("delayMs ± jitter stays within [delay-jitter, delay+jitter]", () => {
    for (let i = 0; i < 100; i++) {
      const v = nextDelayMs(10000, 3000);
      expect(v).toBeGreaterThanOrEqual(7000);
      expect(v).toBeLessThanOrEqual(13000);
    }
  });
  it("never goes negative even if jitter > delay (clamped to 0)", () => {
    for (let i = 0; i < 50; i++) {
      const v = nextDelayMs(500, 3000);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("LetPubFailStreakTracker", () => {
  it("starts at 0, not aborting", () => {
    const t = new LetPubFailStreakTracker();
    expect(t.current()).toBe(0);
    expect(t.shouldAbort()).toBe(false);
  });
  it("each LetPub-empty enrich bumps streak; LetPub-success resets", () => {
    const t = new LetPubFailStreakTracker();
    t.observe(["recommendation_score"]); // 1
    t.observe(["recommendation_score"]); // 2
    expect(t.current()).toBe(2);
    t.observe(["if_history", "recommendation_score"]); // reset
    expect(t.current()).toBe(0);
    expect(t.shouldAbort()).toBe(false);
  });
  it("triggers abort exactly at MAX_LETPUB_FAIL_STREAK consecutive empties (= 5)", () => {
    const t = new LetPubFailStreakTracker();
    for (let i = 0; i < MAX_LETPUB_FAIL_STREAK - 1; i++) {
      t.observe(["recommendation_score"]);
      expect(t.shouldAbort()).toBe(false);
    }
    t.observe(["recommendation_score"]); // 5th
    expect(t.current()).toBe(MAX_LETPUB_FAIL_STREAK);
    expect(t.shouldAbort()).toBe(true);
  });
  it("reset() clears streak (admin / restart-equivalent)", () => {
    const t = new LetPubFailStreakTracker();
    for (let i = 0; i < 6; i++) t.observe(["recommendation_score"]);
    expect(t.shouldAbort()).toBe(true);
    t.reset();
    expect(t.current()).toBe(0);
    expect(t.shouldAbort()).toBe(false);
  });
});
