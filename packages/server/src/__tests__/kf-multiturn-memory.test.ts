/**
 * kf 多轮记忆 — 行为测试（黑盒过 processKfTextMessage，非源码字面断言）。
 *
 * 修复缺口：kf-responder 此前每条消息独立分类/应答（chat() 从不传 context），
 * 客户追问"那审稿周期呢"会答非所问。本测试锁定:
 *   1. 历史(旧→新, user/assistant)进 context，且排除当前这条入站消息
 *   2. 分类与应答两次 chat 调用都带同一份 context
 *   3. 首条消息 context=[]；历史查询失败降级为无记忆应答（不 handoff 不崩）
 *   4. 条数上限 HISTORY_LIMIT=10 / 单条截断 500 / 总预算 2400 生效
 *   5. manual 模式仍然静默（历史加载不得先于 manual 检查）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const selectQueue: Array<Row[] | Error> = [];
  const insertQueue: Array<Row[]> = [];
  const chatQueue: Array<{ content: string }> = [];

  // drizzle 链式 thenable：任意链式调用返回自身，await 时按队列出结果
  function chain(result: Row[] | Error) {
    const target: Promise<Row[]> = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    target.catch(() => {}); // 防 unhandled rejection 噪声
    const proxy: unknown = new Proxy(function () {} as never, {
      get(_t, prop) {
        if (prop === "then" || prop === "catch" || prop === "finally") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any)[prop].bind(target);
        }
        return () => proxy;
      },
      apply() { return proxy; },
    });
    return proxy;
  }

  const chatMock = vi.fn(async (_req: unknown) => chatQueue.shift() ?? { content: "ok", model: "m", provider: "p", inputTokens: 0, outputTokens: 0 });
  const sendKfText = vi.fn(async () => undefined);
  const transferServiceState = vi.fn(async () => undefined);
  const notifyStaff = vi.fn(async () => undefined);
  return { selectQueue, insertQueue, chatQueue, chain, chatMock, sendKfText, transferServiceState, notifyStaff };
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
const MSG = { tenantId: "t-1", openKfid: "kf1", externalUserid: "u1", msgid: "wx-1", content: "那审稿周期呢？" };

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue.length = 0;
  h.insertQueue.length = 0;
  h.chatQueue.length = 0;
});

describe("kf 多轮记忆（processKfTextMessage 传 context）", () => {
  it("追问场景：历史(旧→新)进 context、排除当前消息，分类+应答两跳都带", async () => {
    h.selectQueue.push(
      [CONV], // upsertConversation
      [ // loadHistoryContext（新→旧，含当前这条用于验证排除逻辑）
        { id: "msg-cur", direction: "in", content: "那审稿周期呢？" },
        { id: "m2", direction: "out", content: "《Nature》影响因子 50.5，中科院 1 区。" },
        { id: "m1", direction: "in", content: "Nature 的影响因子是多少？" },
      ],
      [{ id: "j1", name: "Nature", nameEn: "Nature", isWarningList: false }], // findJournal 精确命中
    );
    h.insertQueue.push([{ id: "msg-cur" }]); // 入站落库 returning
    h.chatQueue.push(
      { content: '{"intent":"journal_query","journal_name":"Nature"}' },
      { content: "Nature 审稿周期约 3 个月，投稿前可再确认官网说明～" },
    );

    await processKfTextMessage(MSG);

    expect(h.chatMock).toHaveBeenCalledTimes(2);
    const classifyReq = h.chatMock.mock.calls[0][0] as { context: unknown; systemPrompt: string };
    expect(classifyReq.context).toEqual([
      { role: "user", content: "Nature 的影响因子是多少？" },
      { role: "assistant", content: "《Nature》影响因子 50.5，中科院 1 区。" },
    ]);
    // 当前这条不得混进历史（否则模型看到两遍）
    expect(JSON.stringify(classifyReq.context)).not.toContain("那审稿周期呢");

    const answerReq = h.chatMock.mock.calls[1][0] as { context: unknown; systemPrompt: string };
    expect(answerReq.context).toEqual(classifyReq.context);
    expect(answerReq.systemPrompt).toContain("期刊数据");
    expect(h.sendKfText).toHaveBeenCalledWith("kf1", "u1", "Nature 审稿周期约 3 个月，投稿前可再确认官网说明～");
    expect(h.transferServiceState).not.toHaveBeenCalled();
  });

  it("service_faq 追问同样带 context", async () => {
    h.selectQueue.push(
      [CONV],
      [
        { id: "msg-cur", direction: "in", content: "那第二项服务多少钱？" },
        { id: "m2", direction: "out", content: "我们提供选刊推荐与投稿辅导两类服务。" },
        { id: "m1", direction: "in", content: "你们都有什么服务？" },
      ],
      [{ id: "f1", question: "你们提供什么服务？", answer: "选刊推荐与投稿辅导。" }], // FAQ 列表
    );
    h.insertQueue.push([{ id: "msg-cur" }]);
    h.chatQueue.push(
      { content: '{"intent":"service_faq"}' },
      { content: "关于费用，顾问会根据具体需求报价哈～" },
    );

    await processKfTextMessage({ ...MSG, content: "那第二项服务多少钱？" });

    expect(h.chatMock).toHaveBeenCalledTimes(2);
    const answerReq = h.chatMock.mock.calls[1][0] as { context: unknown[]; systemPrompt: string };
    expect(answerReq.context).toHaveLength(2);
    expect(answerReq.systemPrompt).toContain("FAQ");
  });

  it("首条消息：无历史 → context=[]", async () => {
    h.selectQueue.push(
      [CONV],
      [{ id: "msg-cur", direction: "in", content: "你好" }], // 历史里只有当前这条
    );
    h.insertQueue.push([{ id: "msg-cur" }]);
    h.chatQueue.push({ content: '{"intent":"chitchat"}' }, { content: "您好～" });

    await processKfTextMessage({ ...MSG, content: "你好" });

    const classifyReq = h.chatMock.mock.calls[0][0] as { context: unknown };
    expect(classifyReq.context).toEqual([]);
    expect(h.sendKfText).toHaveBeenCalledTimes(1);
  });

  it("历史查询失败：降级为无记忆应答，不 handoff 不崩", async () => {
    h.selectQueue.push([CONV], new Error("db down"));
    h.insertQueue.push([{ id: "msg-cur" }]);
    h.chatQueue.push({ content: '{"intent":"chitchat"}' }, { content: "您好～" });

    await processKfTextMessage({ ...MSG, content: "在吗" });

    expect(h.chatMock).toHaveBeenCalledTimes(2); // 仍正常应答
    expect((h.chatMock.mock.calls[0][0] as { context: unknown }).context).toEqual([]);
    expect(h.sendKfText).toHaveBeenCalledTimes(1);
    expect(h.transferServiceState).not.toHaveBeenCalled(); // 没有因此转人工
  });

  it("裁剪：单条截断 500 字符 + 总预算 2400 → 超长历史只保留最近的若干条", async () => {
    const rows: Array<Record<string, unknown>> = [{ id: "msg-cur", direction: "in", content: "继续" }];
    rows.push({ id: "hb", direction: "out", content: "b".repeat(600) }); // 最新一条超长 → 截 500
    for (let i = 0; i < 5; i++) rows.push({ id: `ha${i}`, direction: "in", content: "a".repeat(500) });
    h.selectQueue.push([CONV], rows);
    h.insertQueue.push([{ id: "msg-cur" }]);
    h.chatQueue.push({ content: '{"intent":"chitchat"}' }, { content: "好的～" });

    await processKfTextMessage({ ...MSG, content: "继续" });

    const ctx = (h.chatMock.mock.calls[0][0] as { context: Array<{ content: string }> }).context;
    expect(ctx).toHaveLength(4); // 500×4=2000，第 5 条(500)超 2400 预算被丢
    expect(ctx[3].content).toHaveLength(500); // 600 → 截断 500
    expect(ctx[3].content.startsWith("b")).toBe(true); // 保留的是最新侧
  });

  it("上限：历史超过 10 条只取最近 10 条（旧→新排列）", async () => {
    const rows: Array<Record<string, unknown>> = [{ id: "msg-cur", direction: "in", content: "继续" }];
    for (let i = 1; i <= 12; i++) rows.push({ id: `h${i}`, direction: "in", content: `第${i}新` }); // h1 最新
    h.selectQueue.push([CONV], rows);
    h.insertQueue.push([{ id: "msg-cur" }]);
    h.chatQueue.push({ content: '{"intent":"chitchat"}' }, { content: "好～" });

    await processKfTextMessage({ ...MSG, content: "继续" });

    const ctx = (h.chatMock.mock.calls[0][0] as { context: Array<{ content: string }> }).context;
    expect(ctx).toHaveLength(10);
    expect(ctx[0].content).toBe("第10新"); // 最旧的保留项
    expect(ctx[9].content).toBe("第1新");  // 最新的历史
  });

  it("manual 模式回归：只落库不加载历史不调 AI", async () => {
    h.selectQueue.push([{ ...CONV, mode: "manual" }]);
    h.insertQueue.push([{ id: "msg-cur" }]);

    await processKfTextMessage(MSG);

    expect(h.chatMock).not.toHaveBeenCalled();
    expect(h.sendKfText).not.toHaveBeenCalled();
    expect(h.selectQueue).toHaveLength(0); // upsert 消费了唯一一次 select，未发生历史查询
  });
});
