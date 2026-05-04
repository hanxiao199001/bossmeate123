/** B.9: matchJournalsPublic — LLM 调用 + JSON 解析 + 长度校验 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://t/t", QWEN_API_KEY:"k" } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const chatMock = vi.fn();
vi.mock("../services/ai/provider-factory.js", () => ({
  getProviders: () => ({ cheap: [{ name: "qwen", chat: chatMock }], expensive: [] }),
}));

const { matchJournalsPublic, matchSchema } = await import("../services/journals/match-public.js");

describe("matchJournalsPublic", () => {
  it("LLM 返回 5 条 → 正确解析 + 截前 5 + reason 在场", async () => {
    chatMock.mockResolvedValue({ content: JSON.stringify([
      { name: "Cell", discipline: "生物", partition: "SCI 一区", impactFactor: 45.5, reason: "高 IF + 顶刊" },
      { name: "Nature", discipline: "综合", partition: "SCI 一区", impactFactor: 50, reason: "顶刊" },
      { name: "Lancet", discipline: "医学", partition: "SCI 一区", impactFactor: 50, reason: "医学顶刊" },
      { name: "BMJ", discipline: "医学", partition: "SCI 一区", impactFactor: 30, reason: "医学" },
      { name: "PLoS ONE", discipline: "综合", partition: "SCI 三区", impactFactor: 3, reason: "open access" },
    ]), inputTokens: 100, outputTokens: 200, model: "qwen-plus", finishReason: "stop" });
    const r = await matchJournalsPublic("a long abstract about gene regulation in cancer cells. ".repeat(5));
    expect(r).toHaveLength(5);
    expect(r[0].name).toBe("Cell");
    expect(r[0].reason).toContain("顶刊");
  });

  it("LLM 返非 JSON → 抛错 LLM 返回格式错", async () => {
    chatMock.mockResolvedValue({ content: "嗯让我想想……不是 JSON", inputTokens: 10, outputTokens: 20, model: "qwen-plus", finishReason: "stop" });
    await expect(matchJournalsPublic("a".repeat(60))).rejects.toThrow(/格式错/);
  });

  it("matchSchema 校验：abstract 短于 50 → 失败", () => {
    expect(matchSchema.safeParse({ abstract: "短" }).success).toBe(false);
  });
  it("matchSchema 校验：abstract 长于 3000 → 失败", () => {
    expect(matchSchema.safeParse({ abstract: "x".repeat(3001) }).success).toBe(false);
  });
});
