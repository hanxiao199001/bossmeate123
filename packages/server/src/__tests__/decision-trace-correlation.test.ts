/**
 * 8-23 决策留痕的 intent ↔ consumption 串联 —— 行为锁（红线 #15：锁行为不锁源码字面）。
 *
 * ═══ 为什么这条值钱 ═══
 *
 * 实测（8-23，近 14 天）：
 *
 * ```
 * daily_cron_article   intent 126 / consumption 126   ← 成对
 * daily_cron_roundup   intent   0 / consumption  36   ← 只有一半
 * ```
 *
 * 消耗侧只记**成功拿到**的刊。所以「想要 3 本、只拿到 2 本」这类
 * **选不出刊的失败在留痕里完全不可见** —— 而 roundup 恰好最容易撞冷却
 * （一篇吃 3 本、15 天冷却、小学科一轮见底）。
 *
 * 两侧串上同一个 correlationId 之后，差额才成为一个能查出来的数。
 *
 * ⚠️ 本文件锁的是**串联机制**。daily-cron 那处接线属"真环境才验得了"的部分，
 *   不在这里假装覆盖（红线 #25）——它由今晚 19:00Z 那轮 cron 的真实留痕验收。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const inserted: Array<Record<string, unknown>> = [];
vi.mock("../models/db.js", () => ({
  db: {
    insert: () => ({
      values: async (v: Record<string, unknown>) => { inserted.push(v); },
    }),
    select: () => ({
      from: () => ({
        where: async () => [
          { id: "j1", disc: "education" },
          { id: "j2", disc: "generic" },
        ],
      }),
    }),
  },
}));
vi.mock("../models/schema.js", () => ({ decisionTraces: {}, journals: { id: "id", disciplineCode: "disc" } }));
vi.mock("drizzle-orm", () => ({ inArray: () => ({}) }));

const { traceJournalIntent, traceJournalConsumptionBatch } = await import("../services/ops/decision-trace.js");

beforeEach(() => { inserted.length = 0; });

describe("intent ↔ consumption 必须能串起来", () => {
  it("🔴 传入的 correlationId 出现在每一条消耗行上", async () => {
    const cid = await traceJournalIntent({
      requestedBy: "daily_cron_roundup", slotDiscipline: "education", scope: "roundup", tenantId: "t1",
    });
    inserted.length = 0;   // 只看消耗侧

    await traceJournalConsumptionBatch(["j1", "j2"], {
      requestedBy: "daily_cron_roundup", slotDiscipline: "education", scope: "roundup",
      tenantId: "t1", contentId: "c1", correlationId: cid,
    });

    // 断言副作用：真的落了两行，且都带同一个 correlationId（红线 #24）
    expect(inserted).toHaveLength(2);
    expect(inserted.every((r) => r.correlationId === cid)).toBe(true);
    expect(inserted.map((r) => r.journalId).sort()).toEqual(["j1", "j2"]);
  });

  it("不传 correlationId → 退回自己生成（旧行为不回归），但两侧就配不上对了", async () => {
    await traceJournalConsumptionBatch(["j1", "j2"], {
      requestedBy: "daily_cron_roundup", slotDiscipline: "education", scope: "roundup", tenantId: "t1",
    });
    expect(inserted).toHaveLength(2);
    const ids = new Set(inserted.map((r) => r.correlationId));
    expect(ids.size).toBe(1);              // 批内仍共用一个
    expect([...ids][0]).toBeTruthy();
  });

  it("🔴 generic 刊被非 generic 槽位选中 → 标记通配兜底(配额后门的形态)", async () => {
    await traceJournalConsumptionBatch(["j1", "j2"], {
      requestedBy: "daily_cron_roundup", slotDiscipline: "education", scope: "roundup",
      tenantId: "t1", contentId: "c1", correlationId: "fixed-cid",
    });
    const j1 = inserted.find((r) => r.journalId === "j1")!;   // disc=education，对口
    const j2 = inserted.find((r) => r.journalId === "j2")!;   // disc=generic，兜底
    expect(j1.genericWildcard).toBe(false);
    expect(j2.genericWildcard).toBe(true);
  });

  it("空数组 → 一行都不写(别产生噪音行)", async () => {
    await traceJournalConsumptionBatch([], {
      requestedBy: "daily_cron_roundup", slotDiscipline: "education", scope: "roundup", tenantId: "t1",
    });
    expect(inserted).toHaveLength(0);
  });
});
