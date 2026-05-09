/**
 * PR #117（5-11 user 验收 #116 反馈双 bug fix）：
 * Bug 1: RecommendationModal 期刊行 <Link> 跳 /journals/:id 但前端无该路由 → 跳首页
 * Bug 2: 模板 line 264 fallback "暂无"被 user 误为"假链接"
 *
 * Fix:
 * - Bug 1: modal 期刊名去 Link，纯 text（reason + IF 给 user 决策足够）
 * - Bug 2: 模板 website NULL/不合法时整行不渲染（不显示比"暂无"专业）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readWeb(rel: string): string {
  return readFileSync(join(__dirname, "../../../../apps/web/src", rel), "utf8");
}
function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("PR #117 Bug 1: RecommendationModal 期刊名去 Link", () => {
  const src = readWeb("components/RecommendationModal.tsx");

  it("不再 import { Link }（去 Link 防跳首页）", () => {
    expect(src).not.toMatch(/import\s*\{\s*Link\s*\}\s*from\s*["']react-router-dom["']/);
  });

  it("不再含 <Link to={`/journals/", () => {
    expect(src).not.toMatch(/<Link\s+to=\{`\/journals\//);
  });

  it("期刊名渲染为 <span>{j.name}</span> 纯 text", () => {
    expect(src).toMatch(/<span\s+className="text-gray-900">\{j\.name\}<\/span>/);
  });

  it("含 PR #117 root cause 注释（防 refactor 误恢复 Link）", () => {
    expect(src).toMatch(/PR #117/);
    expect(src).toMatch(/无 \/journals\/:id 路由|跳首页/);
  });
});

describe("PR #117 Bug 2: 模板 website NULL 时整行不渲染", () => {
  const src = readSrc("services/publisher/adapters/shunshi-style-template.ts");

  it("条件含 http(s) URL 校验（防 NULL/空/非法字串渲染）", () => {
    expect(src).toMatch(/journal\.website && \/\^https\?:\\\/\\\/\/i\.test\(journal\.website\)/);
  });

  it("不再 fallback 渲染 '官网：暂无' 行", () => {
    // greyOrValue(null) 在 website 上下文不应再调用
    expect(src).not.toMatch(/<strong>官网：<\/strong>\$\{greyOrValue\(null\)\}/);
  });

  it("含 PR #117 root cause 注释（防 refactor 误恢复 fallback）", () => {
    // grep 仅 website 段附近的 PR #117 注释
    const idx = src.indexOf("PR #117 fix Bug 2");
    expect(idx).toBeGreaterThan(0);
    const seg = src.slice(idx, idx + 400);
    expect(seg).toMatch(/website NULL|enricher 未抓取/);
  });
});
