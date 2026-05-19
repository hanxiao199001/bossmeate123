/**
 * 5-19 PR #171 — 权限分级: generate 按钮全 user 开放, bulk-distribute admin only.
 * 防回归 (file-content regression).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #171: 权限分级 — generate 全开放, bulk 仍 admin", () => {
  it("routes/admin.ts: 全局 addHook 已删 (per-route 守)", async () => {
    const src = await readSrc("../routes/admin.ts");
    expect(src).not.toMatch(/app\.addHook\("preHandler",\s*adminOnlyMiddleware\)/);
  });

  it("routes/admin.ts: generate-article 无 preHandler (全 user 可调)", async () => {
    const src = await readSrc("../routes/admin.ts");
    // generate-article 行尾应仅 async handler, 无 preHandler 配置
    expect(src).toMatch(/app\.post\("\/generate-article",\s*async/);
    expect(src).not.toMatch(/app\.post\("\/generate-article",\s*\{ preHandler/);
  });

  it("routes/admin.ts: generate-video 无 preHandler (全 user 可调)", async () => {
    const src = await readSrc("../routes/admin.ts");
    expect(src).toMatch(/app\.post\("\/generate-video",\s*async/);
    expect(src).not.toMatch(/app\.post\("\/generate-video",\s*\{ preHandler/);
  });

  it("routes/admin.ts: bulk-distribute POST 仍 admin only", async () => {
    const src = await readSrc("../routes/admin.ts");
    expect(src).toMatch(/app\.post\("\/bulk-distribute",\s*\{ preHandler: adminOnlyMiddleware \}/);
  });

  it("routes/admin.ts: bulk-distribute SSE stream 仍 admin only", async () => {
    const src = await readSrc("../routes/admin.ts");
    expect(src).toMatch(/app\.get\("\/bulk-distribute\/:batchId\/stream",\s*\{ preHandler: adminOnlyMiddleware \}/);
  });

  it("ContentWorkbenchPage: WorkbenchTopBar 无 isAdmin gate (全 user 见)", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentWorkbenchPage.tsx");
    // 应直接 <WorkbenchTopBar ...> 无 {isAdmin && ...} 包裹
    expect(src).not.toMatch(/\{isAdmin && \(\s*<WorkbenchTopBar/);
    expect(src).toMatch(/<WorkbenchTopBar/);
  });

  it("ContentWorkbenchPage: checkbox onToggleSelect 无 isAdmin 条件 (全 user 见)", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentWorkbenchPage.tsx");
    expect(src).not.toMatch(/onToggleSelect=\{isAdmin \?/);
    expect(src).toMatch(/onToggleSelect=\{\(\) => toggleMultiSelect/);
  });
});
