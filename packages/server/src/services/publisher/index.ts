/**
 * 统一发布服务
 *
 * 架构：Publisher (统一入口) → PlatformAdapter (各平台适配器)
 * 支持：微信公众号、百家号、头条号、知乎、小红书
 */

import { db } from "../../models/db.js";
import { platformAccounts, contents, distributionRecords } from "../../models/schema.js";
import { eq, and } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { WechatAdapter } from "./adapters/wechat.js";
import { BaijiahaoAdapter } from "./adapters/baijiahao.js";
import { ToutiaoAdapter } from "./adapters/toutiao.js";
import { ZhihuAdapter } from "./adapters/zhihu.js";
import { XiaohongshuAdapter } from "./adapters/xiaohongshu.js";
import { DouyinAdapter } from "./adapters/douyin.js";
import { WechatVideoAdapter } from "./adapters/wechat-video.js";
import { hydrateAccount, decryptCredentialField } from "./credentials-loader.js";
import {
  getLeadCaptureConfig,
  articleLeadCaptureText,
  articleLeadCaptureHtml,
  videoLeadCaptureText,
  xiaohongshuLeadCaptureText,
} from "./lead-capture.js";

// ===== 类型定义 =====
export interface PublishRequest {
  contentId: string;
  tenantId: string;
  accountIds: string[]; // 要发布到的账号ID列表
  options?: {
    author?: string;
    digest?: string;
    coverImageUrl?: string;
  };
}

export interface PublishResult {
  accountId: string;
  accountName: string;
  platform: string;
  success: boolean;
  /** 发布模式: full=自动群发 / draft_only=仅建草稿需人工发送 / undefined=适配器未区分 */
  mode?: "full" | "draft_only";
  publishId?: string;
  mediaId?: string;
  url?: string;
  /** 公众号后台草稿箱入口（仅 draft_only 模式下返回） */
  draftUrl?: string;
  /** 成功/提示文案（draft_only 下会包含"请到后台手动发送"指引） */
  message?: string;
  error?: string;
}

export interface PlatformAdapter {
  platform: string;

  /** 验证账号凭证是否有效 */
  verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }>;

  /** 发布内容 */
  publish(params: {
    credentials: Record<string, any>;
    title: string;
    content: string;
    author?: string;
    digest?: string;
    coverImageUrl?: string;
    metadata?: Record<string, any>;
    /** 发布能力（仅 wechat 目前区分）。其他平台可忽略。 */
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
  }>;
}

// ===== 适配器注册 =====
const adapters: Record<string, PlatformAdapter> = {
  wechat: new WechatAdapter(),
  baijiahao: new BaijiahaoAdapter(),
  toutiao: new ToutiaoAdapter(),
  zhihu: new ZhihuAdapter(),
  xiaohongshu: new XiaohongshuAdapter(),
  douyin: new DouyinAdapter(),
  wechat_video: new WechatVideoAdapter(),
};

export function getAdapter(platform: string): PlatformAdapter | undefined {
  return adapters[platform];
}

export function getSupportedPlatforms() {
  return Object.keys(adapters);
}

// ===== 统一发布入口 =====

/**
 * 批量发布内容到多个账号
 */
