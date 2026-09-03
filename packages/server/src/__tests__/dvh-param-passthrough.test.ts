/**
 * 7-31 数字人三参数(形象 / 背景 / 音色)全链路透传 —— 老板实测"选了全不生效"的防回归。
 *
 * 这个文件测的是**别的测试都测不到的那一段**: 参数从 HTTP 请求体一路到
 * "真正塞进阿里云 SubmitTextTo2DAvatarVideoTaskRequest 的字段"。
 * 所以它只 mock 最外面那层阿里云 SDK(用假构造器把入参原样记下来), 中间
 * 路由 → text-bridge → produce-video → submit-task → template-mapping 全部跑真的 ——
 * 任何一层漏传, 这里立刻红。
 *
 * 盯死四件:
 *   1. 🔴 形象: 请求体 templateId → 阿里云 avatarInfo.code(自定义目录条目也要能解析到)
 *   2. 🔴 背景: 请求体 backgroundUrl → 阿里云 videoInfo.backgroundImageUrl(含优先级链与 "none" 哨兵)
 *   3. ⚠️ 音色: 文字驱动下**故意不生效**(既定限制) —— 断言它确实用的是形象自带音色,
 *      并且这件事被显式记进了存证(ignoredVoiceRequest), 而不是悄悄发生
 *   4. 🔴 存证: metadata 里 requested(用户选的) 与 effective(实际用的) 必须分开;
 *      没提交成功时 effective 必须缺失 + placeholder=true —— 否则又会出现
 *      "记录里参数都对、片子却不对"的查证死胡同。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test", UPLOAD_DIR: "/tmp/bossmate-test-uploads",
    VIDEO_MAX_DURATION_SEC: 120, VIDEO_TENANT_MAX_CONCURRENT: 2,
    DVH_SPEECH_RATE: 50, DVH_MOCK_FIXTURE_BASE: "https://fx",
  },
}));
// sharp 是原生模块, 这里用不到图片解码(只走 URL 白名单那条), mock 掉让用例可移植
vi.mock("sharp", () => ({
  default: () => ({ metadata: async () => ({ width: 1080, height: 1920 }) }),
}));
const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() };
vi.mock("../config/logger.js", () => ({ logger: logSpy }));

// ---- 阿里云 SDK: 假构造器, 把请求体原样记下来(这就是"最终发出去的那份") ----
const captured: Array<{ kind: string; req: any }> = [];
class Rec { constructor(a: any) { Object.assign(this, a); } }
vi.mock("../services/digital-human/client.js", () => ({
  isRealMode: () => process.env.DVH_REAL_MODE === "true",
  createDvhClient: () => ({
    submitTextTo2DAvatarVideoTaskWithOptions: async (req: any) => {
      captured.push({ kind: "text", req });
      if (process.env.__FAKE_SUBMIT_FAIL === "1") return { body: { success: false, code: "10010003", message: "无访问权限" } };
      return { body: { success: true, data: { taskUuid: "t-1" }, requestId: "r-1" } };
    },
    submitAudioTo2DAvatarVideoTaskWithOptions: async (req: any) => {
      captured.push({ kind: "audio", req });
      return { body: { success: true, data: { taskUuid: "t-2" }, requestId: "r-2" } };
    },
  }),
  $avatar20220130: {
    SubmitTextTo2DAvatarVideoTaskRequest: Rec,
    SubmitTextTo2DAvatarVideoTaskRequestApp: Rec,
    SubmitTextTo2DAvatarVideoTaskRequestAvatarInfo: Rec,
    SubmitTextTo2DAvatarVideoTaskRequestAudioInfo: Rec,
    SubmitTextTo2DAvatarVideoTaskRequestVideoInfo: Rec,
    SubmitAudioTo2DAvatarVideoTaskRequest: Rec,
    SubmitAudioTo2DAvatarVideoTaskRequestApp: Rec,
    SubmitAudioTo2DAvatarVideoTaskRequestAvatarInfo: Rec,
    SubmitAudioTo2DAvatarVideoTaskRequestAudioInfo: Rec,
    SubmitAudioTo2DAvatarVideoTaskRequestVideoInfo: Rec,
  },
}));
const queryMock = vi.fn(async () => ({ videoUrl: "https://oss/paid.mp4", durationMs: 60000, subtitlesUrl: "" }));
vi.mock("../services/digital-human/query-task.js", () => ({ queryDvhTaskUntilDone: queryMock }));
// 7-31 告警落库: 只关心"有没有报、报的什么 kind", 不连真 DB
const incidentSpy = vi.fn(async (_input: any) => {});
const incidentThrottledSpy = vi.fn(async (_input: any, _opts?: any) => {});
vi.mock("../services/ops/incidents.js", () => ({
  recordIncident: incidentSpy,
  recordIncidentThrottled: incidentThrottledSpy,
}));
vi.mock("../services/digital-human/video-postprocess.js", () => ({
  postprocessVideoWithSubtitle: vi.fn(async (a: any) => ({ videoUrl: a.videoUrl, postprocessed: false })),
}));
// 背景可达性预检有独立单测(dvh-background-selection), 这里放行, 专测透传
vi.mock("../services/digital-human/background-library.js", async (orig) => {
  const actual = await orig<typeof import("../services/digital-human/background-library.js")>();
  return { ...actual, assertBackgroundReachable: vi.fn(async () => undefined) };
});
vi.mock("../services/storage/index.js", () => ({
  storage: {
    upload: vi.fn(async () => "https://oss/x"), delete: vi.fn(),
    getSignedUrl: vi.fn(async (p: string) => `https://bossmate-media.oss-cn-beijing.aliyuncs.com/${p}`),
  },
}));
// fellSilent=false = 合成成功。要测"TTS 失败"就 mockResolvedValueOnce 一个 fellSilent:true
// 8-03: silentReason 是 TTSResult 新增字段(失败原因), 基准 mock 里声明出来, 用例才好覆盖它
const ttsSpy = vi.fn(async (_t: string, _x: string, _o: any) => ({
  remotePath: "tts/a.wav", durationMs: 60000, fellSilent: false, silentReason: undefined as string | undefined,
}));
vi.mock("../services/video/tts-service.js", () => ({ ttsService: { synthesize: ttsSpy } }));
vi.mock("../services/task/queue.js", () => ({ videoQueue: { getJobs: async () => [], add: async () => ({ id: "j1" }) } }));
vi.mock("../services/articles/state-machine.js", () => ({ initialStatusFields: () => ({ status: "draft" }) }));
vi.mock("../services/billing/plan.js", () => ({ checkBilling: vi.fn(async () => ({ allowed: true })), logBillingDenied: vi.fn() }));
vi.mock("../services/compliance/fabrication-criteria.js", () => ({
  TITLE_DATA_CLAIM: /$^/g, TITLE_IF_CLAIM: /$^/g, TITLE_PARTITION_CLAIM: /$^/g,
  IF_FACT_KEYS: [], PARTITION_FACT_KEYS: [], ALL_FACT_KEYS: [],
  hasDbFact: () => false, hasAnyFact: () => false, providesAnyKey: () => false,
}));

const inserted: any[] = [];
let sysConfig: any = { config: {} };
vi.mock("../models/db.js", () => ({
  db: {
    // 9-04 件 2: dvh_tasks 走 db.execute(原始 SQL)。测试替身缺这一项时,
    //   recordDvhSubmit 会抛 → 触发 dvh_task_untracked 告警, 把"正常路径零 incident"
    //   这条不变量弄红。补齐替身, 而不是放宽断言。
    execute: async () => ({ rows: [], rowCount: 1 }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [sysConfig] }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: (v: any) => ({ returning: async () => { inserted.push(v); return [{ id: "vid-1" }]; } }) }),
  },
}));
vi.mock("../models/schema.js", () => ({
  contents: { id: "id", tenantId: "t", type: "type", metadata: "meta" },
  tenants: { id: "id", config: "config" }, costLedger: {}, journals: {}, platformAccounts: {}, opsIncidents: {},
}));
vi.mock("../services/billing/cost-ledger.js", async (orig) => {
  const actual = await orig<typeof import("../services/billing/cost-ledger.js")>();
  return { ...actual, checkBudget: vi.fn(async () => ({ allowed: true })), recordCost: vi.fn(async () => {}) };
});

const { videoRoutes } = await import("../routes/video.js");

/** 一段干净的 135 字口播稿 */
const CLEAN = "很多老师问我，中文核心到底难在哪里。其实难点不在文章本身，而在于选题和期刊定位是否对得上。".repeat(3);
const BG_LIB = "https://bossmate-media.oss-cn-beijing.aliyuncs.com/sys/bg1.jpg";
/** 运营在弹窗里「上传本地图」产生的临时图(在我们自己的桶里, 不进图库) */
const BG_UPLOADED = "https://bossmate-media.oss-cn-beijing.aliyuncs.com/t-1/dvh-backgrounds/1-abc.jpg";
/** 目录扩展出来的自定义形象(老板从阿里云控制台批量导入的那种, 比如男主播) */
const MALE_KEY = "阿强-男_L001";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req: any) => { req.tenantId = "t-1"; req.user = { userId: "u", role: "admin" }; });
  await app.register(videoRoutes, { prefix: "/" });
  return app;
}

