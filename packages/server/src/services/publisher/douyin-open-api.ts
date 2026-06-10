/**
 * 抖音开放平台官方 API — OAuth 授权 + 服务端代发视频
 *
 * Scope: video.create.bind（"代替用户发布内容到抖音"，控制台 > 能力管理 > 能力实验室申请）
 * 文档:
 *   - 上传视频: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/upload-video
 *   - 创建视频: https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create
 *   - OAuth:    https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-access-token
 *
 * 设计要点（6-10 抖音渠道双轨决策的 A 轨）:
 *   - 完全不经过浏览器登录 → 机房 IP / 新设备风控问题整体不存在
 *   - access_token 15 天 / refresh_token 30 天，ensureFreshAccessToken 骨架自动续期落库
 *   - 应用级 client_key/secret 优先读 env（一个 BossMate 应用服务所有租户），
 *     credentials.clientKey/clientSecret 可按账号覆盖（兼容客户自有应用场景）
 *   - 能力未批前调用会报 28001018（应用未获得该能力），错误信息已做人话翻译
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

const OPEN_API = "https://open.douyin.com";
export const DOUYIN_OAUTH_SCOPE = "video.create.bind";

/** 分片上传阈值/分片大小（文档: >50MB 建议分片, >300MB 必须分片, 单片建议 20MB 最小 5MB） */
const PART_UPLOAD_THRESHOLD = 50 * 1024 * 1024;
const PART_SIZE = 20 * 1024 * 1024;

// ===== 应用配置 =====

export interface DouyinAppConfig {
  clientKey: string;
  clientSecret: string;
}

/** 应用凭证解析: 账号 credentials 优先（客户自有应用），否则回落 env 全局应用。都没有返回 null。 */
export function resolveDouyinAppConfig(credentials?: Record<string, any>): DouyinAppConfig | null {
  const clientKey = ((credentials?.clientKey as string) || env.DOUYIN_CLIENT_KEY || "").trim();
  const clientSecret = ((credentials?.clientSecret as string) || env.DOUYIN_CLIENT_SECRET || "").trim();
  if (!clientKey || !clientSecret) return null;
  return { clientKey, clientSecret };
}

// ===== OAuth state 签名（防 callback 伪造，公开路由无 JWT） =====

const STATE_TTL_MS = 30 * 60 * 1000;

export function signOauthState(payload: { accountId: string; tenantId: string }): string {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", env.JWT_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOauthState(state: string): { accountId: string; tenantId: string } | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", env.JWT_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!parsed.accountId || !parsed.tenantId) return null;
    if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > STATE_TTL_MS) return null;
    return { accountId: parsed.accountId, tenantId: parsed.tenantId };
  } catch {
    return null;
  }
}

/** 生成抖音授权页 URL。用户扫码/确认后抖音带 code+state 重定向回 redirectUri。 */
export function buildAuthorizeUrl(app: DouyinAppConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_key: app.clientKey,
    response_type: "code",
    scope: DOUYIN_OAUTH_SCOPE,
    redirect_uri: redirectUri,
    state,
  });
  return `${OPEN_API}/platform/oauth/connect/?${q.toString()}`;
}

// ===== Token =====

export interface DouyinTokenSet {
  accessToken: string;
  /** access_token 剩余有效期秒（约 15 天） */
  expiresInSec: number;
  refreshToken: string;
  /** refresh_token 剩余有效期秒（约 30 天） */
  refreshExpiresInSec: number;
  openId: string;
}

interface DouyinOauthResp {
  data?: {
    error_code?: number;
    description?: string;
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_expires_in?: number;
    expires_in_refresh_token?: number; // renew_refresh_token 接口的字段名
    open_id?: string;
  };
  message?: string;
}

