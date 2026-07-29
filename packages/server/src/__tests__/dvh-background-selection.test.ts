/**
 * 7-29 数字人视频背景图 — 行为单测(三道保护 + 优先级链)。
 *
 * 覆盖:
 *   a. 尺寸/宽高比校验: 9:16 / 16:9 各种比例进出
 *   b. URL 可达性预检: 不可达 → 抛错拒绝提交(不静默降级黑底)
 *   c. 图片内容审核: block → 拒绝上传 + 清掉已传的 OSS 对象
 *   d. 优先级链: 单次指定 > per-template > env > undefined; 哨兵 "none" 短路
 *   e. 生成入口准入: 外部 URL 拒绝(否则绕过内容审核)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test", UPLOAD_DIR: "/tmp/bossmate-test-uploads",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---- storage: 记录 upload/delete 调用, 返回一个假的 OSS 公网 URL ----
const uploadMock = vi.fn(async (_b: Buffer, remotePath: string) => `https://bossmate-media.oss-cn-beijing.aliyuncs.com/${remotePath}`);
const deleteMock = vi.fn(async () => undefined);
vi.mock("../services/storage/index.js", () => ({
  storage: { upload: uploadMock, delete: deleteMock, getSignedUrl: vi.fn(async (p: string) => `https://signed/${p}`) },
}));

// ---- 系统图库: 直接控制 loadDvhBackgrounds 的数据源(tenants 表) ----
let systemBackgrounds: unknown[] = [];
vi.mock("../models/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ config: { automationConfig: { dvhBackgrounds: systemBackgrounds } } }] }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

// ---- 内容审核: 默认放行, 单测里按需改成 block ----
const moderateImagesMock = vi.fn(async () => ({ blocked: false, results: [] as Array<{ suggestion: string; label: string }> }));
vi.mock("../services/compliance/image-moderation.js", () => ({
  moderateImages: moderateImagesMock,
  IMAGE_MODERATION_ENABLED: true,
}));

// ---- 阿里云 DVH SDK: 只为了让 submit-task.ts 能 import 进来测 resolveBackgroundUrl, 不真发请求 ----
vi.mock("../services/digital-human/client.js", () => ({
  createDvhClient: vi.fn(),
  isRealMode: () => false,
  $avatar20220130: {},
}));

const bg = await import("../services/digital-human/background-library.js");
const { resolveBackgroundUrl } = await import("../services/digital-human/submit-task.js");

/** 造一张指定尺寸的真 JPEG(让 sharp 能解出 metadata) */
async function makeImage(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
}

beforeEach(() => {
  systemBackgrounds = [];
  uploadMock.mockClear();
  deleteMock.mockClear();
  moderateImagesMock.mockClear();
  moderateImagesMock.mockResolvedValue({ blocked: false, results: [] });
  delete process.env.DVH_BG_PRECHECK;
  delete process.env.DVH_DEFAULT_BG_URL;
  process.env.OSS_BUCKET = "bossmate-media";
});
afterEach(() => { vi.restoreAllMocks(); });

// ===== a. 尺寸 / 宽高比 =====

describe("a. 背景图尺寸/宽高比校验 (±5% 相对容差)", () => {
  const V = bg.validateBackgroundGeometry;

  it("标准竖版 1080×1920 → portrait", () => {
    const r = V(1080, 1920);
    expect(r.ok).toBe(true);
    expect(r.ok && r.orientation).toBe("portrait");
  });

  it("标准横版 1920×1080 → landscape", () => {
    const r = V(1920, 1080);
    expect(r.ok).toBe(true);
    expect(r.ok && r.orientation).toBe("landscape");
  });

  it("1600×900 (16:9 小一号) 放行", () => {
    expect(V(1600, 900).ok).toBe(true);
  });

  it("容差内的导出误差 1080×1912 放行", () => {
    expect(V(1080, 1912).ok).toBe(true);
  });

  it("4:3 (1440×1080) 拒绝, 报错文案说清「你传的是几比几」", () => {
    const r = V(1440, 1080);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("BAD_ASPECT_RATIO");
      expect(r.message).toContain("4:3");
      expect(r.message).toContain("1440×1080");
    }
  });

  it("3:4 竖图 (1080×1440) 拒绝", () => {
    expect(V(1080, 1440).ok).toBe(false);
  });

  it("正方形 1080×1080 两边都不沾 → 拒绝", () => {
    expect(V(1080, 1080).ok).toBe(false);
  });

  it("1080×1800 (3:5, 偏 6.7% 超出容差) 拒绝 —— 容差就是用来卡这种「差一点」的", () => {
    expect(V(1080, 1800).ok).toBe(false);
  });

  it("expect=portrait 时, 合规的横版也要拒(方向不匹配)", () => {
    const r = V(1920, 1080, "portrait");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("9:16");
  });

  it("比例对但太小 (540×960) 拒绝, 短边下限 720", () => {
    const r = V(540, 960);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("IMAGE_TOO_SMALL");
  });

  it("尺寸读不出来 → INVALID_IMAGE", () => {
    const r = V(undefined, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_IMAGE");
  });
});