/** fire-and-forget: 等落库 */
/**
 * 等异步落库。**8-22 两处修正**：
 *
 * ① 预算从硬编码 1.2s（60×20ms）提到 8s。
 *    CI 修好 .env 之后同批要跑的用例从 2439 涨到 2865，并行负载上去，
 *    1.2s 这个拍脑袋的数就不够了 —— 实测当天连续两次 CI 里这两条一次绿一次红。
 *
 * ② 🔴 **超时必须抛错，不许返回 undefined。**
 *    原来超时后 `inserted[0]?.metadata` 返回 undefined，调用方的断言随后炸在
 *    "expected undefined to be 'https://...'" —— 于是**「没等到」被伪装成「值不对」**，
 *    看日志的人会去查透传逻辑，而真正的问题是这个函数没等够。
 *    红线 #14 的同一个形态：降级产物（等不到）与真产物（值错）在下游无法区分。
 */
async function waitInsert() {
  const deadline = Date.now() + 8000;
  while (inserted.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("waitInsert 超时(8s)：没等到落库 —— 这是等待超时，不是值不对，别去查透传逻辑");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return inserted[0]?.metadata;
}
function aliyunReq() { return captured.find((c) => c.kind === "text")?.req; }
function submitParamsLog() {
  return logSpy.info.mock.calls.find((c) => String(c[1]).startsWith("dvh.submit.params"))?.[0] as any;
}

beforeEach(() => {
  captured.length = 0; inserted.length = 0;
  logSpy.info.mockClear(); logSpy.warn.mockClear(); logSpy.error.mockClear();
  ttsSpy.mockClear();
  incidentSpy.mockClear(); incidentThrottledSpy.mockClear();
  queryMock.mockClear();
  queryMock.mockResolvedValue({ videoUrl: "https://oss/paid.mp4", durationMs: 60000, subtitlesUrl: "" });
  process.env.DVH_TENANT_ID = "1"; process.env.DVH_APP_ID = "app";
  process.env.DVH_REAL_MODE = "true";
  process.env.OSS_BUCKET = "bossmate-media";
  delete process.env.DVH_AUDIO_DRIVEN;
  delete process.env.DVH_DEFAULT_BG_URL;
  delete process.env.__FAKE_SUBMIT_FAIL;
  sysConfig = { config: { automationConfig: {
    dvhCatalog: [{
      key: MALE_KEY, avatarCode: "CH_2d_MALE001", avatarLabel: "阿强-男",
      voiceCode: "aixia", voiceLabel: "艾夏-亲和女声", templateLabel: "阿强-男",
    }],
    dvhBackgrounds: [{ id: "b1", name: "图书馆", url: BG_LIB, orientation: "portrait", width: 1080, height: 1920 }],
  } } };
});

// ===== 1. 🔴 形象 =====
describe("形象 templateId → 阿里云 avatarInfo.code", () => {
  it("内置模板: A_academic → 该模板的 avatarCode(不是别人的默认值)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: "B_marketing" } });
    expect(res.statusCode).toBe(200);
    await waitInsert();
    expect(aliyunReq().avatarInfo.code).toBe("CH_2d_8llEIn0PmNlTWpWs"); // 筱曲站姿02
  });

  it("目录扩展的自定义形象(男主播)也要透传, 不能回落到内置默认", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY } });
    expect(res.statusCode).toBe(200);
    const meta = await waitInsert();
    expect(aliyunReq().avatarInfo.code).toBe("CH_2d_MALE001");
    expect(meta.effective.avatarCode).toBe("CH_2d_MALE001");
    expect(meta.requested.templateId).toBe(MALE_KEY);
  });

  it("目录里没有的 templateId → 400, 绝不静默用默认形象出片(那才是最坑的)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: "不存在的形象" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe("NO_TEMPLATE_ID");
    expect(captured.length).toBe(0);
  });
});