async function postOauth(path: string, params: Record<string, string>): Promise<DouyinOauthResp["data"]> {
  const resp = await fetch(`${OPEN_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await resp.json()) as DouyinOauthResp;
  const data = json.data;
  if (!data || (data.error_code !== undefined && data.error_code !== 0)) {
    throw new Error(`抖音 OAuth 失败(${path}): ${data?.description || json.message || "未知错误"} (error_code=${data?.error_code})`);
  }
  return data;
}

/** 授权码换 token（OAuth 回调里调用一次） */
export async function exchangeCodeForToken(app: DouyinAppConfig, code: string): Promise<DouyinTokenSet> {
  const data = await postOauth("/oauth/access_token/", {
    client_key: app.clientKey,
    client_secret: app.clientSecret,
    code,
    grant_type: "authorization_code",
  });
  return {
    accessToken: data!.access_token!,
    expiresInSec: data!.expires_in ?? 15 * 24 * 3600,
    refreshToken: data!.refresh_token!,
    refreshExpiresInSec: data!.refresh_expires_in ?? 30 * 24 * 3600,
    openId: data!.open_id!,
  };
}

/** 用 refresh_token 换新 access_token（refresh_token 本身不变） */
export async function refreshAccessToken(app: DouyinAppConfig, refreshToken: string): Promise<{ accessToken: string; expiresInSec: number }> {
  const data = await postOauth("/oauth/refresh_token/", {
    client_key: app.clientKey,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return { accessToken: data!.access_token!, expiresInSec: data!.expires_in ?? 15 * 24 * 3600 };
}

/** 续期 refresh_token（30 天有效，官方允许续约最多 5 次，之后需用户重新授权） */
export async function renewRefreshToken(app: DouyinAppConfig, refreshToken: string): Promise<{ refreshToken: string; refreshExpiresInSec: number }> {
  const data = await postOauth("/oauth/renew_refresh_token/", {
    client_key: app.clientKey,
    refresh_token: refreshToken,
  });
  return {
    refreshToken: data!.refresh_token ?? refreshToken,
    refreshExpiresInSec: data!.expires_in_refresh_token ?? data!.refresh_expires_in ?? 30 * 24 * 3600,
  };
}

/**
 * 给 ensureFreshAccessToken 用的 refresh 实现:
 *   1. refresh_token 快过期（<5 天）先 renew，新 refresh_token 一并落库
 *   2. refresh_token 换新 access_token
 * refresh_token 已彻底过期 → 抛错，提示重新授权（前端引导用户重走 OAuth）。
 */
export async function refreshDouyinCredentials(credentials: Record<string, any>): Promise<{
  accessToken: string;
  expiresInSec: number;
  extra: Record<string, any>;
}> {
  const app = resolveDouyinAppConfig(credentials);
  if (!app) throw new Error("抖音应用未配置: 缺少 DOUYIN_CLIENT_KEY/DOUYIN_CLIENT_SECRET（或账号级 clientKey/clientSecret）");

  let refreshToken = credentials.refreshToken as string | undefined;
  if (!refreshToken) throw new Error("抖音账号未授权: 缺少 refresh_token，请在账号管理重新发起 OAuth 授权");

  const extra: Record<string, any> = {};
  const refreshExpRaw = credentials.refreshTokenExpiresAt as string | undefined;
  const refreshExp = refreshExpRaw ? new Date(refreshExpRaw).getTime() : NaN;

  if (Number.isFinite(refreshExp) && refreshExp - Date.now() < 0) {
    throw new Error("抖音 refresh_token 已过期，需要用户重新 OAuth 授权");
  }

  // refresh_token 剩余 < 5 天 → 先续期
  if (Number.isFinite(refreshExp) && refreshExp - Date.now() < 5 * 24 * 3600 * 1000) {
    try {
      const renewed = await renewRefreshToken(app, refreshToken);
      refreshToken = renewed.refreshToken;
      extra.refreshToken = renewed.refreshToken;
      extra.refreshTokenExpiresAt = new Date(Date.now() + renewed.refreshExpiresInSec * 1000).toISOString();
      logger.info("douyin refresh_token renewed");
    } catch (err) {
      // renew 失败不阻断本次发布（refresh_token 还有效），只记日志
      logger.warn({ err }, "douyin renew_refresh_token failed, continue with current refresh_token");
    }
  }

  const fresh = await refreshAccessToken(app, refreshToken);
  return { accessToken: fresh.accessToken, expiresInSec: fresh.expiresInSec, extra };
}

// ===== 视频上传 / 创建 =====

interface DouyinApiResp {
  data?: Record<string, any> & { error_code?: number; description?: string };
  extra?: { logid?: string; sub_error_code?: number; sub_description?: string };
}

/** 业务错误码人话翻译（文档错误码表） */
const ERROR_HINTS: Record<number, string> = {
  2114007: "该账号今日发布数已达上限（75 条/日）",
  2114006: "视频时长超过 15 分钟",
  2190005: "整体上传文件超 300MB，必须走分片上传",
  2190007: "无效的 video_id",
  28001003: "access_token 无效，请重新授权",
  28001008: "access_token 过期，已尝试刷新仍失败则需重新授权",
  28001014: "应用未授权任何能力",
  28001018: "应用未获得「代替用户发布内容到抖音」能力 — 请到开放平台控制台 > 能力实验室申请并等待审核",
  28001019: "应用该能力已被封禁，需联系平台处理",
  28003017: "应用调用 quota 已用完",
};

function assertOk(json: DouyinApiResp, action: string): Record<string, any> {
  const data = json.data;
  const code = data?.error_code ?? 0;
  if (!data || code !== 0) {
    const hint = ERROR_HINTS[code] ? ` — ${ERROR_HINTS[code]}` : "";
    throw new Error(`抖音${action}失败: ${data?.description || "未知错误"} (error_code=${code}${hint}) logid=${json.extra?.logid ?? ""}`);
  }
  return data;
}

function videoForm(buf: Buffer, filename = "video.mp4"): FormData {
  const form = new FormData();
  form.append("video", new Blob([new Uint8Array(buf)], { type: "video/mp4" }), filename);
  return form;
}

/** 整体上传（≤50MB） */
async function uploadWhole(accessToken: string, openId: string, buf: Buffer): Promise<string> {
  const resp = await fetch(`${OPEN_API}/api/douyin/v1/video/upload_video/?open_id=${encodeURIComponent(openId)}`, {
    method: "POST",
    headers: { "access-token": accessToken },
    body: videoForm(buf),
  });
  const data = assertOk((await resp.json()) as DouyinApiResp, "上传视频");
  return data.video?.video_id as string;
}

/** 分片上传（>50MB）: init → part(N) → complete */
async function uploadParts(accessToken: string, openId: string, buf: Buffer): Promise<string> {
  const qs = `open_id=${encodeURIComponent(openId)}`;
  const initResp = await fetch(`${OPEN_API}/api/douyin/v1/video/init_video_part_upload/?${qs}`, {
    method: "POST",
    headers: { "access-token": accessToken, "Content-Type": "application/json" },
    body: "{}",
  });
  const initData = assertOk((await initResp.json()) as DouyinApiResp, "初始化分片上传");
  const uploadId = initData.upload_id as string;

  const total = Math.ceil(buf.length / PART_SIZE);
  for (let i = 0; i < total; i++) {
    const part = buf.subarray(i * PART_SIZE, Math.min((i + 1) * PART_SIZE, buf.length));
    const partResp = await fetch(
      `${OPEN_API}/api/douyin/v1/video/upload_video_part/?${qs}&upload_id=${encodeURIComponent(uploadId)}&part_number=${i + 1}`,
      { method: "POST", headers: { "access-token": accessToken }, body: videoForm(part, `part-${i + 1}.mp4`) }
    );
    assertOk((await partResp.json()) as DouyinApiResp, `上传分片 ${i + 1}/${total}`);
    logger.info({ part: i + 1, total }, "douyin part uploaded");
  }

  const doneResp = await fetch(`${OPEN_API}/api/douyin/v1/video/complete_video_part_upload/?${qs}&upload_id=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    headers: { "access-token": accessToken, "Content-Type": "application/json" },
    body: "{}",
  });
  const doneData = assertOk((await doneResp.json()) as DouyinApiResp, "完成分片上传");
  return doneData.video?.video_id as string;
}

