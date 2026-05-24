/**
 * 5-23 PR #220 — 微信兜底封面印标题 (消灭空白蓝卡).
 * 无 coverImageUrl 时 createGradientThumb 原画纯渐变(空白)。现把标题换行居中印上去, 永不空白.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const WECHAT = "../services/publisher/adapters/wechat.ts";

describe("PR #220: 兜底封面印标题", () => {
  it("createGradientThumb 接收 title 参数", async () => {
    const src = await readSrc(WECHAT);
    expect(src).toMatch(/private async createGradientThumb\(token: string, title\?: string\)/);
  });
  it("有标题折行 + XML 转义渲染", async () => {
    const src = await readSrc(WECHAT);
    expect(src).toMatch(/const wrapTitle = /);
    expect(src).toMatch(/const escXml = /);
    expect(src).toMatch(/\$\{titleSvg\}/);
  });
  it("两处调用都传 title (正常 + catch 回退)", async () => {
    const src = await readSrc(WECHAT);
    const matches = src.match(/createGradientThumb\(token, title\)/g) || [];
    expect(matches.length).toBe(2);
    expect(src).not.toMatch(/createGradientThumb\(token\)(?!,)/);
  });
});
