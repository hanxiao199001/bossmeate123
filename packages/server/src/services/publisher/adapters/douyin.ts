/**
 * 抖音发布适配器
 *
 * 抖音开放平台 API：
 *  - OAuth2 授权获取 access_token
 *  - POST /video/create_video/ 初始化上传
 *  - POST /video/upload_video/ 分片上传视频
 *  - POST /video/publish_video/ 发布视频
 *
 * 一期：完整逻辑已写好，真实调用需要 clientKey + accessToken。
 * 未配置时 verifyCredentials 返回 valid=false + 提示。
 */

import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";

const DOUYIN_API = "https://open.douyin.com";

export class DouyinAdapter implements PlatformAdapter {
  platform = "douyin";

  async verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    const { clientKey, accessToken } = credentials;
    if (!clientKey || !accessToken) {
      return { valid: false, error: "缺少 clientKey 或 accessToken" };
    }

    try {
      // 验证 access_token 是否有效
      const resp = await fetch(`${DOUYIN_API}/oauth/userinfo/?open_id=me&access_token=${accessToken}`);
      const data = await resp.json() as any;
      if (data.data?.error_code !== 0 && data.data?.error_code !== undefined) {
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
    const videoUrl = metadata?.videoUrl as string;

    if (!videoUrl) {
      return { success: false, error: "缺少视频 URL（metadata.videoUrl）" };
    }

    const { clientKey, accessToken, openId } = credentials;
    if (!accessToken) {
      return { success: false, error: "抖音 access_token 未配置" };
    }

    try {
      // Step 1: 下载视频到 buffer
      logger.info({ videoUrl: videoUrl.slice(0, 60) }, "抖音：下载视频文件");
      const videoResp = await fetch(videoUrl);
      if (!videoResp.ok) throw new Error(`视频下载失败: ${videoResp.status}`);
      const videoBuf = Buffer.from(await videoResp.arrayBuffer());

      // Step 2: 初始化上传
      const createResp = await fetch(`${DOUYIN_API}/video/create_video/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "access-token": accessToken,
        },
        body: JSON.stringify({ open_id: openId || "me" }),
      });
      const createData = await createResp.json() as any;
      if (createData.data?.error_code) {
        return { success: false, error: `抖音初始化上传失败: ${createData.data.description}` };
      }
      const uploadId = createData.data?.upload_id;

      // Step 3: 上传视频
      const uploadResp = await fetch(`${DOUYIN_API}/video/upload_video/`, {
        method: "POST",
        headers: {
          "access-token": accessToken,
          "Content-Type": "video/mp4",
          "X-Upload-Id": uploadId,
        },
        body: videoBuf,
      });
      const uploadData = await uploadResp.json() as any;
      if (uploadData.data?.error_code) {
        return { success: false, error: `抖音视频上传失败: ${uploadData.data.description}` };
      }
      const videoId = uploadData.data?.video_id;

      // Step 4: 发布视频
      const publishResp = await fetch(`${DOUYIN_API}/video/publish_video/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "access-token": accessToken,
        },
        body: JSON.stringify({
          open_id: openId || "me",
          video_id: videoId,
          text: digest || title, // 视频描述（含获客文案）
        }),
      });
      const publishData = await publishResp.json() as any;
      if (publishData.data?.error_code) {
        return { success: false, error: `抖音发布失败: ${publishData.data.description}` };
      }

      const itemId = publishData.data?.item_id;
      logger.info({ itemId, videoId }, "抖音视频发布成功");

      return {
        success: true,
        publishId: itemId,
        message: "视频已发布到抖音",
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "抖音发布异常" };
    }
  }
}