// ===== 2. 🔴 背景 =====
describe("背景 backgroundUrl → 阿里云 videoInfo.backgroundImageUrl", () => {
  it("系统图库选的图: 原样进请求体 + 进 metadata.effective", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY, backgroundUrl: BG_LIB } });
    expect(res.statusCode).toBe(200);
    const meta = await waitInsert();
    expect(aliyunReq().videoInfo.backgroundImageUrl).toBe(BG_LIB);
    expect(meta.effective.backgroundImageUrl).toBe(BG_LIB);
    expect(meta.requested.backgroundUrl).toBe(BG_LIB);
  });

  it("运营本地上传的临时图(自己桶里, 不在图库)也放行并透传", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY, backgroundUrl: BG_UPLOADED } });
    expect(res.statusCode).toBe(200);
    await waitInsert();
    expect(aliyunReq().videoInfo.backgroundImageUrl).toBe(BG_UPLOADED);
  });

  it('"none" 哨兵短路整条优先级链: 即使配了 env 全局背景也必须是黑底', async () => {
    process.env.DVH_DEFAULT_BG_URL = "https://bossmate-media.oss-cn-beijing.aliyuncs.com/sys/env-default.jpg";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY, backgroundUrl: "none" } });
    expect(res.statusCode).toBe(200);
    await waitInsert();
    expect(aliyunReq().videoInfo.backgroundImageUrl).toBeUndefined();
  });

  it("不传背景 → 落到 env 全局默认(mapping 没配背景时的兜底)", async () => {
    const envBg = "https://bossmate-media.oss-cn-beijing.aliyuncs.com/sys/env-default.jpg";
    process.env.DVH_DEFAULT_BG_URL = envBg;
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY } });
    expect(res.statusCode).toBe(200);
    const meta = await waitInsert();
    expect(aliyunReq().videoInfo.backgroundImageUrl).toBe(envBg);
    // 用户没选背景, 但实际用了 env 默认 —— 两者分开记, 才看得出"背景不是我选的"是怎么来的
    expect(meta.requested.backgroundUrl).toBeUndefined();
    expect(meta.effective.backgroundImageUrl).toBe(envBg);
  });

  it("形象自带背景(mapping.backgroundUrl) 让位于本次指定", async () => {
    sysConfig.config.automationConfig.dvhCatalog[0].backgroundUrl = "https://bossmate-media.oss-cn-beijing.aliyuncs.com/sys/mapping-bg.jpg";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY, backgroundUrl: BG_LIB } });
    expect(res.statusCode).toBe(200);
    await waitInsert();
    expect(aliyunReq().videoInfo.backgroundImageUrl).toBe(BG_LIB);
  });

  it("外部图片 URL → 400(未过内容审核, 不许绕开)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY, backgroundUrl: "https://evil.example.com/x.jpg" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe("BAD_BACKGROUND_URL");
  });
});

