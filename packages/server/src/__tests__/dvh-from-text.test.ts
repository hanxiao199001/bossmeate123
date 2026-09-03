/**
 * 7-30 文字稿直生数字人视频 —— 四道保护的单测。
 *
 * 盯死的五件事(全是"漏了就赔钱/出事"的):
 *   1. 🔴 幂等键: 双击不能出两条视频(= 两份 15 元), 第二次要拿到 409 而不是静默 200
 *   2. 🔴 字数闸: 50~600 字, 粘 5000 字进来必须在 submit 之前拒
 *   3. 费用预估公式: 600 字不许被 120 秒钳位钳成 19.8 元(真实 30 元)
 *   4. 🔴 内容安全: 敏感词/行业红线词在**花钱之前**拦, 且命中词回显规则要对
 *   5. metadata 存了 narrationText 原文(直生没有文章行可回溯, 这是唯一存档)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test", UPLOAD_DIR: "/tmp/bossmate-test-uploads",
    VIDEO_MAX_DURATION_SEC: 120, VIDEO_TENANT_MAX_CONCURRENT: 2,
  },
}));
const warnSpy = vi.fn();
const infoSpy = vi.fn();
const errorSpy = vi.fn();
vi.mock("../config/logger.js", () => ({
  logger: { info: infoSpy, warn: warnSpy, error: errorSpy, debug: vi.fn(), fatal: vi.fn() },
}));

// ---- DVH 底层: 全 mock, 一分钱都不能真花 ----
const isRealModeMock = vi.fn(() => true);
vi.mock("../services/digital-human/client.js", () => ({
  isRealMode: isRealModeMock, createDvhClient: vi.fn(), $avatar20220130: {},
}));
const submitDvhTaskMock = vi.fn(async () => ({ taskUuid: "task-1", submitMs: 10 }));
vi.mock("../services/digital-human/submit-task.js", () => ({
  submitDvhTask: submitDvhTaskMock, submitDvhAudioTask: vi.fn(),
}));
const queryDvhTaskMock = vi.fn(async () => ({ videoUrl: "https://oss/paid.mp4", durationMs: 60000, subtitlesUrl: "" }));
vi.mock("../services/digital-human/query-task.js", () => ({ queryDvhTaskUntilDone: queryDvhTaskMock }));
vi.mock("../services/digital-human/video-postprocess.js", () => ({
  postprocessVideoWithSubtitle: vi.fn(async () => ({ videoUrl: "https://oss/pp.mp4", postprocessed: true })),
}));
vi.mock("../services/digital-human/mock-fixture.js", () => ({
  getMockDvhFixture: () => ({ videoUrl: "mock.mp4", taskUuid: "mock-task", durationMs: 1000 }),
}));
vi.mock("../services/digital-human/template-mapping.js", () => ({
  resolveAvatarVoice: vi.fn(async (k: string) => (k === "BAD_KEY" ? null : {
    avatarCode: "av1", avatarLabel: "小雅", voiceCode: "v1", voiceLabel: "女声", templateLabel: k,
  })),
}));

// ---- 计费/预算/套餐: 默认全放行 ----
const checkBudgetMock = vi.fn(async () => ({ allowed: true }));
const recordCostMock = vi.fn(async () => {});
vi.mock("../services/billing/plan.js", () => ({
  checkBilling: vi.fn(async () => ({ allowed: true })),
  logBillingDenied: vi.fn(),
}));
const checkBillingMock = vi.mocked(await import("../services/billing/plan.js")).checkBilling;

// ---- 其它路由依赖(video.ts 顶层 import 到的) ----
vi.mock("../services/storage/index.js", () => ({
  storage: { upload: vi.fn(), delete: vi.fn(), getSignedUrl: vi.fn(async (p: string) => `https://signed/${p}`) },
}));
vi.mock("../services/task/queue.js", () => ({ videoQueue: { getJobs: async () => [], add: async () => ({ id: "j1" }) } }));
vi.mock("../services/voice/catalog-utils.js", () => ({ sanitizeVoiceOverride: (v: unknown) => (typeof v === "string" && v ? v : undefined) }));
vi.mock("../services/articles/state-machine.js", () => ({ initialStatusFields: () => ({ status: "draft" }) }));

// ---- 合规词库: 真实现(要测的就是它) + 敏感词库真 DFA ----
vi.mock("../services/compliance/fabrication-criteria.js", () => ({
  TITLE_DATA_CLAIM: /$^/g, TITLE_IF_CLAIM: /$^/g, TITLE_PARTITION_CLAIM: /$^/g,
  IF_FACT_KEYS: [], PARTITION_FACT_KEYS: [], ALL_FACT_KEYS: [],
  hasDbFact: () => false, hasAnyFact: () => false, providesAnyKey: () => false,
}));

// ---- DB: 抓 insert 的 values ----
const inserted: Array<Record<string, any>> = [];
let insertShouldFail = false;
vi.mock("../models/db.js", () => ({
  db: {
    // 9-04 件 2: dvh_tasks 走 db.execute(原始 SQL)。测试替身缺这一项时,
    //   recordDvhSubmit 会抛 → 触发 dvh_task_untracked 告警, 把"正常路径零 incident"
    //   这条不变量弄红。补齐替身, 而不是放宽断言。
    execute: async () => ({ rows: [], rowCount: 1 }),
    // checkCompliance 会读 SYSTEM 租户扩展词 → 返回空配置
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ config: {} }] }) }) }),
    insert: () => ({
      values: (vals: Record<string, any>) => ({
        returning: async () => {
          if (insertShouldFail) throw new Error("db down");
          inserted.push(vals);
          return [{ id: `vid-${inserted.length}` }];
        },
      }),
    }),
  },
}));
vi.mock("../models/schema.js", () => ({
  contents: { id: "id", tenantId: "t", type: "type", metadata: "meta" },
  tenants: { id: "id", config: "config" },
  costLedger: {}, journals: {},
}));

vi.mock("../services/billing/cost-ledger.js", async (orig) => {
  const actual = await orig<typeof import("../services/billing/cost-ledger.js")>();
  return { ...actual, checkBudget: checkBudgetMock, recordCost: recordCostMock };
});

const { videoRoutes } = await import("../routes/video.js");
const { estimateDvhFromText, estimateDvhCents } = await import("../services/billing/cost-ledger.js");
const { buildDvhTextSlotKeys, acquireDvhTextSlots, releaseDvhTextSlots, triggerDvhFromText } =
  await import("../services/digital-human/text-bridge.js");
const { findUnambiguousViolations } = await import("../services/compliance/content-check.js");

async function buildApp(role = "member"): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req) => {
    (req as any).tenantId = "t-1";
    (req as any).user = { userId: "u-op", role };
  });
  await app.register(videoRoutes, { prefix: "/" });
  return app;
}

/** 一段干净的 120 字口播稿(不含任何红线词) */
const CLEAN = "很多老师问我，中文核心到底难在哪里。其实难点不在文章本身，而在于选题和期刊定位是否对得上。".repeat(3);

