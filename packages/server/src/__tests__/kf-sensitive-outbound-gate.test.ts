/**
 * 敏感词出站硬闸 — 接入点行为测试（黑盒过 processKfTextMessage，mock 模式同 kf-multiturn-memory）。
 *
 * 闸位于 replyAndRecord（AI 出站唯一收口点），sensitive-filter 不 mock（读真词库，连带验证词库部署形态）。
 * 锁定行为：
 *   1. AI 回复命中敏感词 → 该回复绝不 sendKfText；落 ai_action=blocked_sensitive 审计记录（存被拦原文）；
 *      转人工：只外发固定安全话术 HANDOFF_REPLY + transferServiceState(state=2)
 *   2. 干净回复正常外发，不产生 blocked_sensitive 记录
 *   3. HANDOFF_REPLY 自身跳过匹配（固定安全话术必达，无"命中→handoff→再命中"递归）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const selectQueue: Array<Row[] | Error> = [];
  const insertQueue: Array<Row[]> = [];
  const chatQueue: Array<{ content: string }> = [];
  const insertedValues: Row[] = []; // 捕获 db.insert(...).values(v) 的 v，供落库断言

  // drizzle 链式 thenable：任意链式调用返回自身，await 时按队列出结果；values() 额外记参
  function chain(result: Row[] | Error) {
    const target: Promise<Row[]> = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    target.catch(() => {});
    const proxy: unknown = new Proxy(function () {} as never, {
      get(_t, prop) {
        if (prop === "then" || prop === "catch" || prop === "finally") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any)[prop].bind(target);
        }
        if (prop === "values") {
          return (v: Row) => { insertedValues.push(v); return proxy; };
        }
        return () => proxy;
      },
      apply() { return proxy; },
    });
    return proxy;
  }

  const chatMock = vi.fn(async (_req: unknown) => chatQueue.shift() ?? { content: "ok", model: "m", provider: "p", inputTokens: 0, outputTokens: 0 });
  const sendKfText = vi.fn(async () => true);
  const transferServiceState = vi.fn(async () => true);
  const notifyStaff = vi.fn(async () => true);
  return { selectQueue, insertQueue, chatQueue, insertedValues, chain, chatMock, sendKfText, transferServiceState, notifyStaff };
});

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../services/ai/chat-service.js", () => ({ chat: h.chatMock }));
vi.mock("../services/work-wechat/kf-client.js", () => ({
  sendKfText: h.sendKfText,
  transferServiceState: h.transferServiceState,
  notifyStaff: h.notifyStaff,
  syncKfMessages: vi.fn(),
}));
vi.mock("../models/db.js", () => ({
  db: {
    select: () => h.chain(h.selectQueue.shift() ?? []),
    insert: () => h.chain(h.insertQueue.shift() ?? [{ id: "out-1" }]),
    update: () => h.chain([]),
  },
}));

const { processKfTextMessage } = await import("../services/work-wechat/kf-responder.js");

const CONV = { id: "conv-1", tenantId: "t-1", openKfid: "kf1", externalUserid: "u1", mode: "auto" };
const MSG = { tenantId: "t-1", openKfid: "kf1", externalUserid: "u1", msgid: "wx-1", content: "随便聊聊" };
// 与 kf-responder 内部常量一字不差（改话术必须两处同步，此断言即护栏）
const HANDOFF_REPLY = "好的，已为您转接人工客服，请稍候，我们的顾问会尽快回复您～";

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.insertQueue.length = 0;
  h.chatQueue.length = 0;
  h.insertedValues.length = 0;
});

describe("敏感词出站硬闸（replyAndRecord 收口点）", () => {
  it("AI 回复命中敏感词 → 不外发 + blocked_sensitive 落库 + 转人工只发安全话术", async () => {
    const dirty = "这个问题涉及法轮功，我给您展开讲讲。"; // 法轮功 = 真词库政治类高危词
    h.selectQueue.push(
      [CONV],                                             // upsertConversation
      [{ id: "msg-cur", direction: "in", content: MSG.content }], // loadHistoryContext
      // handoffToHuman 里查 lastIn → 队列耗尽默认 []
    );
    h.insertQueue.push([{ id: "msg-cur" }]); // 入站落库 returning
    h.chatQueue.push(
      { content: '{"intent":"chitchat"}' },
      { content: dirty },
    );

    await processKfTextMessage(MSG);

    // 脏回复绝不外发；唯一外发 = 固定转接话术
    expect(h.sendKfText).toHaveBeenCalledTimes(1);
    expect(h.sendKfText).toHaveBeenCalledWith("kf1", "u1", HANDOFF_REPLY);

    // 审计落库：blocked_sensitive + 被拦原文（仅内部可见）
    const blocked = h.insertedValues.find((v) => v.aiAction === "blocked_sensitive");
    expect(blocked).toBeTruthy();
    expect(blocked!.direction).toBe("out");
    expect(blocked!.content).toBe(dirty);

    // 转人工三件套：transferred 记录（安全话术）+ 进待接入池
    const transferred = h.insertedValues.find((v) => v.aiAction === "transferred");
    expect(transferred!.content).toBe(HANDOFF_REPLY);
    expect(h.transferServiceState).toHaveBeenCalledWith("kf1", "u1", 2);
  });

  it("干净回复正常外发，无 blocked_sensitive 记录", async () => {
    const clean = "您好～有期刊或投稿方面的问题，随时问我！";
    h.selectQueue.push([CONV], [{ id: "msg-cur", direction: "in", content: MSG.content }]);
    h.insertQueue.push([{ id: "msg-cur" }]);
    h.chatQueue.push({ content: '{"intent":"chitchat"}' }, { content: clean });

    await processKfTextMessage(MSG);

    expect(h.sendKfText).toHaveBeenCalledTimes(1);
    expect(h.sendKfText).toHaveBeenCalledWith("kf1", "u1", clean);
    expect(h.insertedValues.some((v) => v.aiAction === "blocked_sensitive")).toBe(false);
    expect(h.transferServiceState).not.toHaveBeenCalled();
  });

  it("显式转人工捷径：HANDOFF_REPLY 自身跳过匹配、必达（无递归）", async () => {
    h.selectQueue.push([CONV], [{ id: "msg-cur", direction: "in", content: "人工" }]);
    h.insertQueue.push([{ id: "msg-cur" }]);

    await processKfTextMessage({ ...MSG, content: "人工" });

    expect(h.chatMock).not.toHaveBeenCalled(); // 捷径不进 LLM
    expect(h.sendKfText).toHaveBeenCalledTimes(1);
    expect(h.sendKfText).toHaveBeenCalledWith("kf1", "u1", HANDOFF_REPLY);
    expect(h.insertedValues.some((v) => v.aiAction === "blocked_sensitive")).toBe(false);
  });
});