// ===== 3. ⚠️ 音色: 文字驱动下的既定限制 =====
describe("音色 voiceId — 文字驱动下不生效, 但必须留下证据", () => {
  it("选了音色也仍然用形象自带发音人, 且 metadata 明写 ignoredVoiceRequest", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/dvh-from-text",
      payload: { text: CLEAN, templateId: MALE_KEY, voiceId: "cosyvoice-v2-myclone" },
    });
    expect(res.statusCode).toBe(200);
    const meta = await waitInsert();
    // 真发出去的是形象自带音色
    expect(aliyunReq().audioInfo.voice).toBe("aixia");
    expect(meta.effective.voiceCode).toBe("aixia");
    expect(meta.effective.driveMode).toBe("text");
    // 用户选的那个被忽略了 —— 这件事必须显式记下来, 不能只留一个 voiceOverride 让人误以为生效了
    expect(meta.effective.ignoredVoiceRequest).toBe("cosyvoice-v2-myclone");
    expect(meta.requested.voiceId).toBe("cosyvoice-v2-myclone");
  });

  it("音频驱动(DVH_AUDIO_DRIVEN=1)下音色真生效: TTS 用所选音色, effective.driveMode=audio", async () => {
    process.env.DVH_AUDIO_DRIVEN = "1";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/dvh-from-text",
      payload: { text: CLEAN, templateId: MALE_KEY, voiceId: "cosyvoice-v2-myclone" },
    });
    expect(res.statusCode).toBe(200);
    const meta = await waitInsert();
    expect(ttsSpy).toHaveBeenCalledWith("t-1", expect.any(String), expect.objectContaining({ voice: "cosyvoice-v2-myclone" }));
    expect(meta.effective.driveMode).toBe("audio");
    expect(meta.effective.voiceCode).toBe("cosyvoice-v2-myclone");
    expect(meta.effective.ignoredVoiceRequest).toBeUndefined();
  });
});

