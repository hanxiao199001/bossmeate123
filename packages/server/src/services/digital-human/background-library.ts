/**
 * 7-29 数字人视频背景图 — 系统图库 + 运营上传 + 三道保护。
 *
 * 【为什么这些校验不是可选的】DVH submit 即扣费 (0.165 元/秒, 90 秒 ≈ 14.85 元)。
 *   背景图错了 → 阿里云要么拉伸/裁切, 要么静默忽略回黑底, 而钱已经花掉。
 *   所以三道闸全部前置到「花钱之前」:
 *     a. 尺寸/宽高比 — 上传时就卡 (validateBackgroundGeometry)
 *     b. URL 可达性  — submit 之前 HEAD 预检 (assertBackgroundReachable), 不可达就拒绝提交,
 *                      绝不静默降级成黑底 (对齐 article-bridge.toPublicUrl 的"不提交不可达资源"原则)
 *     c. 图片内容审核 — 上传时走 image-moderation (背景图会进公开视频)
 *
 * 【桶 ACL 依赖 ⚠️】背景图走 OSS **裸公网 URL**(storage.upload 的返回值), 依赖 bucket
 *   bossmate-media 保持「公共读」。桶一旦转私有:
 *     - 阿里云拉不到图 → 大概率静默黑底 → 照样扣费、不报错
 *   b. 的可达性预检就是这个依赖的自检: 桶转私有后 HEAD 会 403, submit 直接被拒(报错可见),
 *      不会变成"视频出来了但没背景还扣了钱"。改桶 ACL 前先跑 pnpm oss:check。
 *
 * 【阿里云字段可能"接受但静默忽略"⚠️】前车之鉴: SubtitleStyle.color (PR #251 试了 6 种格式
 *   全被忽略, 最后改 ffmpeg burn-in)。backgroundImageUrl 传对了 ≠ 生效 —— 必须真跑一条视频看片验证。
 */
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { tenants } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { storage } from "../storage/index.js";
import { logger } from "../../config/logger.js";

// ===== 常量 =====

/** 显式"不用背景"的哨兵值 — 让运营能压掉 mapping/env 上配好的背景, 强制回 DVH 默认黑底。 */
export const DVH_BG_NONE = "none";

export const DVH_BG_MIME_WHITELIST = new Set(["image/jpeg", "image/png", "image/webp"]);
export const DVH_BG_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB, 与 /video/upload-images 对齐

export type BgOrientation = "portrait" | "landscape";

/**
 * 宽高比容差 = ±5% (相对容差, |r-target|/target)。
 * 为什么是 5%:
 *   - 竖版 9:16=0.5625 → 放行 0.5344~0.5906。1080×1920 ✓; 常见的 1080×1912 / 1082×1920 这种
 *     导出误差(±0.5%)全在内; 1080×1800(3:5, +6.7%) / 1200×1920(+11%) / 3:4(+33%) 全拒。
 *   - 横版 16:9=1.7778 → 放行 1.6889~1.8667。1920×1080 / 1600×900 ✓; 1920×1200(16:10, -5.0% 边界内)
 *     略放行, 1440×1080(4:3, -25%) 拒。
 *   5% 的画面代价 ≈ 长边多裁/补 5%(1920 高上约 96px), 肉眼几乎无感;
 *   再放宽到 10% 就会出现明显的人物被压扁/背景被裁掉一截, 而这钱已经花了、只能重跑。
 *   宁可上传时多拒几张让人重新裁, 也不要出片后才发现。
 */
export const DVH_BG_RATIO_TOLERANCE = 0.05;
const PORTRAIT_RATIO = 9 / 16;   // 0.5625
const LANDSCAPE_RATIO = 16 / 9;  // 1.7778

/** 短边下限 — 低于这个值背景会被 DVH 上采样成糊图(1080P 视频用 480P 底图肉眼可见)。 */
export const DVH_BG_MIN_SHORT_SIDE = 720;

// ===== a. 尺寸 / 宽高比校验 =====

export interface GeometryOk { ok: true; orientation: BgOrientation; width: number; height: number }
export interface GeometryFail { ok: false; code: string; message: string }

function fmtRatio(w: number, h: number): string {
  // 用最简整数比表达, 给人看("你传的是 4:3")
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h) || 1;
  const a = Math.round(w / g);
  const b = Math.round(h / g);
  // 约不出小整数比就退回两位小数
  if (a <= 40 && b <= 40) return `${a}:${b}`;
  return (w / h).toFixed(2);
}

/**
 * 校验背景图几何。expect 指定期望方向; 不指定则自动判定(命中哪个算哪个)。
 * ⚠️ 只在这里判, 不要在别处再放行一条旁路 —— 这是「花钱之前」唯一的尺寸闸。
 */
