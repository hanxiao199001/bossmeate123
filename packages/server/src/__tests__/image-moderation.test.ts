/**
 * 7-14 P1 图片内容审核 — moderateImages 结果映射 + 失败兜底 + 空数组 + extractImageUrls。
 * 真实阿里云 ImageModeration 不在沙箱调(无凭证), 全程 mock openapi-client callApi 只测本地映射逻辑。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: {
    IMAGE_MODERATION_ENABLED: true,
    IMAGE_MODERATION_STRICT: false,
    IMAGE_MODERATION_ENDPOINT: "green-cloud.cn-shanghai.aliyuncs.com",
    IMAGE_MODERATION_BLOCK_SCORE: 90,
    IMAGE_MODERATION_REVIEW_SCORE: 60,
    IMAGE_MODERATION_CONCURRENCY: 10,
    IMAGE_MODERATION_MAX_IMAGES: 20,
    IMAGE_MODERATION_TIMEOUT_MS: 8000,
  },
  // 每个 case 替换: (imageUrl) => 阿里云响应 body.Data.Result, 或 throw 模拟 API 挂
  fn: null as null | ((imageUrl: string) => Array<{ Label: string; Confidence: number }>),
}));

vi.mock("../config/env.js", () => ({ env: h.env }));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@alicloud/tea-util", () => ({
  RuntimeOptions: class { constructor(o: any) { Object.assign(this, o); } },
  default: {},
}));
vi.mock("@alicloud/credentials", () => ({
  default: class { constructor(_c: any) { /* noop */ } },
  Config: class { constructor(o: any) { Object.assign(this, o); } },
}));
vi.mock("@alicloud/openapi-client", () => ({
  Config: class { endpoint = ""; constructor(o: any) { Object.assign(this, o); } },
  Params: class { constructor(o: any) { Object.assign(this, o); } },
  OpenApiRequest: class { body: any; constructor(o: any) { Object.assign(this, o); } },
  default: class {
    constructor(_cfg: any) { /* noop */ }
    async callApi(_params: any, request: any, _runtime: any) {
      const sp = JSON.parse(request.body.ServiceParameters);
      if (!h.fn) throw new Error("no fixture");
      const result = h.fn(sp.imageUrl); // 可 throw 模拟 API 挂
      return { body: { Code: 200, Data: { Result: result } }, statusCode: 200, headers: {} };
    }
  },
}));

const { moderateImages, extractImageUrls } = await import("../services/compliance/image-moderation.js");

beforeEach(() => {
  process.env.ALIYUN_ACCESS_KEY_ID = "test-ak";
  process.env.ALIYUN_ACCESS_KEY_SECRET = "test-sk";
  h.env.IMAGE_MODERATION_STRICT = false;
  h.fn = null;
});

describe("moderateImages — 结果映射", () => {
  it("高分风险标签 → block, blocked=true", async () => {
    h.fn = () => [{ Label: "sexual_content", Confidence: 95 }];
    const r = await moderateImages(["https://oss/a.jpg"]);
    expect(r.blocked).toBe(true);
    expect(r.results[0].suggestion).toBe("block");
    expect(r.results[0].label).toBe("sexual_content");
    expect(r.results[0].score).toBe(95);
  });

  it("中分风险标签 → review, 警告放行 blocked=false", async () => {
    h.fn = () => [{ Label: "ad", Confidence: 70 }];
    const r = await moderateImages(["https://oss/b.jpg"]);
    expect(r.blocked).toBe(false);
    expect(r.results[0].suggestion).toBe("review");
  });

  it("nonLabel / 低分 → pass, 放行", async () => {
    h.fn = () => [{ Label: "nonLabel", Confidence: 99 }];
    const r = await moderateImages(["https://oss/c.jpg"]);
    expect(r.blocked).toBe(false);
    expect(r.results[0].suggestion).toBe("pass");
    expect(r.results[0].label).toBe("nonLabel");
  });

  it("批量: 一张 block 即整体 blocked=true", async () => {
    h.fn = (url) => (url.includes("bad") ? [{ Label: "violence", Confidence: 92 }] : [{ Label: "nonLabel", Confidence: 10 }]);
    const r = await moderateImages(["https://oss/ok.jpg", "https://oss/bad.jpg", "https://oss/ok2.jpg"]);
    expect(r.blocked).toBe(true);
    expect(r.results.filter((x) => x.suggestion === "block")).toHaveLength(1);
  });
});

describe("moderateImages — 空/非法输入", () => {
  it("空数组 → blocked=false 且不调 API", async () => {
    h.fn = () => { throw new Error("不该被调用"); };
    const r = await moderateImages([]);
    expect(r).toEqual({ blocked: false, results: [] });
  });

  it("非 http(s) URL 被过滤 → 视为空", async () => {
    h.fn = () => { throw new Error("不该被调用"); };
    const r = await moderateImages(["data:image/svg+xml;base64,xxx", "/local/path.png"]);
    expect(r).toEqual({ blocked: false, results: [] });
  });
});

describe("moderateImages — 失败兜底(API 挂/超时)", () => {
  it("strict=false: API 挂 → 放行(blocked=false) + fallback=skipped_error", async () => {
    h.env.IMAGE_MODERATION_STRICT = false;
    h.fn = () => { throw new Error("ETIMEDOUT"); };
    const r = await moderateImages(["https://oss/x.jpg"]);
    expect(r.blocked).toBe(false);
    expect(r.fallback).toBe("skipped_error");
    expect(r.results[0].suggestion).toBe("pass");
  });

  it("strict=true: API 挂 → 拦截(blocked=true) + fallback=skipped_error", async () => {
    h.env.IMAGE_MODERATION_STRICT = true;
    h.fn = () => { throw new Error("ETIMEDOUT"); };
    const r = await moderateImages(["https://oss/x.jpg"]);
    expect(r.blocked).toBe(true);
    expect(r.fallback).toBe("skipped_error");
    expect(r.results[0].suggestion).toBe("block");
  });
});

describe("extractImageUrls — 收集封面 + 正文内嵌图", () => {
  it("封面 + 内嵌 http 图去重, 忽略 data: 内联 SVG", () => {
    const html = `<p>x</p><img src="https://cdn/a.jpg"><img src='https://cdn/b.png'>` +
      `<img src="data:image/svg+xml;utf8,<svg/>"><img src="https://cdn/a.jpg">`;
    const urls = extractImageUrls(html, "https://cdn/cover.jpg");
    expect(urls).toContain("https://cdn/cover.jpg");
    expect(urls).toContain("https://cdn/a.jpg");
    expect(urls).toContain("https://cdn/b.png");
    expect(urls.filter((u) => u === "https://cdn/a.jpg")).toHaveLength(1); // 去重
    expect(urls.some((u) => u.startsWith("data:"))).toBe(false); // data: 图表被忽略
  });

  it("空正文 + 无封面 → 空", () => {
    expect(extractImageUrls(null)).toEqual([]);
    expect(extractImageUrls("", null)).toEqual([]);
  });

  it("受 MAX_IMAGES 限制截断", () => {
    h.env.IMAGE_MODERATION_MAX_IMAGES = 2;
    const html = `<img src="https://c/1.jpg"><img src="https://c/2.jpg"><img src="https://c/3.jpg">`;
    expect(extractImageUrls(html)).toHaveLength(2);
    h.env.IMAGE_MODERATION_MAX_IMAGES = 20;
  });
});
