/**
 * 7-29 「存入背景图库,下次直接选」 — 勾选入库链路单测。
 *
 * 要盯死的四件事:
 *   1. 不勾 = 老行为(落租户目录, 一个字都不写图库) —— 别把默认行为改了
 *   2. 勾了 = 落 SYSTEM 目录 + 入库 + 留痕(uploadedBy/source/sha256), 运营(member)也能存
 *   3. 存不进去必须**说出来**: 满 60 张 / 同图重复, 都要带原因回前端, 不能静默
 *   4. 三道保护绕不过: 勾选入库和临时上传共用同一个 processBackgroundUpload,
 *      比例不对 / 审核 block 一样拒绝, 且图库不留残条目
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    UPLOAD_DIR: "/tmp/bossmate-test-uploads",
    VIDEO_MAX_DURATION_SEC: 120, VIDEO_TENANT_MAX_CONCURRENT: 2,
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

// ---- storage ----
const uploadMock = vi.fn(async (_b: Buffer, remotePath: string) => `https://bossmate-media.oss-cn-beijing.aliyuncs.com/${remotePath}`);
const deleteMock = vi.fn(async () => undefined);
vi.mock("../services/storage/index.js", () => ({
  storage: { upload: uploadMock, delete: deleteMock, getSignedUrl: vi.fn(async (p: string) => `https://signed/${p}`) },
}));

// ---- 图库数据源: db 读写都打在这个数组上, 让 load/save 形成真闭环 ----
let systemBackgrounds: Array<Record<string, unknown>> = [];
const dbUpdateMock = vi.fn();
vi.mock("../models/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ config: { automationConfig: { dvhBackgrounds: systemBackgrounds } } }] }),
      }),
    }),
    update: () => ({
      set: (v: { config?: { automationConfig?: { dvhBackgrounds?: Array<Record<string, unknown>> } } }) => {
        dbUpdateMock(v);
        const next = v?.config?.automationConfig?.dvhBackgrounds;
        if (Array.isArray(next)) systemBackgrounds = next;
        return { where: async () => undefined };
      },
    }),
  },
}));
vi.mock("../models/schema.js", () => ({ tenants: { id: "id_col", config: "config_col" }, contents: { id: "id", tenantId: "t" } }));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ kind: "eq", a, b }),
  and: (...xs: unknown[]) => ({ kind: "and", xs }),
  desc: (x: unknown) => x,
}));

// ---- 内容审核: 默认放行 ----
const moderateImagesMock = vi.fn(async () => ({ blocked: false, results: [] as Array<{ suggestion: string; label: string }> }));
vi.mock("../services/compliance/image-moderation.js", () => ({
  moderateImages: moderateImagesMock,
  IMAGE_MODERATION_ENABLED: true,
}));

// ---- 队列(video.ts 顶层 import, 本测试用不到) ----
vi.mock("../services/task/queue.js", () => ({ videoQueue: { getJobs: async () => [], add: async () => ({ id: "j1" }) } }));

const { videoRoutes } = await import("../routes/video.js");
const bgLib = await import("../services/digital-human/background-library.js");

/** 造一张指定尺寸的真 JPEG；seed 变了字节就变了(用来造"不同的图") */
async function makeImage(width: number, height: number, seed = 10): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width, height, channels: 3, background: { r: seed, g: 20, b: 30 } } }).jpeg().toBuffer();
}

/** 手搓 multipart body — 仓库里没有 form-data 依赖, 而字段/文件的**先后顺序**恰恰是要测的点 */
const BOUNDARY = "----bossmatetestboundary";
function multipart(parts: Array<{ name: string; value: string } | { name: string; filename: string; contentType: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    if ("value" in p) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
        `Content-Type: ${p.contentType}\r\n\r\n`,
      ));
      chunks.push(p.data);
      chunks.push(Buffer.from("\r\n"));
    }
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

async function buildApp(role = "member"): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register((await import("@fastify/multipart")).default, { limits: { fileSize: 50 * 1024 * 1024 } });
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req) => {
    (req as unknown as { tenantId: string }).tenantId = "t-1";
    (req as unknown as { user: { userId: string; role: string } }).user = { userId: "u-op", role };
  });
  await app.register(videoRoutes, { prefix: "/" });
  return app;
}

async function post(app: FastifyInstance, url: string, body: Buffer) {
  return app.inject({
    method: "POST", url, payload: body,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  });
}

beforeEach(() => {
  systemBackgrounds = [];
  uploadMock.mockClear();
  deleteMock.mockClear();
  dbUpdateMock.mockClear();
  moderateImagesMock.mockClear();
  moderateImagesMock.mockResolvedValue({ blocked: false, results: [] });
  process.env.OSS_BUCKET = "bossmate-media";
});