function bodyOf(res: { payload: string }) { return JSON.parse(res.payload); }

beforeEach(() => {
  inserted.length = 0;
  insertShouldFail = false;
  warnSpy.mockClear(); infoSpy.mockClear(); errorSpy.mockClear();
  submitDvhTaskMock.mockClear();
  checkBudgetMock.mockClear();
  checkBudgetMock.mockResolvedValue({ allowed: true } as any);
  (checkBillingMock as any).mockResolvedValue({ allowed: true });
  isRealModeMock.mockReturnValue(true);
  process.env.DVH_TENANT_ID = "1"; process.env.DVH_APP_ID = "app";
});

// ===== 1. 🔴 幂等键: 防双击 =====
describe("幂等键 / 在途锁", () => {
  it("同稿同参数并发第二次 → 409 DUPLICATE_REQUEST, 且底层只 submit 一次(不出两份钱)", async () => {
    const app = await buildApp();
    // 让第一条卡在 query 上, 制造"生成中"的窗口
    let releaseQuery: (v: any) => void = () => {};
    queryDvhTaskMock.mockImplementationOnce(() => new Promise((r) => { releaseQuery = r; }) as any);

    const payload = { text: CLEAN, templateId: "A_academic", idempotencyKey: "idem-1" };
    const r1 = await app.inject({ method: "POST", url: "/dvh-from-text", payload });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({ method: "POST", url: "/dvh-from-text", payload });
    expect(r2.statusCode).toBe(409);
    expect(bodyOf(r2).code).toBe("DUPLICATE_REQUEST");

    releaseQuery({ videoUrl: "https://oss/paid.mp4", durationMs: 60000, subtitlesUrl: "" });
    await new Promise((r) => setTimeout(r, 20));
    expect(submitDvhTaskMock).toHaveBeenCalledTimes(1); // ★ 只花了一份钱
  });

  it("内容指纹兜底: 前端漏传 idempotencyKey 也拦得住(同稿同形象)", async () => {
    const app = await buildApp();
    let release: (v: any) => void = () => {};
    queryDvhTaskMock.mockImplementationOnce(() => new Promise((r) => { release = r; }) as any);
    const payload = { text: CLEAN, templateId: "A_academic" }; // 无 idempotencyKey
    expect((await app.inject({ method: "POST", url: "/dvh-from-text", payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/dvh-from-text", payload })).statusCode).toBe(409);
    release({ videoUrl: "u", durationMs: 1000, subtitlesUrl: "" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("同一份稿子换形象 = 另一条视频, 不能被幂等误拦", async () => {
    const app = await buildApp();
    let release: (v: any) => void = () => {};
    queryDvhTaskMock.mockImplementationOnce(() => new Promise((r) => { release = r; }) as any);
    expect((await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: "A_academic" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: "B_marketing" } })).statusCode).toBe(200);
    release({ videoUrl: "u", durationMs: 1000, subtitlesUrl: "" });
    await new Promise((r) => setTimeout(r, 30));
  });

  it("生成结束后槽位必须释放(否则这份稿子会被锁死 20 分钟)", async () => {
    const keys = buildDvhTextSlotKeys({ tenantId: "t-x", text: CLEAN, templateId: "A_academic" });
    expect(acquireDvhTextSlots(keys)).toBe(true);
    expect(acquireDvhTextSlots(keys)).toBe(false);
    releaseDvhTextSlots(keys);
    expect(acquireDvhTextSlots(keys)).toBe(true);
    releaseDvhTextSlots(keys);
  });

  it("槽位是全有全无: 两把 key 里任意一把被占, 整体抢不到", async () => {
    const a = buildDvhTextSlotKeys({ tenantId: "t-y", text: CLEAN, templateId: "A", idempotencyKey: "same" });
    const b = buildDvhTextSlotKeys({ tenantId: "t-y", text: CLEAN + "改了一点", templateId: "A", idempotencyKey: "same" });
    expect(acquireDvhTextSlots(a)).toBe(true);
    expect(acquireDvhTextSlots(b)).toBe(false); // 内容指纹不同, 但幂等键撞上了 → 拒
    releaseDvhTextSlots(a);
    releaseDvhTextSlots(b);
  });
});

// ===== 2. 🔴 字数上下限 =====
describe("字数闸", () => {
  it("低于 50 字 → 400, 不 submit", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: "太短了", templateId: "A_academic" } });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).code).toBe("VALIDATION_ERROR");
    expect(submitDvhTaskMock).not.toHaveBeenCalled();
  });

  it("🔴 粘 5000 字 → 400, 一分钱不花(此前 submitDvhTask 对 text 零校验)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: "字".repeat(5000), templateId: "A_academic" } });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain("600");
    expect(submitDvhTaskMock).not.toHaveBeenCalled();
  });

  it("601 字拒 / 600 字放行(边界)", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: "好".repeat(601), templateId: "A_academic" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: "好".repeat(600), templateId: "A_academic" } })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
  });
});

