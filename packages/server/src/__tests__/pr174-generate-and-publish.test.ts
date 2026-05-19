/**
 * PR #174 — 一键生成发布: 学科 + 数量 + 账号 + 可选发布
 */
import { describe, it, expect } from "vitest";

describe("PR #174: generate-and-publish endpoint", () => {
  it("schema 含 discipline + count + template + accountIds", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(src).toMatch(/generateAndPublishSchema/);
    expect(src).toMatch(/discipline:\s*z\.enum/);
    expect(src).toMatch(/accountIds:\s*z\.array\(z\.string\(\)\.uuid\(\)\)/);
    expect(src).toMatch(/app\.post\("\/generate-and-publish"/);
  });

  it("handler 复用 daily-cron 多样性 + keyword cooldown", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(src).toMatch(/selectCandidates/);
    expect(src).toMatch(/DISCIPLINE_ROTATION/);
    expect(src).toMatch(/getJournal30dCount/);
    expect(src).toMatch(/lastRecommendedAt/);
  });

  it("返回 batchIds + accountIds + estimatedSeconds", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    // generate-and-publish handler 内
    const handler = src.slice(src.indexOf('"/generate-and-publish"'));
    expect(handler).toContain("batchIds");
    expect(handler).toContain("accountIds: body.accountIds");
    expect(handler).toContain("estimatedSeconds");
  });
});

describe("PR #174: ManualGenerateModal 重设计", () => {
  it("含 3 段决策: 学科 + 数量模板 + 账号发布", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/components/workbench/ManualGenerateModal.tsx", import.meta.url),
      "utf8",
    );
    // 学科
    expect(src).toMatch(/DISCIPLINE_OPTIONS/);
    expect(src).toMatch(/discipline.*auto/);
    // 数量
    expect(src).toMatch(/COUNT_OPTIONS/);
    // 账号
    expect(src).toMatch(/selectedAccountIds/);
    expect(src).toMatch(/isVerified/);
    // 发布选项
    expect(src).toMatch(/skipPublish/);
    // endpoint
    expect(src).toMatch(/\/admin\/generate-and-publish/);
  });

  it("不再有 topic input / journalId input", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/components/workbench/ManualGenerateModal.tsx", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/setTopic/);
    expect(src).not.toMatch(/setJournalId/);
  });

  it("进度条 + done 状态", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/components/workbench/ManualGenerateModal.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/completedCount/);
    expect(src).toMatch(/phase.*done/);
    expect(src).toMatch(/生成完成/);
  });
});
