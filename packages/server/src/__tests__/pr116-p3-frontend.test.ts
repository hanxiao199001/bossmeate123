/**
 * PR #116（5-11 P3 frontend Day 2）：RecommendationModal + ContentPage 入口防回归。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readWeb(rel: string): string {
  return readFileSync(join(__dirname, "../../../../apps/web/src", rel), "utf8");
}

describe("PR #116: RecommendationModal 组件", () => {
  it("文件存在", () => {
    expect(existsSync(join(__dirname, "../../../../apps/web/src/components/RecommendationModal.tsx"))).toBe(true);
  });

  const src = readWeb("components/RecommendationModal.tsx");

  it("含 2 tabs（推荐期刊 + 推荐主题）", () => {
    expect(src).toMatch(/🤖 推荐期刊/);
    expect(src).toMatch(/💡 推荐主题/);
    expect(src).toMatch(/setTab\("journals"\)/);
    expect(src).toMatch(/setTab\("topics"\)/);
  });

  it("调 P3 backend endpoint /recommend/journals + /recommend/topics", () => {
    // 模板字符串跨行 — 简化为只检查字面 endpoint 字符串存在
    expect(src).toMatch(/\/recommend\/journals/);
    expect(src).toMatch(/\/recommend\/topics/);
    // 至少调一次 api.get
    expect(src).toMatch(/api[\s\S]{0,10}\.get/); // 跨行 fluent chain
  });

  it("期刊行渲染 confidence + IF + partition + reason", () => {
    expect(src).toMatch(/j\.confidence/);
    expect(src).toMatch(/j\.impactFactor/);
    expect(src).toMatch(/j\.partition/);
    expect(src).toMatch(/j\.reason/);
  });

  it("期刊点击跳 /journals/:id 详情", () => {
    expect(src).toMatch(/<Link to=\{`\/journals\/\$\{j\.id\}`\}/);
  });

  it("主题含复制按钮（navigator.clipboard）", () => {
    expect(src).toMatch(/navigator\.clipboard\.writeText\(t\.topic\)/);
  });

  it("loading state + error state", () => {
    expect(src).toMatch(/AI 推荐中/);
    expect(src).toMatch(/setErr/);
  });

  it("backend cache 30 分钟提示（footer 文案）", () => {
    expect(src).toMatch(/cache 30 分钟/);
  });
});

describe("PR #116: ContentPage 入口", () => {
  const src = readWeb("pages/ContentPage.tsx");

  it("import RecommendationModal", () => {
    expect(src).toMatch(/import\s+RecommendationModal\s+from\s+["'][^"']*RecommendationModal["']/);
  });

  it("含 recommendOpen state + setRecommendOpen", () => {
    expect(src).toMatch(/const\s+\[recommendOpen,\s*setRecommendOpen\]\s*=\s*useState/);
  });

  it("含 🤖 AI 推荐 button + onClick 触发 modal", () => {
    expect(src).toMatch(/🤖 AI 推荐/);
    expect(src).toMatch(/onClick=\{[\s\S]{0,30}setRecommendOpen\(true\)/);
  });

  it("Modal 渲染 + onClose 关闭", () => {
    expect(src).toMatch(/<RecommendationModal\s+open=\{recommendOpen\}\s+onClose=\{\(\)\s*=>\s*setRecommendOpen\(false\)\}/);
  });
});