export async function publishToAccounts(req: PublishRequest): Promise<PublishResult[]> {
  const { contentId, tenantId, accountIds, options } = req;

  // 1. 获取内容
  const [content] = await db
    .select()
    .from(contents)
    .where(and(eq(contents.id, contentId), eq(contents.tenantId, tenantId)))
    .limit(1);

  if (!content) {
    throw new Error("内容不存在");
  }

  if (!content.title || !content.body) {
    throw new Error("内容标题和正文不能为空");
  }

  // 自动提取正文第一张 http 图片作为封面（用于微信 thumb_media_id）
  let autoCoverUrl = options?.coverImageUrl;
  if (!autoCoverUrl && content.body) {
    const imgMatch = content.body.match(/<img[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/i);
    if (imgMatch) autoCoverUrl = imgMatch[1];
  }

  // 视频类型内容：从 body（存 video URL）或 metadata 提取 videoUrl
  const contentMeta = (content.metadata || {}) as Record<string, any>;
  const videoUrl = content.type === "video"
    ? (contentMeta.videoUrl || content.body || "")
    : undefined;

  // 2. 获取目标账号
  const accounts = await db
    .select()
    .from(platformAccounts)
    .where(and(
      eq(platformAccounts.tenantId, tenantId),
    ));

  let targetAccounts = accounts.filter(a => accountIds.includes(a.id));

  // 内容类型智能路由：图文→文字平台，视频→视频平台
  const VIDEO_PLATFORMS = new Set(["douyin", "wechat_video"]);
  const ARTICLE_PLATFORMS = new Set(["wechat", "baijiahao", "toutiao", "zhihu", "xiaohongshu"]);
  if (content.type === "video") {
    const filtered = targetAccounts.filter(a => VIDEO_PLATFORMS.has(a.platform));
    if (filtered.length > 0) targetAccounts = filtered;
    // 如果用户明确选了文字平台发视频，不拦（可能是有意的）
  } else {
    const filtered = targetAccounts.filter(a => ARTICLE_PLATFORMS.has(a.platform));
    if (filtered.length > 0) targetAccounts = filtered;
  }

  if (targetAccounts.length === 0) {
    throw new Error("未找到有效的发布账号");
  }

  // 3. 并发发布到各账号
  const results: PublishResult[] = await Promise.all(
    targetAccounts.map(async (account) => {
      const adapter = getAdapter(account.platform);
      if (!adapter) {
        return {
          accountId: account.id,
          accountName: account.accountName,
          platform: account.platform,
          success: false,
          error: `不支持的平台: ${account.platform}`,
        };
      }

      try {
        logger.info({
          platform: account.platform,
          accountName: account.accountName,
          contentId,
        }, "开始发布内容");

        const accountCapability = (account as any).capability as ("full" | "draft_only" | undefined);
        // 统一通过 credentials-loader 解密；凭证字段名/加密方案变更只改一处
        let plainCreds: Record<string, any>;
        try {
          plainCreds = decryptCredentialField(account.credentials);
        } catch (err) {
          const error = err instanceof Error ? err.message : "凭证解密失败";
          logger.error({ err, accountId: account.id, platform: account.platform }, "凭证解密失败，跳过该账号发布");
          return {
            accountId: account.id,
            accountName: account.accountName,
            platform: account.platform,
            success: false,
            error: `凭证解密失败：${error}`,
          };
        }
        // 获客组件注入：根据平台类型在内容末尾追加引导文案
        const lcConfig = getLeadCaptureConfig(contentMeta);
        let publishContent = content.body!;
        let publishDigest = options?.digest;

        if (content.type !== "video" && account.platform !== "wechat") {
          // 图文类平台（公众号已有服务卡片，不重复注入）
          if (account.platform === "xiaohongshu") {
            publishContent += xiaohongshuLeadCaptureText(lcConfig);
          } else if (publishContent.includes("<")) {
            // HTML 内容追加 HTML 获客尾部
            publishContent += articleLeadCaptureHtml(lcConfig);
          } else {
            // 纯文本/Markdown 追加文本获客尾部
            publishContent += articleLeadCaptureText(lcConfig);
          }
        }

        if (content.type === "video") {
          // 视频平台：获客文案注入到 digest（视频简介/描述）
          publishDigest = videoLeadCaptureText(lcConfig);
        }

        const result = await adapter.publish({
          credentials: plainCreds,
          title: content.title!,
          content: publishContent,
          author: options?.author,
          digest: publishDigest,
          coverImageUrl: autoCoverUrl,
          metadata: {
            ...(account.metadata as Record<string, any>),
            ...(content.metadata as Record<string, any>),
            ...(videoUrl ? { videoUrl } : {}),
          },
          capability: accountCapability,
        });

        // 记录发布结果
        // status: draft_created (仅建草稿) / published (完整群发) / failed
        const recordStatus = result.success
          ? (result.mode === "draft_only" ? "draft_created" : "published")
          : "failed";
        await db.insert(distributionRecords).values({
          tenantId,
          contentId,
          platform: account.platform,
          accountName: account.accountName,
          publishedTitle: content.title,
          status: recordStatus,
          publishedAt: result.success && result.mode !== "draft_only" ? new Date() : undefined,
          publishedUrl: result.url,
          metadata: {
            accountId: account.id,
            publishId: result.publishId,
            mediaId: result.mediaId,
            mode: result.mode,
            draftUrl: result.draftUrl,
            message: result.message,
            error: result.error,
          },
        });

        // 更新账号最后发布时间（draft_only 也算一次"成功投递"）
        if (result.success) {
          await db
            .update(platformAccounts)
            .set({ lastPublishedAt: new Date(), updatedAt: new Date() })
            .where(eq(platformAccounts.id, account.id));
        }

        logger.info({
          platform: account.platform,
          success: result.success,
          error: result.error,
        }, "发布完成");

        return {
          accountId: account.id,
          accountName: account.accountName,
          platform: account.platform,
          ...result,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : "发布异常";
        logger.error({ err, platform: account.platform }, "发布异常");

        return {
          accountId: account.id,
          accountName: account.accountName,
          platform: account.platform,
          success: false,
          error,
        };
      }
    })
  );

  // 4. 仅当至少一个账号真的"群发成功"(mode==='full') 才把 content 标 published。
  // draft_only 模式下内容只在微信草稿箱，真正发没发还没定，保留原状态。
  const hasFullPublish = results.some((r) => r.success && r.mode === "full");
  if (hasFullPublish) {
    await db
      .update(contents)
      .set({ status: "published", updatedAt: new Date() })
      .where(eq(contents.id, contentId));
  }

  return results;
}

/**
 * 验证平台账号凭证
 */
export async function verifyAccountCredentials(
  platform: string,
  credentials: Record<string, any>
): Promise<{ valid: boolean; error?: string }> {
  const adapter = getAdapter(platform);
  if (!adapter) {
    return { valid: false, error: `不支持的平台: ${platform}` };
  }
  return adapter.verifyCredentials(credentials);
}