// ===== 3. 费用预估公式 =====
describe("费用预估", () => {
  // 7-31 修一条**别的提交留下的死断言**: 8ad9ba2「去掉预估的 30 秒下限」改了 estimateDvhFromText,
  //   但没同步这里, 于是这条从那次提交起就一直红(与本次三参数排查无关)。
  //   现口径: 阿里云按真实秒数结算、无起步价, 所以预估也不再兜 30 秒。
  it("公式: 3.3 字/秒 × 16.5 分/秒, 无 30 秒下限", () => {
    expect(estimateDvhFromText("字".repeat(330))).toEqual({ chars: 330, seconds: 100, cents: 1650 });
    expect(estimateDvhFromText("字".repeat(10)).seconds).toBe(3); // 10/3.3≈3, 不再钳到 30
  });

  it("🔴 600 字不许被 120 秒钳位: 老 estimateDvhCents 报 19.8 元, 真实约 30 元", () => {
    const long = "字".repeat(600);
    expect(estimateDvhCents(long)).toBe(1980);              // 老口径(钳位)
    expect(estimateDvhFromText(long).seconds).toBe(182);
    expect(estimateDvhFromText(long).cents).toBe(3003);     // 新口径, 不低报
  });

  it("/video/dvh-estimate 返回字数/秒数/元 + 上下限提示", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-estimate", payload: { text: "字".repeat(330) } });
    expect(res.statusCode).toBe(200);
    const d = bodyOf(res).data;
    expect(d).toMatchObject({ chars: 330, seconds: 100, yuan: 16.5, minChars: 50, maxChars: 600, tooShort: false, tooLong: false, blocked: false });
  });

  it("/video/dvh-estimate 对超限文本也给数字(不报错), 标 tooLong", async () => {
    const app = await buildApp();
    const d = bodyOf(await app.inject({ method: "POST", url: "/dvh-estimate", payload: { text: "字".repeat(900) } })).data;
    expect(d.tooLong).toBe(true);
  });

  it("预算闸用不钳位的预估: 超预算 → 403, 不 submit", async () => {
    checkBudgetMock.mockResolvedValue({ allowed: false, reason: "今日已消耗 90.00 元, 将超过每日预算 100 元" } as any);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: "A_academic" } });
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res).code).toBe("BUDGET_EXCEEDED");
    expect(submitDvhTaskMock).not.toHaveBeenCalled();
  });

  it("套餐闸(到期/配额用尽) → 403, 不 submit", async () => {
    (checkBillingMock as any).mockResolvedValue({ allowed: false, reason: "本月视频配额已用完" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: "A_academic" } });
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res).code).toBe("BILLING_LIMIT");
    expect(submitDvhTaskMock).not.toHaveBeenCalled();
  });
});