// ===== 4. 🔴 存证 & 提交前日志 =====
describe("存证: 选了什么 vs 实际用了什么", () => {
  it("提交前打一条 dvh.submit.params, 内容 = 真正发给阿里云的三件", async () => {
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY, backgroundUrl: BG_LIB, voiceId: "v-x" } });
    await waitInsert();
    const p = submitParamsLog();
    expect(p).toBeTruthy();
    expect(p.avatarCode).toBe("CH_2d_MALE001");
    expect(p.voiceCode).toBe("aixia");
    expect(p.backgroundImageUrl).toBe(BG_LIB);
    expect(p.ignoredVoiceRequest).toBe("v-x");
    expect(p.driveMode).toBe("text");
  });

  /**
   * 8-12 行为变更：submit 失败不再退占位样片。
   * 落的是 status=failed + metadata.deferred 的失败记录（body=口播稿原文，供重跑），
   * 而不是一条「看起来像成品」的视频。7-31 那次只做到「不报 success」，仍然落了假成品；
   * 实测线上因此躺着 4 条 status=draft、看不出异常的片子。
   */
  it("submit 失败 → 不产占位样片, 落 deferred 失败记录(原稿留着)", async () => {
    process.env.__FAKE_SUBMIT_FAIL = "1";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY, backgroundUrl: BG_LIB } });
    expect(res.statusCode).toBe(200); // fire-and-forget, 接口仍是 200 —— 所以更要靠存证认出来
    const meta = await waitInsert();
    expect(meta.placeholder).toBeUndefined();        // 不再有"占位样片"这种东西
    expect(meta.fallbackReason).toBeUndefined();
    expect(meta.failedStage).toBe("dvh_text_produce");
    expect(meta.narrationText).toBe(CLEAN);          // 🔴 原稿必须留着, 否则重跑无米(8-03 教训)
    expect(meta.deferred?.input?.kind).toBe("dvh_text");
    expect(logSpy.error.mock.calls.some((c) => String(c[1]).includes("real_failed_fallback_mock"))).toBe(true);
  });

  it("DVH_REAL_MODE 未开 → 三参数一个都不会发出去, 存证要能一眼看出是 mock_mode", async () => {
    process.env.DVH_REAL_MODE = "false";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY, backgroundUrl: BG_LIB } });
    expect(res.statusCode).toBe(200);
    const meta = await waitInsert();
    expect(captured.length).toBe(0);
    expect(meta.fallbackReason).toBe("mock_mode");
    expect(meta.placeholder).toBe(true);
    expect(meta.effective).toBeUndefined();
    expect(logSpy.warn.mock.calls.some((c) => String(c[1]).includes("mock_mode"))).toBe(true);
    // 7-31 配置事故必须上简报: 误关 DVH_REAL_MODE = 整天条条占位片、界面全绿。走节流版(一开就每条命中)
    expect(incidentThrottledSpy.mock.calls[0]?.[0]).toMatchObject({ kind: "dvh_mock_mode" });
  });
});

