/**
 * PR #178 — 内容管理中心 + 60 天保留 + pinned 保护
 */
import { describe, it, expect } from "vitest";

describe("PR #178: schema + migration", () => {
  it("contents 表含 pinned 字段", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../models/schema.ts", import.meta.url), "utf8");
    expect(src).toMatch(/pinned.*boolean.*pinned.*default.*false/);
  });

  it("migration 含 ALTER + index", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../models/migrate.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ALTER TABLE contents ADD COLUMN pinned/);
    expect(src).toMatch(/idx_contents_pinned/);
    expect(src).toMatch(/idx_contents_created_status/);
  });
});

describe("PR #178: content route — days + pinned + pin endpoint", () => {
  it("GET /content 含 days + pinned query params", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/content.ts", import.meta.url), "utf8");
    expect(src).toMatch(/days\?:\s*string/);
    expect(src).toMatch(/pinned\?:\s*string/);
    expect(src).toContain("query.days");
    expect(src).toContain('query.pinned === "true"');
  });

  it("POST /content/:id/pin endpoint 存在", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/content.ts", import.meta.url), "utf8");
    expect(src).toMatch(/app\.post\("\/\:id\/pin"/);
    expect(src).toContain("pinned");
  });
});

describe("PR #178: cleanup-old-contents script", () => {
  it("含 60 天 cutoff + published 保护 + pinned 保护 + delete", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../scripts/cleanup-old-contents.ts", import.meta.url), "utf8");
    expect(src).toMatch(/RETENTION_DAYS\s*=\s*60/);
    expect(src).toMatch(/ne.*status.*published/);
    expect(src).toMatch(/pinned.*false/);
    expect(src).toContain("contentPublishLog"); // 先删 publish log
    expect(src).toContain("dryRun");
  });
});

describe("PR #178: scheduler cron", () => {
  it("scheduler 含 content-retention-cleanup job + 03:30 schedule", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/scheduler.ts", import.meta.url), "utf8");
    expect(src).toMatch(/"content-retention-cleanup"/);
    expect(src).toMatch(/case "content-retention-cleanup"/);
    expect(src).toMatch(/cleanupOldContents/);
    expect(src).toMatch(/content-retention-cleanup-schedule/);
    expect(src).toMatch(/pattern: "30 3 \* \* \*"/);
  });
});

describe("PR #178: Sidebar nav", () => {
  it("Sidebar 含 内容管理 nav item", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/components/layout/Sidebar.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("内容管理");
    expect(src).toContain("/content");
  });
});

// 7-08 死测试清理 (确死: 读已删文件): 删 "PR #178: ContentPage pinned UI" describe —
//   目标 apps/web/src/pages/ContentPage.tsx 已删 (/content 整页下线)。pinned 的活断言 (schema/migration/route/cleanup/scheduler) 全保留。
//   ⚠️ 缓刑 (未删, 待过目): 上方 "PR #178: Sidebar nav — 内容管理 nav item" it 读活文件 Sidebar.tsx 但失败;
//      现 Sidebar (6-14 目录重构) 已无 "内容管理"/"/content" 项 (内容功能并入 /workbench 内容工坊)。
//      属"功能已迁移"而非"读已删文件", 需你确认「内容管理」入口是有意并入工坊(→更新断言指向 /workbench)还是真丢失(→修复), 未擅动。
