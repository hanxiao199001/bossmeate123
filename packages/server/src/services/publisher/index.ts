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
  publishId?: string;
  mediaId?: string;
  url?: string;
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
  }): Promise<{
    success: boolean;
    publishId?: string;
    mediaId?: string;
    url?: string;
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

  // 2. 获取目标账号
  const accounts = await db
    .select()
    .from(platformAccounts)
    .where(and(
      eq(platformAccounts.tenantId, tenantId),
    ));

  const targetAccounts = accounts.filter(a => accountIds.includes(a.id));

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

        const result = await adapter.publish({
          credentials: account.credentials as Record<string, any>,
          title: content.title!,
          content: content.body!,
          author: options?.author,
          digest: options?.digest,
          coverImageUrl: options?.coverImageUrl,
          metadata: account.metadata as Record<string, any>,
        });

        // 记录发布结果
        await db.insert(distributionRecords).values({
          tenantId,
          contentId,
          platform: account.platform,
          accountName: account.accountName,
          publishedTitle: content.title,
          status: result.success ? "published" : "failed",
          publishedAt: result.success ? new Date() : undefined,
          publishedUrl: result.url,
          metadata: {
            accountId: account.id,
            publishId: result.publishId,
            mediaId: result.mediaId,
            error: result.error,
          },
        });

        // 更新账号最后发布时间
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

  // 4. 如果至少有一个发布成功，更新内容状态
  const hasSuccess = results.some(r => r.success);
  if (hasSuccess) {
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
