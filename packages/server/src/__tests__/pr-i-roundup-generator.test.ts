/**
 * PR-I2 — 多刊盘点生成器. LLM 成功组装 + 失败规则兜底.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET: "x".repeat(32), LOG_LEVEL: "error", NODE_ENV: "test" } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const rows = [
  { id: "j1", name: "教育发展研究", discipline: "教育学", acceptanceRate: 0.2, reviewCycle: "3-4个月", scopeDescription: "宏观政策", coverImageUrl: null, catalogs: ["cssci"], cscdLevel: null, pkuCoreLevel: "北大核心" },
  { id: "j2", name: "《中国教育学刊》", discipline: "教育学", acceptanceRate: 0.15, reviewCycle: "3-4个月", scopeDescription: "教学", coverImageUrl: "http://x/c.jpg", catalogs: ["cssci", "pku-core"], cscdLevel: null, pkuCoreLevel: "北大核心" },
];
function thenable() {
  const p: any = Promise.resolve(rows);
  p.orderBy = () => ({ limit: () => Promise.resolve(rows) });
  return p;
}
vi.mock("../models/db.js", () => ({
  db: { select: () => ({ from: () => ({ where: () => thenable() }) }) },
}));
const chatMock = vi.fn();
vi.mock("../services/ai/provider-factory.js", () => ({ getProviders: () => ({ cheap: [{ chat: chatMock }] }) }));

const { generateRoundup } = await import("../services/content-engine/roundup-generator.js");

beforeEach(() => chatMock.mockReset());

describe("PR-I2: 盘点生成器", () => {
  it("LLM 成功 → 组装 RoundupData, 刊名补《》, 封面透传", async () => {
    chatMock.mockResolvedValue({ content: JSON.stringify({
      title: "普通老师发核心这2本",
      openingParas: ["开场"], openingQuestions: ["问题?"],
      items: [{ intro: "简介A", experienceParas: ["经验A"], directions: ["方向A"] }, { intro: "简介B", experienceParas: ["经验B"], directions: ["方向B"] }],
      whyParas: ["为什么"], whyBullets: ["特点1"], ctaLines: ["私信"],
    }) });
    const d = await generateRoundup({ tenantId: "t1", journalIds: ["j1", "j2"], audience: "普通老师" });
    expect(d.items.length).toBe(2);
    expect(d.items[0].name).toBe("《教育发展研究》");   // 自动补书名号
    expect(d.items[1].name).toBe("《中国教育学刊》");   // 已有不重复
    expect(d.items[0].intro).toBe("简介A");
    expect(d.items[1].coverUrl).toBe("http://x/c.jpg"); // 封面透传
    expect(d.title).toContain("核心");
  });
  it("LLM 抛错 → 规则兜底, 仍产出条目", async () => {
    // 7-15 测试跟进: mockRejectedValue 留持久"拒绝工厂", 被 vitest 误报为 unhandled-rejection(挂本条 it)。
    //   兜底功能本身完好(probe 实证: chat 拒绝→generateRoundup 走 try/catch→ruleFallback→return 2 条),
    //   改 mockRejectedValueOnce(单次消费即止, 无残留拒绝)消除误报。生产代码不动。
    chatMock.mockRejectedValueOnce(new Error("llm down"));
    const d = await generateRoundup({ tenantId: "t1", journalIds: ["j1", "j2"], audience: "县域教师" });
    expect(d.items.length).toBe(2);
    expect(d.items[0].name).toContain("教育发展研究");
    expect(d.ctaLines?.length).toBeGreaterThan(0);
  });
});