export function validateBackgroundGeometry(
  width: number | undefined,
  height: number | undefined,
  expect?: BgOrientation,
): GeometryOk | GeometryFail {
  if (!width || !height || width <= 0 || height <= 0) {
    return { ok: false, code: "INVALID_IMAGE", message: "读不出图片尺寸, 请换一张正常的 JPG/PNG/WebP" };
  }
  const r = width / height;
  const dP = Math.abs(r - PORTRAIT_RATIO) / PORTRAIT_RATIO;
  const dL = Math.abs(r - LANDSCAPE_RATIO) / LANDSCAPE_RATIO;

  const candidates: Array<{ o: BgOrientation; d: number }> = [
    { o: "portrait", d: dP },
    { o: "landscape", d: dL },
  ];
  const allowed = expect ? candidates.filter((c) => c.o === expect) : candidates;
  const hit = allowed.filter((c) => c.d <= DVH_BG_RATIO_TOLERANCE).sort((a, b) => a.d - b.d)[0];

  if (!hit) {
    const want = expect === "portrait" ? "9:16 竖版"
      : expect === "landscape" ? "16:9 横版"
      : "9:16 竖版(如 1080×1920) 或 16:9 横版(如 1920×1080)";
    return {
      ok: false,
      code: "BAD_ASPECT_RATIO",
      message: `背景图需要 ${want}, 你传的是 ${fmtRatio(width, height)} (${width}×${height})。请裁成对应比例再传 —— 比例不对阿里云会拉伸/裁切甚至直接忽略, 而合成费照扣。`,
    };
  }

  const shortSide = Math.min(width, height);
  if (shortSide < DVH_BG_MIN_SHORT_SIDE) {
    return {
      ok: false,
      code: "IMAGE_TOO_SMALL",
      message: `背景图太小 (${width}×${height}), 短边至少 ${DVH_BG_MIN_SHORT_SIDE}px。建议竖版 1080×1920 / 横版 1920×1080。`,
    };
  }
  return { ok: true, orientation: hit.o, width, height };
}

// ===== b. URL 可达性预检 =====

/** 可达性预检超时(单次)。HEAD 失败会再试一次 GET Range, 最坏 2×。 */
const PRECHECK_TIMEOUT_MS = Number(process.env.DVH_BG_PRECHECK_TIMEOUT_MS || 5000);

export class BackgroundUnreachableError extends Error {
  code = "DVH_BG_UNREACHABLE";
}

/**
 * submit 之前对背景 URL 做一次可达性预检。不可达 → 抛错拒绝提交(不静默降级黑底)。
 *
 * 为什么 HEAD 之后还兜一次 GET Range: 部分 CDN / OSS 自定义域会对 HEAD 返 403/405,
 *   只认 GET。只 HEAD 会把好图误判成坏图, 直接堵死生成。GET 带 Range: bytes=0-0 只拉 1 字节, 不费流量。
 *
 * 逃生开关 DVH_BG_PRECHECK=0: 万一服务器出网被限(预检永远失败)会把所有带背景的生成堵死,
 *   留个开关能立刻回到"不预检"的老行为。默认开。
 */
