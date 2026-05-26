/**
 * 5-23 PR #234 — 修自引率 580% 单位错乱 bug.
 * 案例: Journal of NeuroEngineering and Rehabilitation DB self_citation_rate=5.80
 *   (绝对百分点, LetPub 旧写入未归一化), shunshi 模板 ×100 = 580%.
 * 修法: 三家模板都用 video/card-generator 同款兼容算法 (v > 1 ? v : v * 100),
 *   越界 (>100) 不渲染, 同时记录 warn 便于追根因.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SHUNSHI = "../services/publisher/adapters/shunshi-style-template.ts";
const WECHAT = "../services/publisher/adapters/wechat-article-template.ts";
const LISTICLE = "../services/publisher/adapters/listicle-template.ts";

describe("PR #234: 自引率单位兼容", () => {
  it("shunshi 用 v > 1 ? v : v * 100 兼容算法 + 越界拒绝", async () => {
    const src = await readSrc(SHUNSHI);
    expect(src).toMatch(/const pct = rate > 1 \? rate : rate \* 100/);
    expect(src).toMatch(/if \(rate > 100\)/);
    expect(src).toMatch(/PR #234/);
  });
  it("wechat 改兼容算法 + 越界拒绝 (原 rate.toFixed(1) 单位错)", async () => {
    const src = await readSrc(WECHAT);
    expect(src).toMatch(/const pct = rate > 1 \? rate : rate \* 100/);
    expect(src).toMatch(/rate > 100/);
  });
  it("listicle 风险阈值统一为 pct >= 20 (兼容双单位)", async () => {
    const src = await readSrc(LISTICLE);
    expect(src).toMatch(/const pct = r > 1 \? r : r \* 100/);
    expect(src).toMatch(/if \(pct >= 20\)/);
  });
  it("三家都加 console.warn 便于追根因 (单位错误日志)", async () => {
    const shun = await readSrc(SHUNSHI);
    const we = await readSrc(WECHAT);
    expect(shun).toMatch(/selfCitationRate\/shunshi.*越界/);
    expect(we).toMatch(/selfCitationRate\/wechat.*越界/);
  });
});