// ===== 4. 🔴 内容安全 =====
describe("口播稿内容安全", () => {
  it("行业红线词(包过) → 400 + 明说是哪个词 + 给替换建议, 且**没花钱**", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/dvh-from-text",
      payload: { text: CLEAN + "我们这边包过，保证录用，放心投稿。", templateId: "A_academic" },
    });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).code).toBe("COMPLIANCE_REDLINE");
    expect(bodyOf(res).message).toContain("包过");
    expect(bodyOf(res).message).toContain("录用率较高"); // 建议替换说法
    expect(submitDvhTaskMock).not.toHaveBeenCalled();
  });

  it("医疗红线(根治/治愈率)一样拦", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN + "这个方案可以根治。", templateId: "A_academic" } });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).message).toContain("根治");
  });

  it("标题里的红线词也拦(不能只查正文)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, title: "稳过专栏", templateId: "A_academic" } });
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).code).toBe("COMPLIANCE_REDLINE");
  });

  it("敏感词库命中 → 400, 但命中词**不回显**(只进日志), 守 sensitive-filter 的红线", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN + "介绍一下法轮功。", templateId: "A_academic" } });
    expect(res.statusCode).toBe(400);
    const msg = bodyOf(res).message as string;
    expect(msg).toContain("敏感词库");
    expect(msg).not.toContain("法轮"); // ★ 绝不外显
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("dvh.text.blocked_by_sensitive_lexicon");
    expect(submitDvhTaskMock).not.toHaveBeenCalled();
  });

  it("学术语境的合法词(第一作者/国家级期刊/最佳论文奖)不许误伤", () => {
    expect(findUnambiguousViolations("第一作者投国家级期刊，拿了最佳论文奖")).toEqual([]);
  });

  it("/video/dvh-estimate 边打字边预检: 红线词直接 blocked=true(不用等点生成)", async () => {
    const app = await buildApp();
    const d = bodyOf(await app.inject({ method: "POST", url: "/dvh-estimate", payload: { text: CLEAN + "包过" } })).data;
    expect(d.blocked).toBe(true);
    expect(d.blockMessage).toContain("包过");
  });
});

// ===== 5. metadata 存证 + 付费产物防丢 =====
describe("落库", () => {
  it("metadata 存 narrationText 原文 + sourceType=custom_text, 不写 sourceArticleId, autoGenerated=false", async () => {
    await triggerDvhFromText({
      db: (await import("../models/db.js")).db as any,
      tenantId: "t-1", userId: "u-1", text: CLEAN, title: "手写稿",
      templateId: "A_academic", idempotencyKey: "idem-meta",
    });
    expect(inserted).toHaveLength(1);
    const m = inserted[0]!.metadata;
    expect(m.narrationText).toBe(CLEAN);          // ★ 唯一存档
    expect(m.narrationChars).toBe(CLEAN.length);
    expect(m.narrationHash).toMatch(/^[0-9a-f]{40}$/);
    expect(m.sourceType).toBe("custom_text");
    expect(m.source).toBe("dvh");
    expect(m.sourceArticleId).toBeUndefined();     // ★ 直生不写这个字段
    expect(m.autoGenerated).toBe(false);           // ★ 手写稿不是 AI 自动生成
    expect(m.idempotencyKey).toBe("idem-meta");
    expect(inserted[0]!.type).toBe("video");
    expect(inserted[0]!.body).toBe("https://oss/pp.mp4");
  });

  it("不填标题 → 用稿子开头兜底(别落一条无名视频)", async () => {
    await triggerDvhFromText({
      db: (await import("../models/db.js")).db as any,
      tenantId: "t-1", userId: "u-1", text: CLEAN, templateId: "A_academic",
    });
    expect(inserted[0]!.title).toBe(CLEAN.slice(0, 24));
  });

  it("🔴 付费产物落库失败 → 重试 + ERROR 可恢复日志(含 videoUrl/taskUuid/口播稿), 绝不静默丢", async () => {
    insertShouldFail = true;
    await triggerDvhFromText({
      db: (await import("../models/db.js")).db as any,
      tenantId: "t-1", userId: "u-1", text: CLEAN, templateId: "A_academic",
    });
    const s = JSON.stringify(errorSpy.mock.calls);
    expect(s).toContain("dvh.text.insert_failed_paid_video_recoverable");
    expect(s).toContain("task-1");
    expect(s).toContain("paid.mp4");
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("dvh.text.insert_retry");
  });
});
