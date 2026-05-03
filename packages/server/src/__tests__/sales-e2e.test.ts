/**
 * B.5 e2e — 公众号 callback 真触发 4 场景：
 *   1. 公众号 inbound text → 200 + leads/salesMessages 入库 + lead.collected 发出
 *   2. QUOTE hard guard 触发 → handoverMode=human + lead.need_human + LLM 0 调用
 *   3. 同 MsgId 重发幂等 → 第二次不再发 lead.collected
 *   4. whitelist 命中 LEGAL → 跳过 hard guard 走 LLM
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { createHash } from "node:crypto";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", WECHAT_VERIFY_TOKEN:"tok", SALES_AGENT_ENABLED:true, SALES_AUTO_FOLLOWUP:false } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../services/rate-limiter/index.js", () => ({ rateLimiter: { acquireOrWait: vi.fn(async () => {}) } }));
const chatFn = vi.fn(async () => ({ content: "AI 回复" }));
vi.mock("../services/ai/chat-service.js", () => ({ chat: chatFn }));
const eventBusPub = vi.fn(async () => {});
vi.mock("../services/event-bus/index.js", () => ({ eventBus: { publish: eventBusPub, subscribe: vi.fn(async () => {}) } }));

const schema = await import("../models/schema.js");
const state = { dedup: [] as any[], leads: [] as any[], msgs: [] as any[], whitelist: [] as any[], flags: [{ tenantId:"t-1", flagName:"sales_agent_enabled", enabled:true }] };
function rowsFor(t: any): any[] {
  if (t === schema.wechatConfigs) return [{ id:"wc-1", tenantId:"t-1", accountType:"service" }];
  if (t === schema.leads) return state.leads;
  if (t === schema.tenantFeatureFlags) return state.flags;
  if (t === schema.hardGuardWhitelist) return state.whitelist.map((w) => ({ pattern: w.pattern }));
  return [];
}
function chain(rows: any[]): any {
  return { where: () => chain(rows), limit: () => chain(rows), orderBy: () => chain(rows), then: (f: any, r: any) => Promise.resolve(rows).then(f, r) };
}
vi.mock("../models/db.js", () => ({
  db: {
    select: () => ({ from: (t: any) => chain(rowsFor(t)) }),
    insert: (t: any) => ({ values: (v: any) => {
      const exec = async () => {
        if (t === schema.dedupMsgs) { if (state.dedup.some((d) => d.tenantId === v.tenantId && d.msgId === v.msgId)) throw new Error("unique"); state.dedup.push(v); return v; }
        if (t === schema.leads) { const r = { id:`lead-${state.leads.length+1}`, ...v }; state.leads.push(r); return r; }
        if (t === schema.salesMessages) { const r = { id:`msg-${state.msgs.length+1}`, ...v }; state.msgs.push(r); return r; }
        return undefined;
      };
      const p: any = exec(); p.returning = async () => { const r = await p; return r ? [r] : []; }; return p;
    } }),
    update: (t: any) => ({ set: (s: any) => ({ where: async () => { if (t === schema.leads && state.leads[0]) Object.assign(state.leads[0], s); } }) }),
  },
}));

const { wechatCallbackRoutes, computeSignature } = await import("../routes/wechat-callback.js");
const { conversationAgent } = await import("../services/sales/conversation-agent.js");
const { clearWhitelistCache } = await import("../services/sales/hard-guard.js");
const { clearFeatureFlagCache } = await import("../services/feature-flags.js");

function buildXml(content: string, msgId: string): string {
  return `<xml><ToUserName>gh_x</ToUserName><FromUserName>oUser1</FromUserName><CreateTime>1714694400</CreateTime><MsgType>text</MsgType><Content>${content}</Content><MsgId>${msgId}</MsgId></xml>`;
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(wechatCallbackRoutes);
  return app;
}

beforeEach(() => {
  state.dedup = []; state.leads = []; state.msgs = []; state.whitelist = []; state.flags = [{ tenantId:"t-1", flagName:"sales_agent_enabled", enabled:true }];
  eventBusPub.mockClear(); chatFn.mockClear(); chatFn.mockResolvedValue({ content: "AI 回复" });
  clearWhitelistCache(); clearFeatureFlagCache();
});

async function callback(app: any, content: string, msgId: string) {
  const ts = "1714694400", nonce = "n", sig = computeSignature("tok", ts, nonce);
  return app.inject({ method:"POST", url:`/wechat/callback?signature=${sig}&timestamp=${ts}&nonce=${nonce}`, headers:{ "content-type":"text/xml" }, payload: buildXml(content, msgId) });
}

describe("B.5 sales 端到端 e2e", () => {
  it("场景 1：公众号 inbound text → 200 + leads/salesMessages 入库 + lead.collected 发出", async () => {
    const app = await buildApp();
    const res = await callback(app, "您好我想咨询", "msg-001");
    expect(res.statusCode).toBe(200);
    // leadCollector 是 fire-and-forget，等 microtasks
    await new Promise((r) => setTimeout(r, 50));
    expect(state.leads.length).toBe(1);
    expect(state.msgs.some((m) => m.direction === "inbound")).toBe(true);
    expect(eventBusPub.mock.calls.some((c: any[]) => c[0]?.type === "lead.collected")).toBe(true);
  });

  it("场景 2：QUOTE hard guard 触发 → handoverMode=human + lead.need_human + LLM 0 调用", async () => {
    state.leads.push({ id: "lead-1", tenantId: "t-1", stage: "new", intentScore: 0, handoverMode: "ai", assignedUserId: null });
    await (conversationAgent as any).respondToLead("lead-1", "你们这个多少钱？", "corr-q");
    expect(chatFn).not.toHaveBeenCalled();
    const lastUpdate = state.leads[0];
    expect(lastUpdate.stage).toBe("need_human");
    expect(lastUpdate.handoverMode).toBe("human");
    expect(eventBusPub.mock.calls.some((c: any[]) => c[0]?.type === "lead.need_human" && c[0]?.payload?.category === "quote")).toBe(true);
  });

  it("场景 3：同 MsgId 重发 → 第二次幂等不重复入库", async () => {
    const app = await buildApp();
    await callback(app, "您好", "msg-dup");
    await callback(app, "您好", "msg-dup");
    await new Promise((r) => setTimeout(r, 50));
    expect(state.dedup.length).toBe(1);
    expect(eventBusPub.mock.calls.filter((c: any[]) => c[0]?.type === "lead.collected").length).toBe(1);
  });

  it("场景 4：whitelist 命中 LEGAL '我绝对支持你们' → 跳过 hard guard 走 LLM", async () => {
    state.whitelist.push({ pattern: "我绝对支持你们" });
    state.leads.push({ id: "lead-1", tenantId: "t-1", stage: "new", intentScore: 0, handoverMode: "ai", assignedUserId: null });
    await (conversationAgent as any).respondToLead("lead-1", "我绝对支持你们 包过 退款", "corr-wl");
    expect(chatFn).toHaveBeenCalledTimes(1);
    expect(eventBusPub.mock.calls.every((c: any[]) => c[0]?.type !== "lead.need_human")).toBe(true);
  });
});