// ===== 5. 🔴 7-31 失败必须失败得看得见(三条: 不白扣费 / 不谎报成功 / 不只留日志) =====

/** fire-and-forget: 等某个条件成立(比 waitInsert 更准 —— 有些用例本来就不该落库) */
async function waitFor(pred: () => boolean, ms = 3000) {
  for (let i = 0; i * 20 < ms && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  return pred();
}

describe("TTS 失败 → 直接失败, 绝不带着静音去提交", () => {
  it("音频驱动下 TTS 降级静音: 不提交阿里云(=不扣费)、不落假视频、落 incident, 但**口播稿必须留下来**", async () => {
    process.env.DVH_AUDIO_DRIVEN = "1";
    // TTSService 四个 provider 分支合成失败都会顶一段 silentMp3 上来, fellSilent 是唯一的失败信号
    // 8-03: silentReason 是新增的"为什么失败" —— 这里放百炼欠费的真实报文, 看分类能不能判成 quota
    ttsSpy.mockResolvedValueOnce({
      remotePath: "tts/silent.wav", durationMs: 60000, fellSilent: true,
      silentReason: 'Error: qwen-tts 400 {"type":"Arrearage","message":"Access denied, please make sure your account is in good standing before making a request."}',
    });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY } });
    expect(res.statusCode).toBe(200); // fire-and-forget, 接口照旧 200
    await waitFor(() => inserted.length > 0);

    // ★ 核心: 一个字节都没发给阿里云 —— 静音音频驱动出来的必然是哑巴视频, 而阿里云照秒收钱
    expect(captured.length).toBe(0);
    expect(incidentSpy.mock.calls[0]?.[0]).toMatchObject({ kind: "dvh_tts_failed", severity: "error" });
    expect(logSpy.error.mock.calls.some((c) => String(c[1]).includes("dvh.tts.silent_abort"))).toBe(true);
    // 不许谎报成功
    expect(logSpy.info.mock.calls.some((c) => String(c[1]) === "dvh.text.success")).toBe(false);

    // ★ 8-03 改口径: 以前这里断言 inserted.length === 0(什么都不落库)。
    //   那正是老板那条 157 字口播稿蒸发的原因 —— 不落库 = 界面上什么都没有, 稿子只在他脑子里。
    //   现在落的**不是假视频**(status=failed, 没有 videoUrl), 而是一条"这次失败了 + 原稿在这"的记录。
    expect(inserted.length).toBe(1);
    const rec = inserted[0];
    expect(rec.status).toBe("failed");
    expect(rec.body).toBe(CLEAN);                          // 🔴 口播稿原文, 运营点开就能拷走
    expect(rec.metadata.narrationText).toBe(CLEAN);
    expect(rec.metadata.videoUrl).toBeUndefined();          // 绝不是一条视频
    // ★ 失败分类: TTS 的真因是百炼欠费 → quota_exceeded(充值后自动重跑), 且原始输入齐全
    expect(rec.metadata.deferred.reason).toBe("quota_exceeded");
    expect(rec.metadata.deferred.retryCount).toBe(0);
    expect(rec.metadata.deferred.input).toMatchObject({ kind: "dvh_text", text: CLEAN, templateId: MALE_KEY });
    expect(incidentSpy.mock.calls.some((c) => c[0]?.kind === "content_deferred")).toBe(true);
  });

  it("TTS 正常(fellSilent=false)时不受影响: 照常提交", async () => {
    process.env.DVH_AUDIO_DRIVEN = "1";
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY } });
    await waitInsert();
    expect(captured.some((c) => c.kind === "audio")).toBe(true);
    expect(incidentSpy).not.toHaveBeenCalled();
  });
});