// ===== b. 可达性预检 =====

describe("b. 背景 URL 可达性预检", () => {
  it("HEAD 200 + image content-type → 放行", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } })));
    await expect(bg.assertBackgroundReachable("https://cdn.example.com/a.jpg")).resolves.toBeUndefined();
  });

  it("HEAD 405 但 GET Range 200 → 放行 (CDN 常见: 只认 GET)", async () => {
    const f = vi.fn(async (_u: string, init: any) =>
      init.method === "HEAD"
        ? new Response(null, { status: 405 })
        : new Response("x", { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", f);
    await expect(bg.assertBackgroundReachable("https://cdn.example.com/a.png")).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("403 (桶从公共读改私有) → 抛错拒绝提交, 报错点名 oss:check", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    await expect(bg.assertBackgroundReachable("https://bossmate-media.oss-cn-beijing.aliyuncs.com/x.jpg"))
      .rejects.toThrow(/不可达.*已拒绝提交/s);
  });

  it("网络异常/超时 → 抛错 (不静默降级黑底)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ETIMEDOUT"); }));
    await expect(bg.assertBackgroundReachable("https://cdn.example.com/a.jpg")).rejects.toThrow(bg.BackgroundUnreachableError);
  });

  it("返回的是 HTML 不是图片 → 拒绝", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    await expect(bg.assertBackgroundReachable("https://example.com/notanimage")).rejects.toThrow();
  });

  it("相对路径 → 直接拒(阿里云拉不到, 会静默黑底)", async () => {
    await expect(bg.assertBackgroundReachable("/storage/t1/a.jpg")).rejects.toThrow(/公网 http\(s\) 绝对地址/);
  });

  it("逃生开关 DVH_BG_PRECHECK=0 → 完全跳过, 不发请求", async () => {
    process.env.DVH_BG_PRECHECK = "0";
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(bg.assertBackgroundReachable("https://whatever/x.jpg")).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});

// ===== c. 上传 (尺寸 + 审核) =====

