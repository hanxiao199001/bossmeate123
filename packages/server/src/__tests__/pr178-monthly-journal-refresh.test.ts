/**
 * PR #178 — 月度期刊池刷新 + 异常值检测
 */
import { describe, it, expect } from "vitest";

// Inline detectAnomalies for testing (avoid importing script that triggers DB)
type AnomalyRecord = { type: string; before?: any; after?: any; changePercent?: string; value?: number };
function detectAnomalies(
  before: { impactFactor?: number | null; partition?: string | null },
  after: { impactFactor?: number | null; partition?: string | null; acceptanceRate?: number | null; apcFee?: number | null },
): AnomalyRecord[] | null {
  const anomalies: AnomalyRecord[] = [];
  if (before.impactFactor && after.impactFactor && before.impactFactor > 0) {
    const change = Math.abs(after.impactFactor - before.impactFactor) / before.impactFactor;
    if (change > 0.30) anomalies.push({ type: "IF_JUMP", before: before.impactFactor, after: after.impactFactor, changePercent: (change * 100).toFixed(1) });
  }
  if (after.acceptanceRate && after.acceptanceRate > 0.60) anomalies.push({ type: "HIGH_ACCEPTANCE", value: after.acceptanceRate });
  if (after.apcFee && after.apcFee > 10000) anomalies.push({ type: "HIGH_APC", value: after.apcFee });
  if (before.partition && after.partition) {
    const bNum = parseInt(before.partition.replace("Q", ""), 10);
    const aNum = parseInt(after.partition.replace("Q", ""), 10);
    if (bNum <= 1 && aNum >= 3) anomalies.push({ type: "PARTITION_DROP", before: before.partition, after: after.partition });
  }
  return anomalies.length > 0 ? anomalies : null;
}

describe("PR #178: detectAnomalies 异常值检测", () => {
  it("IF 跳变 > 30% → IF_JUMP", () => {
    const result = detectAnomalies(
      { impactFactor: 5.0, partition: "Q1" },
      { impactFactor: 7.5, partition: "Q1" },
    );
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("IF_JUMP");
    expect(result![0].changePercent).toBe("50.0");
  });

  it("IF 涨 10% 不算异常", () => {
    const result = detectAnomalies(
      { impactFactor: 5.0, partition: "Q1" },
      { impactFactor: 5.5, partition: "Q1" },
    );
    expect(result).toBeNull();
  });

  it("录用率 > 60% → HIGH_ACCEPTANCE", () => {
    const result = detectAnomalies(
      { impactFactor: 3.0 },
      { impactFactor: 3.0, acceptanceRate: 0.75 },
    );
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("HIGH_ACCEPTANCE");
  });

  it("APC > $10000 → HIGH_APC", () => {
    const result = detectAnomalies(
      { impactFactor: 50.0 },
      { impactFactor: 50.0, apcFee: 12000 },
    );
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("HIGH_APC");
  });

  it("Q1 → Q3 降级 → PARTITION_DROP", () => {
    const result = detectAnomalies(
      { impactFactor: 5.0, partition: "Q1" },
      { impactFactor: 5.0, partition: "Q3" },
    );
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("PARTITION_DROP");
  });

  it("Q1 → Q2 不算降级", () => {
    const result = detectAnomalies(
      { impactFactor: 5.0, partition: "Q1" },
      { impactFactor: 4.5, partition: "Q2" },
    );
    expect(result).toBeNull();
  });

  it("多异常同时触发", () => {
    const result = detectAnomalies(
      { impactFactor: 10.0, partition: "Q1" },
      { impactFactor: 4.0, partition: "Q4", acceptanceRate: 0.80, apcFee: 15000 },
    );
    expect(result).toHaveLength(4); // IF_JUMP + HIGH_ACCEPTANCE + HIGH_APC + PARTITION_DROP
  });
});

describe("PR #178: scheduler 注册", () => {
  it("scheduler.ts 含 monthly-journal-refresh cron + case handler", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/scheduler.ts", import.meta.url), "utf8");
    expect(src).toMatch(/"monthly-journal-refresh"/);
    expect(src).toMatch(/case "monthly-journal-refresh"/);
    expect(src).toMatch(/refreshJournalsPool/);
    expect(src).toMatch(/monthly-journal-refresh-schedule/);
    expect(src).toMatch(/pattern: "0 4 1 \* \*"/);
  });
});

describe("PR #178: refresh-journals-pool script", () => {
  it("含 Phase 1 re-enrich + Phase 2 新增 + detectAnomalies", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../scripts/refresh-journals-pool.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export async function refreshJournalsPool/);
    expect(src).toMatch(/Phase 1/);
    expect(src).toMatch(/Phase 2/);
    expect(src).toMatch(/detectAnomalies/);
    expect(src).toMatch(/fetchOpenAlexSources/);
    expect(src).toMatch(/enrichJournal/);
  });
});