/** 上传视频拿加密 video_id（自动选择整体/分片） */
export async function uploadVideo(accessToken: string, openId: string, buf: Buffer): Promise<string> {
  if (buf.length > 4 * 1024 * 1024 * 1024) throw new Error("视频超过 4GB，超出抖音上限");
  const videoId = buf.length > PART_UPLOAD_THRESHOLD
    ? await uploadParts(accessToken, openId, buf)
    : await uploadWhole(accessToken, openId, buf);
  if (!videoId) throw new Error("抖音上传未返回 video_id");
  return videoId;
}

export interface CreateVideoParams {
  videoId: string;
  /** 标题+话题+@，≤1000 字。话题命名避免强导流（官方审核红线） */
  text: string;
  /** 0=公开 1=自见(草稿模式,人工在App里改公开) 2=好友可见。BossMate 默认 1。 */
  privateStatus?: number;
  /** 第 N 秒截帧做封面 */
  coverTsp?: number;
}

/** 创建视频。返回 item_id（发布后会有抖音侧审核期，期间仅自己可见）。 */
export async function createVideo(accessToken: string, openId: string, p: CreateVideoParams): Promise<string> {
  const body: Record<string, any> = {
    video_id: p.videoId,
    text: p.text.slice(0, 1000),
    private_status: p.privateStatus ?? env.DOUYIN_PRIVATE_STATUS,
  };
  if (p.coverTsp !== undefined) body.cover_tsp = p.coverTsp;

  const resp = await fetch(`${OPEN_API}/api/douyin/v1/video/create_video/?open_id=${encodeURIComponent(openId)}`, {
    method: "POST",
    headers: { "access-token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = assertOk((await resp.json()) as DouyinApiResp, "创建视频");
  return data.item_id as string;
}