export async function assertBackgroundReachable(url: string): Promise<void> {
  if (process.env.DVH_BG_PRECHECK === "0") return;
  if (!/^https?:\/\//i.test(url)) {
    throw new BackgroundUnreachableError(
      `背景图 URL 必须是公网 http(s) 绝对地址, 当前为 "${url.slice(0, 120)}"。相对路径阿里云拉不到, 会静默变黑底且照样扣费。`,
    );
  }

  const problems: string[] = [];

  const check = async (init: RequestInit & { method: string }): Promise<boolean> => {
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS) });
      if (!resp.ok) {
        problems.push(`${init.method} → HTTP ${resp.status}`);
        return false;
      }
      const ct = resp.headers.get("content-type") || "";
      // content-type 缺失不拦(部分 OSS 对象没设); 明确不是图片才拦。
      if (ct && !/^image\//i.test(ct) && !/octet-stream/i.test(ct)) {
        problems.push(`${init.method} → Content-Type=${ct} (不是图片)`);
        return false;
      }
      return true;
    } catch (e) {
      problems.push(`${init.method} → ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  if (await check({ method: "HEAD" })) return;
  // HEAD 被拒不代表图不可达(CDN 常见), 再用 GET 只拉 1 字节确认
  if (await check({ method: "GET", headers: { Range: "bytes=0-0" } })) return;

  throw new BackgroundUnreachableError(
    `背景图不可达, 已拒绝提交 (未扣费): ${url}\n  ${problems.join("; ")}\n` +
    `常见原因: ① OSS 桶从「公共读」改成了私有(先跑 pnpm oss:check); ② URL 填错/图已删; ` +
    `③ 服务器出网受限。修好再生成 —— 不可达时阿里云多半静默出黑底, 钱照扣。`,
  );
}

// ===== c. 上传处理 (尺寸 + 审核 + 落 OSS) =====

export interface ProcessedBackground {
  url: string;        // OSS 裸公网 URL(桶公共读) / 本地存储的相对路径
  remotePath: string;
  width: number;
  height: number;
  orientation: BgOrientation;
  sizeBytes: number;
}

export class BackgroundUploadError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/**
 * 背景图上传统一处理: MIME → sharp 解码 → 几何校验 → 落 OSS → 内容审核。
 * 审核放在上传之后是因为阿里云 ImageModeration 要一个公网可达 URL; 审核不过会把已传的对象删掉。
 *
 * @param scope "system" = 管理员系统图库(存 SYSTEM 租户目录下, 全租户共享)
 *              "tenant" = 运营本次生成用的临时图(存自己租户目录, 不进图库)
 */
export async function processBackgroundUpload(args: {
  buffer: Buffer;
  mimetype: string;
  tenantId: string;
  scope: "system" | "tenant";
  expect?: BgOrientation;
}): Promise<ProcessedBackground> {
  const { buffer, mimetype, tenantId, scope, expect } = args;

  if (!DVH_BG_MIME_WHITELIST.has(mimetype)) {
    throw new BackgroundUploadError("INVALID_TYPE", `不支持的图片格式: ${mimetype} (只收 JPG / PNG / WebP)`);
  }
  if (buffer.length > DVH_BG_MAX_FILE_SIZE) {
    throw new BackgroundUploadError("FILE_TOO_LARGE", `图片超过 ${DVH_BG_MAX_FILE_SIZE / 1024 / 1024}MB 限制`);
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new BackgroundUploadError("INVALID_IMAGE", "无法识别的图片文件");
  }

  // a. 尺寸 / 宽高比 — 在这里卡死, 不让它流到生成环节才发现
  const geo = validateBackgroundGeometry(meta.width, meta.height, expect);
  if (!geo.ok) throw new BackgroundUploadError(geo.code, geo.message);

  const ext = mimetype === "image/png" ? "png" : mimetype === "image/webp" ? "webp" : "jpg";
  const owner = scope === "system" ? SYSTEM_RECOMMENDATION_TENANT_ID : tenantId;
  const remotePath = `${owner}/dvh-backgrounds/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const url = await storage.upload(buffer, remotePath, mimetype);

  // c. 图片内容审核 — 背景图会进公开视频, 违规内容不能过。范式同 routes/video.ts /compose。
  const { moderateImages, IMAGE_MODERATION_ENABLED } = await import("../compliance/image-moderation.js");
  if (IMAGE_MODERATION_ENABLED) {
    let blocked: string[] | null = null;
    try {
      // 审核要公网可达 URL: OSS 公共读裸 URL 直接能用; 私有桶/本地存储退签名 URL。
      const publicUrl = /^https?:\/\//i.test(url) ? url : await storage.getSignedUrl(remotePath, 900);
      if (/^https?:\/\//i.test(publicUrl)) {
        const mod = await moderateImages([publicUrl]);
        if (mod.blocked) blocked = mod.results.filter((r) => r.suggestion === "block").map((r) => r.label);
        const reviews = mod.results.filter((r) => r.suggestion === "review");
        if (reviews.length > 0) logger.warn({ tenantId, remotePath, reviews }, "dvh.bg.moderation.review_pass");
      }
    } catch (err) {
      // moderateImages 自身已按 IMAGE_MODERATION_STRICT 兜底; 这里只兜签名 URL 等前置异常, 不阻塞上传
      logger.warn({ err, tenantId, remotePath }, "dvh.bg.moderation.pre_error_skip");
    }
    if (blocked) {
      await storage.delete(remotePath).catch(() => undefined); // 违规图不留在桶里
      logger.warn({ tenantId, remotePath, blocked }, "dvh.bg.moderation.blocked");
      throw new BackgroundUploadError(
        "IMAGE_MODERATION_BLOCKED",
        `图片内容审核未通过, 已拒绝上传${blocked.length ? `: ${[...new Set(blocked)].join("、")}` : ""}`,
      );
    }
  }

  logger.info({ tenantId, scope, remotePath, ...geo }, "dvh.bg.uploaded");
  return { url, remotePath, width: geo.width, height: geo.height, orientation: geo.orientation, sizeBytes: buffer.length };
}

// ===== 系统背景图库 (SYSTEM 租户 config.automationConfig.dvhBackgrounds) =====
// 存储范式抄 dvhCatalog (template-mapping.loadDvhCatalog): 全平台共享一份, 管理员维护。

export interface DvhBackground {
  id: string;
  name: string;
  url: string;
  thumbUrl?: string;
  orientation: BgOrientation;
  width: number;
  height: number;
  /** 删除时用来清 OSS 对象; 外部导入的 URL 没有 */
  remotePath?: string;
  createdAt?: string;
}

export const DVH_BACKGROUNDS_MAX = 60;

function isValidBackground(e: unknown): e is DvhBackground {
  const x = e as Record<string, unknown>;
  return !!x && typeof x.id === "string" && !!x.id
    && typeof x.url === "string" && /^(https?:\/\/|\/)/i.test(x.url);
}

function normalize(e: DvhBackground): DvhBackground {
  const orientation: BgOrientation = e.orientation === "landscape" ? "landscape" : "portrait";
  return {
    id: String(e.id).slice(0, 40),
    name: String(e.name || "未命名背景").slice(0, 40),
    url: String(e.url).slice(0, 500),
    ...(e.thumbUrl ? { thumbUrl: String(e.thumbUrl).slice(0, 500) } : {}),
    orientation,
    width: Number(e.width) || 0,
    height: Number(e.height) || 0,
    ...(e.remotePath ? { remotePath: String(e.remotePath).slice(0, 300) } : {}),
    ...(e.createdAt ? { createdAt: String(e.createdAt).slice(0, 40) } : {}),
  };
}

/** 读系统背景图库。读不到(库表挂/没配)返空数组 —— 背景是增益, 不能反过来把生成搞崩。 */
export async function loadDvhBackgrounds(): Promise<DvhBackground[]> {
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (((t?.config as any)?.automationConfig?.dvhBackgrounds) ?? []) as unknown[];
    return raw.filter(isValidBackground).map(normalize);
  } catch {
    return [];
  }
}