describe("c. 背景图上传处理", () => {
  it("合规竖版 → 落 OSS, 返回公网 URL + orientation", async () => {
    const buf = await makeImage(1080, 1920);
    const r = await bg.processBackgroundUpload({ buffer: buf, mimetype: "image/jpeg", tenantId: "t1", scope: "tenant" });
    expect(r.orientation).toBe("portrait");
    expect(r.url).toMatch(/^https:\/\/bossmate-media\./);
    expect(r.remotePath).toContain("t1/dvh-backgrounds/");
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it("scope=system → 存 SYSTEM 租户目录(全租户共享), 不是调用者租户", async () => {
    const buf = await makeImage(1920, 1080);
    const r = await bg.processBackgroundUpload({ buffer: buf, mimetype: "image/jpeg", tenantId: "t1", scope: "system" });
    expect(r.remotePath).not.toContain("t1/");
    expect(r.remotePath).toContain("/dvh-backgrounds/");
  });

  it("比例不对 → 上传前就拒, 一个字节都不进 OSS", async () => {
    const buf = await makeImage(1200, 900); // 4:3
    await expect(bg.processBackgroundUpload({ buffer: buf, mimetype: "image/jpeg", tenantId: "t1", scope: "tenant" }))
      .rejects.toThrow(/9:16 竖版/);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("MIME 不在白名单 → 拒", async () => {
    await expect(bg.processBackgroundUpload({ buffer: Buffer.from("x"), mimetype: "image/gif", tenantId: "t1", scope: "tenant" }))
      .rejects.toThrow(/不支持的图片格式/);
  });

  it("审核 block → 拒绝上传, 并把已传的 OSS 对象删掉(违规图不留在桶里)", async () => {
    moderateImagesMock.mockResolvedValue({ blocked: true, results: [{ suggestion: "block", label: "porn" }] });
    const buf = await makeImage(1080, 1920);
    await expect(bg.processBackgroundUpload({ buffer: buf, mimetype: "image/jpeg", tenantId: "t1", scope: "tenant" }))
      .rejects.toThrow(/内容审核未通过/);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it("审核 review → 放行(只记 warn), 不拦上传", async () => {
    moderateImagesMock.mockResolvedValue({ blocked: false, results: [{ suggestion: "review", label: "ad" }] });
    const buf = await makeImage(1080, 1920);
    await expect(bg.processBackgroundUpload({ buffer: buf, mimetype: "image/jpeg", tenantId: "t1", scope: "tenant" }))
      .resolves.toBeDefined();
  });
});

// ===== d. 优先级链 =====

describe("d. 背景图优先级链: 单次指定 > per-template > env > 黑底", () => {
  const OPT = "https://oss/opt.jpg";
  const MAP = "https://oss/mapping.jpg";
  const ENV = "https://oss/env.jpg";

  it("三级都有 → 取单次指定", () => {
    process.env.DVH_DEFAULT_BG_URL = ENV;
    expect(resolveBackgroundUrl(OPT, MAP)).toBe(OPT);
  });

  it("没传单次 → 取形象自带 (per-template)", () => {
    process.env.DVH_DEFAULT_BG_URL = ENV;
    expect(resolveBackgroundUrl(undefined, MAP)).toBe(MAP);
  });

  it("单次和形象都没有 → 取 env 全局默认", () => {
    process.env.DVH_DEFAULT_BG_URL = ENV;
    expect(resolveBackgroundUrl(undefined, undefined)).toBe(ENV);
  });

  it("三级都没有 → undefined (DVH 默认黑底)", () => {
    expect(resolveBackgroundUrl(undefined, undefined)).toBeUndefined();
  });

  it('哨兵 "none" 短路整条链 → undefined, 即使形象和 env 都配了背景', () => {
    process.env.DVH_DEFAULT_BG_URL = ENV;
    expect(resolveBackgroundUrl(bg.DVH_BG_NONE, MAP)).toBeUndefined();
  });

  it("哨兵常量值就是 \"none\" (前后端约定, 改了两头都要动)", () => {
    expect(bg.DVH_BG_NONE).toBe("none");
  });
});

// ===== e. 生成入口准入 =====

describe("e. 生成入口 backgroundUrl 准入", () => {
  it('"none" 哨兵放行', async () => {
    const r = await bg.validateGenerationBackgroundUrl("none");
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toBe("none");
  });

  it("系统图库里的 URL 放行", async () => {
    systemBackgrounds = [{ id: "bg1", name: "白墙", url: "https://cdn.partner.com/wall.jpg", orientation: "portrait", width: 1080, height: 1920 }];
    expect((await bg.validateGenerationBackgroundUrl("https://cdn.partner.com/wall.jpg")).ok).toBe(true);
  });

  it("自家 OSS 桶的 URL 放行(说明经过了我们的上传接口 = 已过审核)", async () => {
    expect((await bg.validateGenerationBackgroundUrl("https://bossmate-media.oss-cn-beijing.aliyuncs.com/t1/dvh-backgrounds/a.jpg")).ok).toBe(true);
  });

  it("外部随便一个图片 URL → 拒(否则就绕过了内容审核)", async () => {
    const r = await bg.validateGenerationBackgroundUrl("https://evil.example.com/whatever.jpg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("未经内容审核");
  });

  it("非 http(s) → 拒", async () => {
    expect((await bg.validateGenerationBackgroundUrl("data:image/png;base64,AAAA")).ok).toBe(false);
  });
});
