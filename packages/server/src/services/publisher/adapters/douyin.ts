/**
 * 抖音发布适配器 — 官方开放平台 API（6-10 双轨 A 轨）
 *
 * 调用链（scope video.create.bind「代替用户发布内容到抖音」）:
 *   1. ensureFreshAccessToken — access_token 15 天, refresh_token 30 天自动续期落库
 *   2. POST /api/douyin/v1/video/upload_video/  上传 mp4 拿加密 video_id（>50MB 自动分片）
 *   3. POST /api/douyin/v1/video/create_video/  创建视频（private_status=1 默认自见=草稿模式）
 *
 * 不经过浏览器登录 → 机房 IP / 新设备验证 / 短信风控问题不存在。
 *
 * 账号状态三种:
 *   - OAuth 已授权（credentials 有 refreshToken+openId）→ 本适配器全自动发布
 *   - 未授权 → publish 返回明确指引（先走 /accounts/:id/douyin-oauth-url 授权）
 *   - 能力未批（28001018）→ 错误信息提示去能力实验室申请；期间走半自动发布助手
 */
import { readFile } from "node:fs/promises";
import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";
import { env } from "../../../config/env.js";
import {
  createVideo,
  refreshDouyinCredentials,
  resolveDouyinAppConfig,
  uploadVideo,
} from "../douyin-open-api.js";
import { ensureFreshAccessToken } from "../credentials-loader.js";

const DOUYIN_API = "https://open.douyin.com";

/** 是否已完成 OAuth 授权（可走官方 API 全自动） */
export function isDouyinOauthReady(credentials: Record<string, any>): boolean {
  return Boolean(credentials?.refreshToken && credentials?.openId && resolveDouyinAppConfig(credentials));
}

/** 读取视频内容: 本地路径直接读盘, http(s) 走下载 */
async function loadVideoBuffer(videoUrl: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(videoUrl)) {
    const resp = await fetch(videoUrl);
    if (!resp.ok) throw new Error(`视频下载失败: HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  // 本地路径（视频合成产物在本机 UPLOAD_DIR 下, 直接读盘避免绕一圈 HTTP）
  return readFile(videoUrl.replace(/^file:\/\//, ""));
}

export class DouyinAdapter implements PlatformAdapter {
  platform = "douyin";

  async verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    if (!isDouyinOauthReady(credentials)) {
      return { valid: false, error: "未完成抖音 OAuth 授权（账号管理 → 抖音账号 → 发起官方授权）" };
    }
    try {
      const resp = await fetch(
        `${DOUYIN_API}/oauth/userinfo/?open_id=${encodeURIComponent(credentials.openId)}&access_token=${encodeURIComponent(credentials.accessToken ?? "")}`
      );
      const data = (await resp.json()) as any;
      if (data.data?.error_code !== undefined && data.data?.error_code !== 0) {
        // access_token 过期不算授权失效 — refresh_token 还能续。只有 refresh 也过期才需重新授权。
        const refreshExp = credentials.refreshTokenExpiresAt ? new Date(credentials.refreshTokenExpiresAt).getTime() : NaN;
        if (Number.isFinite(refreshExp) && refreshExp > Date.now()) {
          return { valid: true };
        }
        return { valid: false, error: `抖音 token 无效: ${data.data?.description || data.message}` };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : "网络错误" };
    }
  }

  async publish(params: {
    credentials: Record<string, any>;
    title: string;
    content: string;
    author?: string;
    digest?: string;
    coverImageUrl?: string;
    metadata?: Record<string, any>;
    capability?: "full" | "draft_only";
  }): Promise<{
    success: boolean;
    mode?: "full" | "draft_only";
    publishId?: string;
    mediaId?: string;
    url?: string;
    draftUrl?: string;
    message?: string;
    error?: string;
  }> {
    const { credentials, title, digest, metadata } = params;
    const videoUrl = metadata?.videoUrl as string | undefined;
    if (!videoUrl) {
      return { success: false, error: "缺少视频 URL（metadata.videoUrl）" };
    }

    if (!isDouyinOauthReady(credentials)) {
      return {
        success: false,
        error: "抖音账号未完成官方 OAuth 授权 — 请在账号管理对该账号发起授权（一次授权后 token 自动续期）。授权前可继续用视频详情页的发布助手半自动发布。",
      };
    }

    // token 刷新需要 accountId+tenantId 落库 — publisher/index.ts 经 metadata 透传
    const accountId = metadata?.accountId as string | undefined;
    const tenantId = metadata?.tenantId as string | undefined;

    try {
      // Step 1: 取有效 access_token（不足 5 分钟自动用 refresh_token 续期并落库）
      let accessToken: string;
      if (accountId && tenantId) {
        accessToken = await ensureFreshAccessToken({
          accountId,
          tenantId,
          credentials,
          refresh: () => refreshDouyinCredentials(credentials),
        });
      } else {
        // 兜底: 没有落库上下文也能发（拿内存里的 token, 过期就刷一个不落库的）
        accessToken = credentials.accessToken as string;
        const exp = credentials.tokenExpiresAt ? new Date(credentials.tokenExpiresAt).getTime() : 0;
        if (!accessToken || exp - Date.now() < 5 * 60 * 1000) {
          const fresh = await refreshDouyinCredentials(credentials);
          accessToken = fresh.accessToken;
        }
      }
      const openId = credentials.openId as string;

      // Step 2: 上传视频（>50MB 自动分片）
      logger.info({ videoUrl: videoUrl.slice(0, 80) }, "抖音官方API: 读取并上传视频");
      const videoBuf = await loadVideoBuffer(videoUrl);
      const videoId = await uploadVideo(accessToken, openId, videoBuf);

      // Step 3: 创建视频。默认 private_status=1（自见）= 草稿模式:
      //   视频过抖音审核后仅作者可见, 老板在抖音 App > 我 > 作品 检查后手动改"公开"。
      const privateStatus = Number(
        metadata?.douyinPrivateStatus ?? credentials.privateStatus ?? env.DOUYIN_PRIVATE_STATUS
      );
      const text = (digest || title || "").trim();
      const itemId = await createVideo(accessToken, openId, {
        videoId,
        text,
        privateStatus,
        coverTsp: metadata?.coverTsp as number | undefined,
      });

      logger.info({ itemId, privateStatus }, "抖音官方API发布成功");
      const isDraftLike = privateStatus === 1;
      return {
        success: true,
        mode: isDraftLike ? "draft_only" : "full",
        publishId: itemId,
        message: isDraftLike
          ? "视频已发布为「自见」状态（草稿模式）— 在抖音 App「我 > 作品」检查后改为公开即可"
          : "视频已发布到抖音（公开, 平台审核期间仅自己可见）",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "抖音发布异常";
      logger.error({ err }, "抖音官方API发布失败");
      return { success: false, error: msg };
    }
  }
}