// ===== 生成入口的 backgroundUrl 准入校验 =====

/**
 * 校验"生成时传来的 backgroundUrl"是否允许使用。
 *
 * 【为什么要这道】背景图会被烧进公开视频。如果生成接口收任意 URL, 就等于开了一条绕过
 *   c.内容审核 的旁路(随便贴个外站图 URL 就能进片)。所以只放行三种来源:
 *     1. DVH_BG_NONE 哨兵(显式黑底)
 *     2. 系统背景图库里的 URL(管理员上传时已过审核)
 *     3. 我们自己存储桶里的对象(只能由 /video/dvh-background 或 /admin 上传产生, 已过审核+尺寸校验)
 *   本地存储的相对路径放行到下一关, 由 assertBackgroundReachable 给出"必须公网可达"的准确报错。
 */
export async function validateGenerationBackgroundUrl(
  url: string,
): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  const v = String(url).trim();
  if (!v) return { ok: false, message: "backgroundUrl 不能为空字符串(不要背景请传 \"none\")" };
  if (v === DVH_BG_NONE) return { ok: true, value: DVH_BG_NONE };
  if (v.length > 500) return { ok: false, message: "backgroundUrl 过长(>500 字符)" };

  // 本地存储(开发/未配 OSS): 放到可达性预检那关报错, 报错文案更准确
  if (v.startsWith("/storage/")) return { ok: true, value: v };

  if (!/^https?:\/\//i.test(v)) {
    return { ok: false, message: "backgroundUrl 必须是 http(s) 公网地址, 或 \"none\"(不要背景)" };
  }

  // 2. 系统图库
  const lib = await loadDvhBackgrounds();
  if (lib.some((b) => b.url === v)) return { ok: true, value: v };

  // 3. 我们自己的存储桶
  const bucket = process.env.OSS_BUCKET;
  if (bucket) {
    try {
      const host = new URL(v).hostname;
      if (host.startsWith(`${bucket}.`) || host === bucket) return { ok: true, value: v };
    } catch { /* URL 解析失败 → 落到下面拒绝 */ }
  }

  return {
    ok: false,
    message: "背景图只能用系统图库里的, 或通过「上传本地图」传进来的 —— 外部图片 URL 未经内容审核, 不允许直接用于生成。",
  };
}

/** 整表覆盖写回(与 PATCH /admin/dvh-catalog 同范式)。 */
export async function saveDvhBackgrounds(list: DvhBackground[]): Promise<DvhBackground[]> {
  const clean = list.filter(isValidBackground).map(normalize).slice(0, DVH_BACKGROUNDS_MAX);
  const [t] = await db.select({ config: tenants.config }).from(tenants)
    .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
  const cfg = (t?.config as Record<string, unknown>) || {};
  const auto = (cfg.automationConfig as Record<string, unknown>) || {};
  cfg.automationConfig = { ...auto, dvhBackgrounds: clean };
  await db.update(tenants).set({ config: cfg }).where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID));
  logger.info({ count: clean.length }, "dvh.bg.library.saved");
  return clean;
}