// ===== 1. 默认行为不变 =====

describe("不勾「存入图库」= 老行为", () => {
  it("落租户目录, 图库一个字都不写", async () => {
    const app = await buildApp();
    const img = await makeImage(1080, 1920);
    const r = await post(app, "/dvh-background", multipart([{ name: "image", filename: "a.jpg", contentType: "image/jpeg", data: img }]));
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.remotePath).toContain("t-1/dvh-backgrounds/");
    expect(d.savedToLibrary).toBe(false);
    expect(dbUpdateMock).not.toHaveBeenCalled();   // 没碰过图库
    expect(systemBackgrounds).toHaveLength(0);
  });
});

// ===== 2. 勾选入库 =====

describe("勾了「存入图库」", () => {
  it("multipart 字段(排在文件前) → 落 SYSTEM 目录 + 入库 + 留痕", async () => {
    const app = await buildApp();
    const img = await makeImage(1080, 1920);
    const r = await post(app, "/dvh-background", multipart([
      { name: "saveToLibrary", value: "1" },
      { name: "image", filename: "白墙背景.jpg", contentType: "image/jpeg", data: img },
    ]));
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.savedToLibrary).toBe(true);
    expect(d.libraryStatus).toBe("added");
    expect(d.remotePath).not.toContain("t-1/");        // 不落租户目录 → 不怕日后清租户对象
    expect(d.remotePath).toContain("/dvh-backgrounds/");
    expect(uploadMock).toHaveBeenCalledTimes(1);        // 一次上传写对位置, 没有 OSS 拷贝+删除
    expect(systemBackgrounds).toHaveLength(1);
    const e = systemBackgrounds[0] as Record<string, unknown>;
    expect(e.url).toBe(d.url);
    expect(e.name).toBe("白墙背景");
    expect(e.uploadedBy).toBe("u-op");                  // 谁传的
    expect(e.source).toBe("generate");                  // 从哪个入口进来的
    expect(e.createdAt).toBeTruthy();                   // 什么时候
    expect(String(e.sha256)).toHaveLength(64);
  });

  it("字段排在文件**后面**也生效 —— multipart 是流式的, 顺序不能假设", async () => {
    const app = await buildApp();
    const img = await makeImage(1080, 1920, 11);
    const r = await post(app, "/dvh-background", multipart([
      { name: "image", filename: "b.jpg", contentType: "image/jpeg", data: img },
      { name: "saveToLibrary", value: "true" },
    ]));
    expect(r.json().data.savedToLibrary).toBe(true);
    expect(systemBackgrounds).toHaveLength(1);
  });

  it("query ?saveToLibrary=1 也认", async () => {
    const app = await buildApp();
    const img = await makeImage(1920, 1080, 12);
    const r = await post(app, "/dvh-background?saveToLibrary=1", multipart([
      { name: "image", filename: "c.jpg", contentType: "image/jpeg", data: img },
    ]));
    expect(r.json().data.savedToLibrary).toBe(true);
    expect((systemBackgrounds[0] as Record<string, unknown>).orientation).toBe("landscape");
  });

  it("权限: 运营(member)勾选也能存 —— 图库是共享资产, 存不进去这功能就白做了", async () => {
    const app = await buildApp("member");
    const img = await makeImage(1080, 1920, 13);
    const r = await post(app, "/dvh-background", multipart([
      { name: "saveToLibrary", value: "1" },
      { name: "image", filename: "d.jpg", contentType: "image/jpeg", data: img },
    ]));
    expect(r.statusCode).toBe(200);          // 不是 403 —— 这条路由没挂 adminOnly
    expect(r.json().data.savedToLibrary).toBe(true);
  });
});

// ===== 3. 防乱塞: 满了 / 重复 都要明说 =====

