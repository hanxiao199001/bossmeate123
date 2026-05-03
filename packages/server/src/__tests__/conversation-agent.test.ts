/** B.3: ConversationAgent × hard guard 集成 — 4 类命中 + 1 未命中 = 5 integration。 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://test/test", SALES_AUTO_FOLLOWUP:false } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const eventBusPub = vi.fn(async () => {});
vi.mock("../services/event-bus/index.js", () => ({ eventBus: { publish: eventBusPub, subscribe: vi.fn(async () => {}) } }));

const chatFn = vi.fn();
vi.mock("../services/ai/chat-service.js", () => ({ chat: chatFn }));
vi.mock("../services/rate-limiter/index.js", () => ({ rateLimiter: { acquireOrWait: vi.fn(async () => {}) } }));

const fakeLead = { id: "lead-1", tenantId: "t-1", stage: "new", intentScore: 0, assignedUserId: null, handoverMode: "ai" };
const inserts: any[] = [];
const updates: any[] = [];
vi.mock("../models/db.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [fakeLead], orderBy: () => ({ limit: async () => [] }) }) }) }),
    insert: () => ({ values: async (v: any) => { inserts.push(v); } }),
    update: () => ({ set: (s: any) => ({ where: async () => { updates.push(s); } }) }),
  },
}));

const guardFn = vi.fn();
vi.mock("../services/sales/hard-guard.js", () => ({
  hardGuardCheck: guardFn,
  CANNED_REPLY: "您好，我是 BossMate 客服小王，您的问题已转给负责的老师，请稍候联系您",
}));

const { ConversationAgent } = await import("../services/sales/conversation-agent.js");

describe("ConversationAgent × hard guard 集成", () => {
  let agent: any;
  beforeEach(() => {
    inserts.length = 0; updates.length = 0;
    eventBusPub.mockClear(); chatFn.mockClear(); guardFn.mockClear();
    agent = new ConversationAgent();
  });

  for (const cat of ["quote", "contract", "legal", "deadline"] as const) {
    it(`${cat} 命中 → 罐头 + handoverMode=human + lead.need_human + LLM 不被调`, async () => {
      guardFn.mockResolvedValue({ hit: true, category: cat, whitelisted: false });
      await agent.respondToLead("lead-1", "测试触发", "corr");
      expect(chatFn).not.toHaveBeenCalled();
      expect(inserts[0]?.content).toMatch(/客服小王/);
      expect(inserts[0]?.isAiGenerated).toBe(false);
      expect(updates[0]).toMatchObject({ stage: "need_human", handoverMode: "human" });
      expect(eventBusPub).toHaveBeenCalledWith(expect.objectContaining({
        type: "lead.need_human",
        payload: expect.objectContaining({ category: cat, leadId: "lead-1" }),
      }));
    });
  }

  it("未命中 → LLM 调用 + stage 从 new 推到 contacted", async () => {
    guardFn.mockResolvedValue({ hit: false, whitelisted: false });
    chatFn.mockResolvedValue({ content: "AI 回复内容" });
    await agent.respondToLead("lead-1", "您好想咨询 SCI 投稿", "corr-2");
    expect(chatFn).toHaveBeenCalledOnce();
    expect(inserts[0]?.isAiGenerated).toBe(true);
    expect(updates.some((u) => u.stage === "contacted")).toBe(true);
    // 不应触发 lead.need_human
    expect(eventBusPub.mock.calls.every((c: any[]) => c[0]?.type !== "lead.need_human")).toBe(true);
  });
});
