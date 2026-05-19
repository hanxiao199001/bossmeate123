/**
 * PR #175 — ManualGenerateModal Tab 2 "精准筛选" + journals/search endpoint
 */
import { describe, it, expect } from "vitest";

describe("PR #175: GET /admin/journals/search endpoint", () => {
  it("admin.ts 含 journals/search GET endpoint + 7 filter 参数", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(src).toMatch(/app\.get\("\/journals\/search"/);
    expect(src).toMatch(/journalSearchSchema/);
    // 7 filters
    expect(src).toMatch(/name:\s*z\.string/);
    expect(src).toMatch(/issn:\s*z\.string/);
    expect(src).toMatch(/ifMin:\s*z\.coerce\.number/);
    expect(src).toMatch(/ifMax:\s*z\.coerce\.number/);
    expect(src).toMatch(/jcrSubject:\s*z\.string/);
    expect(src).toMatch(/wosLevel:\s*z\.enum/);
    expect(src).toMatch(/sortBy:\s*z\.enum/);
  });

  it("返回 items + total", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    const handler = src.slice(src.indexOf('"/journals/search"'), src.indexOf('"/journals/search"') + 2000);
    expect(handler).toContain("items");
    expect(handler).toContain("total");
  });
});

describe("PR #175: generate-and-publish 双模式", () => {
  it("schema 含 mode: discipline-auto | journal-specified", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(src).toMatch(/mode:\s*z\.enum\(\["discipline-auto",\s*"journal-specified"\]\)/);
    expect(src).toMatch(/journalIds:\s*z\.array\(z\.string\(\)\.uuid\(\)\)/);
  });

  it("handler 含 journal-specified 分支", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/admin.ts", import.meta.url), "utf8");
    expect(src).toContain('mode === "journal-specified"');
    expect(src).toContain("body.journalIds");
  });
});

describe("PR #175: ManualGenerateModal tab 切换", () => {
  it("含 quick + precise 两个 tab + JournalFilterTab import", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/components/workbench/ManualGenerateModal.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/activeTab/);
    expect(src).toContain("quick");
    expect(src).toContain("precise");
    expect(src).toMatch(/JournalFilterTab/);
    expect(src).toMatch(/handlePreciseSubmit/);
    expect(src).toContain("journal-specified");
  });
});

describe("PR #175: JournalFilterTab 组件", () => {
  it("含 7 个 filter + 期刊列表 + 模板选择 + 提交", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../apps/web/src/components/workbench/JournalFilterTab.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/nameQuery/);
    expect(src).toMatch(/issnQuery/);
    expect(src).toMatch(/ifMin/);
    expect(src).toMatch(/ifMax/);
    expect(src).toMatch(/jcrSubject/);
    expect(src).toMatch(/wosLevel/);
    expect(src).toMatch(/sortBy/);
    expect(src).toMatch(/\/admin\/journals\/search/);
    expect(src).toMatch(/selectedJournalIds/);
    expect(src).toMatch(/onSubmit/);
  });
});
