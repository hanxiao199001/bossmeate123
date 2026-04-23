/**
 * 微信视频号发布适配器
 *
 * 通过微信公众平台 API 上传视频到视频号：
 *  - 复用公众号 appId/appSecret 获取 access_token
 *  - 视频上传：POST /cgi-bin/media/uploadvideo
 *  - 视频发布通过视频号助手 API
 *
 * 一期：完整逻辑已写好，需公众号绑定视频号后才能调通。
 */

import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";

const WX_API = "https://api.weixin.qq.com/cgi-bin";

export class WechatVideoAdapter implements PlatformAdapter {
  platform = "wechat_video";

  async verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    const { appId, appSecret } = credentials;
    if (!appId || !appSecret) {
      return { valid: false, error: "缺少 appId 或 appSecret" };
    }

    try {
      const url = `${WX_API}/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
      const resp = await fetch(url);
      const data = await resp.json() as any;
      if (data.errcode) {
        return { valid: false, error: `微信 token 获取失败: ${data.errcode} ${data.errmsg}` };
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
    const videoUrl = metadata?.videoUrl as string;

    if (!videoUrl) {
      return { success: false, error: "缺少视频 URL（metadata.videoUrl）" };
    }

    const { appId, appSecret } = credentials;
    if (!appId || !appSecret) {
      return { success: false, error: "视频号凭证未配置（需要 appId + appSecret）" };
    }

    try {
      // Step 1: 获取 access_token
      const tokenResp = await fetch(`${WX_API}/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`);
      const tokenData = await tokenResp.json() as any;
      if (tokenData.errcode) {
        return { success: false, error: `获取 token 失败: ${tokenData.errcode} ${tokenData.errmsg}` };
      }
      const token = tokenData.access_token;

      // Step 2: 下载视频
      logger.info({ videoUrl: videoUrl.slice(0, 60) }, "视频号：下载视频文件");
      const videoResp = await fetch(videoUrl);
      if (!videoResp.ok) throw new Error(`视频下载失败: ${videoResp.status}`);
      const videoBuf = Buffer.from(await videoResp.arrayBuffer());

      // Step 3: 上传视频到微信临时素材
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(videoBuf)], { type: "video/mp4" });
      formData.append("media", blob, "video.mp4");
      formData.append("description", JSON.stringify({
        title: title.slice(0, 30),
        introduction: digest || title.slice(0, 120), // 视频描述（含获客文案）
      }));

      const uploadResp = await fetch(`${WX_API}/media/uploadvideo?access_token=${token}`, {
        method: "POST",
        body: formData,
      });
      const uploadData = await uploadResp.json() as any;

      if (uploadData.errcode) {
        return { success: false, error: `视频上传失败: ${uploadData.errcode} ${uploadData.errmsg}` };
      }

      const mediaId = uploadData.media_id;
      logger.info({ mediaId }, "视频号：视频上传成功");

      // 视频号发布需要通过视频号助手后台手动操作（API 尚未完全开放）
      // 一期返回 draft_only 模式，引导用户到视频号助手发布
      return {
        success: true,
        mode: "draft_only",
        mediaId,
        draftUrl: "https://channels.weixin.qq.com/platform",
        message: "视频已上传到微信素材库，请到视频号助手后台手动发布",
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "视频号发布异常" };
    }
  }
}
