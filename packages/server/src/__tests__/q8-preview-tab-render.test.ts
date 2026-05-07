/**
 * PR Q.8：预览 tab 真渲染（5-13 demo blocker）+ sanitize article 白名单 防回归。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.8: 预览 tab raw HTML → 真视觉渲染", () => {
  it("ContentDetailPage renderMarkdown 识别 <article 入 sanitize 分支（不 escapeHtml）", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    expect(src).toMatch(/trimmed\.startsWith\("<article"\)/);
    expect(src).toMatch(/return sanitizeHtml\(trimmed\)/);
  });

  it("sanitize ALLOWED_TAGS 含 article（PR Q.4 wrapper 不被 strip）", async () => {
    const src = await readSrc("../../../../apps/web/src/utils/sanitize.ts");
    expect(src).toMatch(/"article"/);
    expect(src).toMatch(/PR Q\.8 hotfix/);
  });

  it("ContentDetailPage 预览容器去 prose-sm + 加 bossmate-article-preview wrapper", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    expect(src).toMatch(/bossmate-article-preview/);
    // 预览 div 不再含 prose-sm（Tailwind typography 会覆盖模板 inline CSS）
    const previewSection = src.match(/bossmate-article-preview[\s\S]{0,200}/)?.[0] ?? "";
    expect(previewSection).not.toMatch(/prose-sm/);
  });

  it("global.css 含 .bossmate-article-preview 容器重置规则", async () => {
    const src = await readSrc("../../../../apps/web/src/styles/global.css");
    expect(src).toMatch(/\.bossmate-article-preview > article/);
    expect(src).toMatch(/PR Q\.8 hotfix/);
  });
});
