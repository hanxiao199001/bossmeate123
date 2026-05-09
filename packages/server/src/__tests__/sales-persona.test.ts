/**
 * B.6: persona 升级 + 双轨罐头 + 8 few-shot + 时段问候 + telemetry counter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", SALES_AUTO_FOLLOWUP:false } }));
const logInfo = vi.fn();
vi.mock("../config/logger.js", () => ({ logger: { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../services/rate-limiter/index.js", () => ({ rateLimiter: { acquireOrWait: vi.fn(async () => {}) } }));
const chatFn = vi.fn(async () => ({ content: "AI 回复" }));
vi.mock("../services/ai/chat-service.js", () => ({ chat: chatFn }));
const eventBusPub = vi.fn(async () => {});
vi.mock("../services/event-bus/index.js", () => ({ eventBus: { publish: eventBusPub, subscribe: vi.fn(async () => {}) } }));

const schema = await import("../models/schema.js");
let fakeLead: any = { id: "lead-1", tenantId: "t-1", stage: "new", intentScore: 0, assignedUserId: null, handoverMode: "ai" };
let tenantUrl: string | null = null;
const inserts: any[] = [];
vi.mock("../models/db.js", () => ({
  db: {
    select: () => ({ from: (t: any) => ({ where: () => ({
      limit: async () => t === schema.tenants ? (tenantUrl !== null ? [{ url: tenantUrl }] : []) : [fakeLead],
      orderBy: () => ({ limit: async () => [] }),
    }) }) }),
    insert: () => ({ values: async (v: any) => { inserts.push(v); } }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));
vi.mock("../services/sales/hard-guard.js", async () => {
  const actual: any = await vi.importActual("../services/sales/hard-guard.js");
  return { ...actual, hardGuardCheck: vi.fn() };
});

const { conversationAgent } = await import("../services/sales/conversation-agent.js");
const { buildCannedReply, CANNED_REPLY_TEMPLATE, hardGuardCheck } = await import("../services/sales/hard-guard.js");

beforeEach(() => {
  inserts.length = 0;
  fakeLead = { id: "lead-1", tenantId: "t-1", stage: "new", intentScore: 0, assignedUserId: null, handoverMode: "ai" };
  tenantUrl = null;
  logInfo.mockClear(); chatFn.mockClear(); eventBusPub.mockClear(); (hardGuardCheck as any).mockClear();
});

describe("B.6 buildCannedReply 双轨", () => {
  it("URL 占位被替换 + 含 BossMate 客服小王 + 3 秒匹配", () => {
    const r = buildCannedReply("https://my.tld/x");
    expect(r).toContain("https://my.tld/x");
    expect(r).toContain("BossMate 客服小王");
    expect(r).toContain("3 秒匹配");
    expect(CANNED_REPLY_TEMPLATE).toContain("{bossmate_url}");
  });
});

describe("B.6 时段问候", () => {
  const ag: any = conversationAgent;
  it.each([[5,"上午好"],[11,"上午好"],[12,"中午好"],[13,"中午好"],[14,"下午好"],[17,"下午好"],[18,"晚上好"],[22,"晚上好"],[2,"晚上好"]])("hour=%d → %s", (h, exp) => {
    const d = new Date(); d.setHours(h);
    expect(ag.timeGreeting(d)).toBe(exp);
  });
});

describe("B.6 buildSystemPrompt 含 8 few-shot 关键短语 + URL 注入 + 时段", () => {
  it("含 8 example + URL 替换 + 当前时段问候", () => {
    const ag: any = conversationAgent;
    const d = new Date(); d.setHours(9);
    const p = ag.buildSystemPrompt("https://example.com/X", d);
    // 8 few-shot 关键短语 sampling
    expect(p).toContain("是需要发表论文吗");                           // [1]
    expect(p).toContain("Chinese Medical Journal 影响因子 6.1");        // [2]
    expect(p).toContain("AI 3 秒帮您匹配 5 本最对口期刊");              // [3]
    expect(p).toContain("近 5 年录用数据");                            // [4]
    expect(p).toContain("开票流程老师跟您对接");                       // [5]
    expect(p).toContain("好的老师，您忙完看");                         // [6]
    expect(p).toContain("3 秒就能拿到 5 本最对口");                    // [7]
    expect(p).toContain("自引率风险");                                 // [8]
    expect(p).toContain("https://example.com/X");                      // URL 注入
    expect(p).toContain("上午好");                                     // 时段
    expect(p).toContain("代发承诺");                                   // 合规红线
  });
});

describe("B.6 hard guard 双轨 + telemetry log + tenant URL fallback", () => {
  it("tenant 配置 URL → 罐头注入 + 日志 [sales.platform_url.injected]", async () => {
    tenantUrl = "https://custom.tenant.url/a";
    (hardGuardCheck as any).mockResolvedValue({ hit: true, category: "quote", whitelisted: false });
    await (conversationAgent as any).respondToLead("lead-1", "多少钱", "corr-1");
    expect(chatFn).not.toHaveBeenCalled();
    expect(inserts[0]?.content).toContain("https://custom.tenant.url/a");
    expect(inserts[0]?.content).toContain("BossMate 客服小王");
    expect(logInfo.mock.calls.some((c: any[]) => String(c[1] ?? "").includes("[sales.platform_url.injected]"))).toBe(true);
  });
  it("tenant 无配置 → fallback 默认 https://boss-mates.com/try", async () => {
    tenantUrl = null;
    (hardGuardCheck as any).mockResolvedValue({ hit: true, category: "legal", whitelisted: false });
    await (conversationAgent as any).respondToLead("lead-1", "包过", "corr-2");
    expect(inserts[0]?.content).toContain("https://boss-mates.com/try");
  });
});
