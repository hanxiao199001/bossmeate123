/**
 * PR Q.4 D3：article body 用 .bm-template-{styleTag} class 包裹防回归 + 4 CSS 文件存在性。
 */
import { describe, it, expect } from "vitest";

async function readFs(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.4: 4 套 CSS 主题文件存在 + 关键样式锁", () => {
  // PR #113（5-10 清理日 3）：line-height 跟随 PR Q.6.3 web font CDN 强化后实际值更新
  const cases = [
    { file: "academic", primary: "#2C5F8D", lineHeight: "1.85", font: "Source Han Serif" },
    { file: "marketing", primary: "#FF6B35", lineHeight: "1.5", font: "Inter" },
    { file: "popular", primary: "#00B4D8", lineHeight: "2", font: "Source Han Sans Rounded" },
    { file: "vertical", primary: "#6B46C1", lineHeight: "1.55", font: "PingFang SC" },
  ];
  for (const c of cases) {
    it(`${c.file}.css 含主色 ${c.primary} + line-height ${c.lineHeight} + 字体 ${c.font}`, async () => {
      const css = await readFs(`../../../../apps/web/src/styles/templates/${c.file}.css`);
      expect(css).toContain(`.bm-template-${c.file}`);
      expect(css).toContain(c.primary);
      expect(css).toContain(`line-height: ${c.lineHeight}`);
      expect(css).toContain(c.font);
    });
  }
});

describe("PR Q.4: article-skill body 用 styleTag class 包裹", () => {
  it("article-skill.ts wrappedBody 含 bm-template-${styleTag} 包裹（防回归 grep）", async () => {
    const src = await readFs("../services/skills/article-skill.ts");
    expect(src).toMatch(/<article class="bm-template-\$\{templateAware\.styleTag\}"/);
    expect(src).toMatch(/wrappedBody/);
  });

  it("main.tsx import 4 CSS 主题", async () => {
    const src = await readFs("../../../../apps/web/src/main.tsx");
    expect(src).toMatch(/templates\/academic\.css/);
    expect(src).toMatch(/templates\/marketing\.css/);
    expect(src).toMatch(/templates\/popular\.css/);
    expect(src).toMatch(/templates\/vertical\.css/);
  });
});
