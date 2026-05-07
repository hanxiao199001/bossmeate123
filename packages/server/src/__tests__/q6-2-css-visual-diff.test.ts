/**
 * PR Q.6.2：4 套 CSS 主题视觉差异化（!important 压 inline style + 装饰真分化）防回归。
 * 5-8 早 user 验收发现 4 套结构 100% 一样仅颜色不同 → 字体 / 装饰 / 间距 / 表格 真差异。
 */
import { describe, it, expect } from "vitest";

async function readCss(name: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(`../../../../apps/web/src/styles/templates/${name}.css`, import.meta.url), "utf8");
}

describe("PR Q.6.2: 4 套 CSS 用 !important 压 article body inline style", () => {
  it.each(["academic", "marketing", "popular", "vertical"])(
    "%s.css 关键属性含 !important（font-family / line-height / color）",
    async (name) => {
      const css = await readCss(name);
      expect(css).toMatch(/font-family:[^;]*!important/);
      expect(css).toMatch(/line-height:[^;]*!important/);
      expect((css.match(/!important/g) ?? []).length).toBeGreaterThan(15);
    },
  );
});

describe("PR Q.6.2: 4 套真差异化（字体 / line-height / 装饰）", () => {
  it("A 学术：Serif + 1.85 + § 章节序号 + 双线 H1", async () => {
    const css = await readCss("academic");
    expect(css).toMatch(/Source Han Serif.*line-height:\s*1\.85/s);
    expect(css).toMatch(/content:\s*"§ "/);
    expect(css).toMatch(/3px double/);
  });
  it("B 营销：粗体 + 渐变 H1 + 大字 em + 圆角 CTA", async () => {
    const css = await readCss("marketing");
    expect(css).toMatch(/PingFang SC Bold.*font-weight:\s*900/s);
    expect(css).toMatch(/-webkit-text-fill-color:\s*transparent/);
    expect(css).toMatch(/border-radius:\s*999px/);
    expect(css).toMatch(/font-size:\s*1\.7em/);
  });
  it("C 科普：Rounded + 2 + ✨ + 圆角卡片", async () => {
    const css = await readCss("popular");
    expect(css).toMatch(/Source Han Sans Rounded.*line-height:\s*2/s);
    expect(css).toMatch(/"✨ "/);
    expect(css).toMatch(/border-radius:\s*18px/);
  });
  it("E 行业：PingFang + 1.55 + ▸ h2 + 黄高亮 + 等宽数字", async () => {
    const css = await readCss("vertical");
    expect(css).toMatch(/PingFang SC.*line-height:\s*1\.55/s);
    expect(css).toMatch(/"▸"/);
    expect(css).toMatch(/var\(--bm-data-hi\)/);
    expect(css).toMatch(/tabular-nums/);
  });
});
