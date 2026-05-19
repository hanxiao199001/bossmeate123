/**
 * PR #173 — ManualGenerateModal "一键 N 篇" 模式
 * 静态校验: admin 端点 schema + daily-cron export + modal UI 结构
 */
import { describe, it, expect } from "vitest";

describe("PR #173: admin/generate-article 一键 N 篇 schema", () => {
  it("schema 含 count (1-20) + template, 不含 topic/journalId", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    // count schema
    expect(src).toMatch(/count:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\(20\)/);
    // template 保留
    expect(src).toMatch(/template:\s*z\.enum\(\["A",\s*"B",\s*"C",\s*"E"\]\)/);
    // generateArticleSchema 不含 topic (老 schema 已替换为 count)
    const schemaBlock = src.match(/const generateArticleSchema = z\.object\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(schemaBlock).not.toContain("topic");
    expect(schemaBlock).toContain("count");
  });

  it("handler 复用 daily-cron 多样性逻辑", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(src).toMatch(/selectCandidates/);
    expect(src).toMatch(/DISCIPLINE_ROTATION/);
    expect(src).toMatch(/getJournal30dCount/);
    expect(src).toMatch(/lastRecommendedAt/);
  });

  it("返回 batchIds 数组 (不是单个 batchId)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(src).toMatch(/batchIds/);
    expect(src).toMatch(/estimatedSeconds:\s*batchIds\.length\s*\*\s*6/);
  });
});

describe("PR #173: daily-cron exports 给 admin 复用", () => {
  it("selectCandidates / DISCIPLINE_ROTATION / getJournal30dCount 已 export", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../services/recommendation/daily-cron.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/export async function selectCandidates/);
    expect(src).toMatch(/export const DISCIPLINE_ROTATION/);
    expect(src).toMatch(/export async function getJournal30dCount/);
  });
});

describe("PR #173: ManualGenerateModal 一键 N 篇 UI", () => {
  it("含 count radio (3/5/10/custom) + 进度条 + 多 batch poll", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/components/workbench/ManualGenerateModal.tsx", import.meta.url),
      "utf8",
    );
    // count options
    expect(src).toMatch(/COUNT_OPTIONS/);
    expect(src).toMatch(/3 篇/);
    expect(src).toMatch(/5 篇/);
    expect(src).toMatch(/10 篇/);
    // 进度条
    expect(src).toMatch(/completedCount/);
    expect(src).toMatch(/batchIds\.length/);
    // 不再有 topic input
    expect(src).not.toMatch(/setTopic/);
    expect(src).not.toMatch(/setJournalId/);
    // POST body 含 count
    expect(src).toMatch(/count:\s*actualCount/);
  });
});