describe("防乱塞", () => {
  it("图库满 60 张 → 上传仍成功可用, 但明确告知没存进去(不静默失败)", async () => {
    systemBackgrounds = Array.from({ length: bgLib.DVH_BACKGROUNDS_MAX }, (_, i) => ({
      id: `bg${i}`, name: `图${i}`, url: `https://bossmate-media.oss-cn-beijing.aliyuncs.com/x/${i}.jpg`,
      orientation: "portrait", width: 1080, height: 1920,
    }));
    const app = await buildApp();
    const img = await makeImage(1080, 1920, 14);
    const r = await post(app, "/dvh-background", multipart([
      { name: "saveToLibrary", value: "1" },
      { name: "image", filename: "e.jpg", contentType: "image/jpeg", data: img },
    ]));
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.url).toBeTruthy();                       // 本次生成照常能用
    expect(d.savedToLibrary).toBe(false);
    expect(d.libraryStatus).toBe("full");
    expect(d.libraryMessage).toContain("已满");
    expect(d.libraryMessage).toContain(String(bgLib.DVH_BACKGROUNDS_MAX));
    expect(systemBackgrounds).toHaveLength(bgLib.DVH_BACKGROUNDS_MAX); // 没被挤掉任何一张
  });

  it("同一张图反复勾选存入 → 只占一格, 复用图库里那条, 不再传一次 OSS", async () => {
    const app = await buildApp();
    const img = await makeImage(1080, 1920, 15);
    const body = () => multipart([
      { name: "saveToLibrary", value: "1" },
      { name: "image", filename: "same.jpg", contentType: "image/jpeg", data: img },
    ]);
    const r1 = await post(app, "/dvh-background", body());
    expect(r1.json().data.libraryStatus).toBe("added");
    expect(systemBackgrounds).toHaveLength(1);

    uploadMock.mockClear();
    const r2 = await post(app, "/dvh-background", body());
    const d2 = r2.json().data;
    expect(d2.libraryStatus).toBe("duplicate");
    expect(d2.savedToLibrary).toBe(true);              // 对用户来说"图库里有了"就是成功
    expect(d2.url).toBe(r1.json().data.url);           // 复用同一条
    expect(uploadMock).not.toHaveBeenCalled();         // 一个字节都没再传
    expect(systemBackgrounds).toHaveLength(1);
  });
});

// ===== 4. 三道保护绕不过 =====

describe("勾选入库不能绕过校验", () => {
  it("比例不对(4:3) → 400, 图库不留残条目, OSS 一个字节都没进", async () => {
    const app = await buildApp();
    const img = await makeImage(1200, 900);
    const r = await post(app, "/dvh-background", multipart([
      { name: "saveToLibrary", value: "1" },
      { name: "image", filename: "bad.jpg", contentType: "image/jpeg", data: img },
    ]));
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("BAD_ASPECT_RATIO");
    expect(uploadMock).not.toHaveBeenCalled();
    expect(systemBackgrounds).toHaveLength(0);
  });

  it("内容审核 block → 400 + 删掉已传对象, 图库不留残条目", async () => {
    moderateImagesMock.mockResolvedValue({ blocked: true, results: [{ suggestion: "block", label: "porn" }] });
    const app = await buildApp();
    const img = await makeImage(1080, 1920, 16);
    const r = await post(app, "/dvh-background", multipart([
      { name: "saveToLibrary", value: "1" },
      { name: "image", filename: "bad2.jpg", contentType: "image/jpeg", data: img },
    ]));
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("IMAGE_MODERATION_BLOCKED");
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(systemBackgrounds).toHaveLength(0);
  });

  it("非法 MIME(gif) → 400, 不入库", async () => {
    const app = await buildApp();
    const r = await post(app, "/dvh-background", multipart([
      { name: "saveToLibrary", value: "1" },
      { name: "image", filename: "x.gif", contentType: "image/gif", data: Buffer.from("GIF89a") },
    ]));
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("INVALID_TYPE");
    expect(systemBackgrounds).toHaveLength(0);
  });
});

// ===== 5. 服务层 =====

describe("addBackgroundToLibrary / 指纹", () => {
  it("同内容同指纹, 不同内容不同指纹", async () => {
    const a = await makeImage(1080, 1920, 20);
    const b = await makeImage(1080, 1920, 21);
    expect(bgLib.hashBackgroundBuffer(a)).toBe(bgLib.hashBackgroundBuffer(Buffer.from(a)));
    expect(bgLib.hashBackgroundBuffer(a)).not.toBe(bgLib.hashBackgroundBuffer(b));
  });

  it("整表写回不会把 uploadedBy/source/sha256 抹掉(normalize 必须透传)", async () => {
    const saved = await bgLib.saveDvhBackgrounds([{
      id: "bg1", name: "白墙", url: "https://x/a.jpg", orientation: "portrait", width: 1080, height: 1920,
      uploadedBy: "u-op", source: "generate", sha256: "a".repeat(64),
    }]);
    expect(saved[0].uploadedBy).toBe("u-op");
    expect(saved[0].source).toBe("generate");
    expect(saved[0].sha256).toBe("a".repeat(64));
  });

  it("findLibraryBackgroundByHash: 旧条目没指纹 → 查不到 → 当新图处理(不会误判)", async () => {
    systemBackgrounds = [{ id: "old", name: "老图", url: "https://x/old.jpg", orientation: "portrait", width: 1080, height: 1920 }];
    expect(await bgLib.findLibraryBackgroundByHash("b".repeat(64))).toBeUndefined();
  });
});