describe("success 只在真拿到成片时报 + 失败落 incident", () => {
  /**
   * 🔴 9-04 件 2 改了这条的语义, 断言随之更新(不是加进基线)。
   *
   * 【原断言】请求内查不到成片 → 当场落 dvh_paid_task_orphaned, 文案「可凭 taskUuid 去阿里云捞回」。
   * 【为什么改】9-03 逐个查了那 10 条"孤儿"的 taskUuid, 把原文案**证伪**了:
   *     7 条 status=4 / 10010002   1 条 status=4 / 10050005
   *     1 条 status=3 其实成功了     1 条 status=6 结果已过期
   *   10 条里只有 1 条真有成片可捞, 8 条阿里云早已明确判失败 —— **捞无可捞**,
   *   那句话把损失说成了待办。而且"请求内查不到"≠"任务失败":
   *   9 条阿里云都有终态, 只是我们的 10 分钟轮询先放弃了。
   * 【现语义】请求内放弃 → 不再当场判孤儿, 只记日志, 任务交给轮询器跟到 24 小时。
   *   真正的孤儿判定在 dvh-poller.listOverdueDvhTasks(24h 内拿不到任何终态)。
   */
  it("已扣费却取不回成片: 不产占位样片, 不当场判孤儿(交给轮询器跟 24h)", async () => {
    queryMock.mockRejectedValue(new Error("query timeout"));
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY } });
    const meta = await waitInsert();

    expect(meta.placeholder).toBeUndefined();
    expect(meta.fallbackReason).toBeUndefined();
    expect(meta.narrationText).toBe(CLEAN);
    // ★ 不再在请求内落孤儿告警 —— 那是轮询器 24 小时后的职责
    const inc = incidentSpy.mock.calls.map((c) => c[0] as any).find((a) => a.kind === "dvh_paid_task_orphaned");
    expect(inc).toBeUndefined();
    // ★ 但必须留下"交给轮询器"的痕迹, 不能悄无声息
    expect(logSpy.info.mock.calls.some((c) => String(c[1]).startsWith("dvh.inline_query_gave_up"))).toBe(true);
    // ★ 仍然不许叫 success
    expect(logSpy.info.mock.calls.some((c) => String(c[1]) === "dvh.text.success")).toBe(false);
  });

  it("submit 失败: 不许叫 success, 且落 dvh_submit_failed incident", async () => {
    process.env.__FAKE_SUBMIT_FAIL = "1";
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY } });
    await waitInsert();
    expect(logSpy.info.mock.calls.some((c) => String(c[1]) === "dvh.text.success")).toBe(false);
    expect(incidentSpy.mock.calls.map((c) => (c[0] as any).kind)).toContain("dvh_submit_failed");
  });

  it("真拿到成片才报 success(防过度收紧: 别修成一条都不报了)", async () => {
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/dvh-from-text", payload: { text: CLEAN, templateId: MALE_KEY } });
    const meta = await waitInsert();
    expect(meta.fallbackReason).toBeUndefined();
    expect(logSpy.info.mock.calls.some((c) => String(c[1]) === "dvh.text.success")).toBe(true);
    expect(incidentSpy).not.toHaveBeenCalled();
  });
});
