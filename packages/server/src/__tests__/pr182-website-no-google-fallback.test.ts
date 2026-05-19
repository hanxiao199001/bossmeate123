/**
 * 5-19 PR #182 — 砍 website NULL 时 Google 搜索 fallback (A 方案 — 藏按钮).
 *
 * 背景:
 *   PR #180 给 website NULL 期刊加了 "https://www.google.com/search?q=..." fallback,
 *   但 user 测试反馈: 跳 Google 体验差, 信任度低. 改为 A 方案: NULL 直接整行不渲染.
 *
 * 现状: backfill 后 514/527 = 97.5% 期刊有真 website, 剩 13 个 NULL (中文/停刊) 直接藏按钮.
 *
 * 防回归 (file-content regression).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #182: website NULL → 整行 skip (砍 Google fallback)", () => {
  it("shunshi-style-template.ts: 无 google.com/search fallback", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).not.toMatch(/google\.com\/search/);
  });

  it("shunshi-style-template.ts: 无『搜索 ... →』anchor", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).not.toMatch(/搜索\s*\$\{searchName\}/);
  });

  it("shunshi-style-template.ts: 保留真 website 渲染 (有 http(s) 才 push 行)", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    // 真 website (匹配 ^https?://) 仍正常渲染
    expect(src).toMatch(/journal\.website && \/\^https\?\:/);
    // 锚文本逻辑仍在 (长 URL > 50 字符显示 "查看官网 →")
    expect(src).toMatch(/journal\.website\.length > 50.*查看官网/s);
  });

  it("shunshi-style-template.ts: Springer 登录页仍被识别并 skip", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/isSpringerLogin/);
    expect(src).toMatch(/idp\\\.springer\\\.com/);
  });
});
