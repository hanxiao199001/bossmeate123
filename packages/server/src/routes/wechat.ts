/**
 * 微信公众号 API 路由
 *
 * GET  /wechat/config          获取当前租户的公众号配置（脱敏）
 * POST /wechat/config          保存/更新公众号配置
 * POST /wechat/config/verify   验证配置是否有效
 * POST /wechat/draft           创建草稿（文章进入草稿箱）
 * POST /wechat/publish         发布草稿
 */

import type { FastifyInstance } from "fastify";
import { db } from "../models/db.js";
import { wechatConfigs, contents } from "../models/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../config/logger.js";
import {
  verifyConfig,
  addDraft,
  publishDraft,
} from "../services/wechat.js";

export async function wechatRoutes(app: FastifyInstance) {
  /**
   * GET /wechat/config - 获取公众号配置（脱敏返回）
   */
  app.get("/wechat/config", async (request, reply) => {
    const tenantId = (request as any).tenantId;

    const configs = await db
      .select()
      .from(wechatConfigs)
      .where(eq(wechatConfigs.tenantId, tenantId))
      .limit(1);

    if (configs.length === 0) {
      return reply.send({
        code: "ok",
        data: null,
        message: "未配置微信公众号",
      });
    }

    const c = configs[0];
    return reply.send({
      code: "ok",
      data: {
        appId: c.appId,
        appSecretMask: c.appSecret ? `${c.appSecret.slice(0, 4)}****${c.appSecret.slice(-4)}` : "",
        accountName: c.accountName,
        isVerified: c.isVerified,
        hasToken: !!c.accessToken,
        tokenExpiresAt: c.tokenExpiresAt,
        updatedAt: c.updatedAt,
      },
    });
  });

  /**
   * POST /wechat/config - 保存公众号配置
   */
  app.post("/wechat/config", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    const { appId, appSecret, accountName } = request.body as {
      appId: string;
      appSecret: string;
      accountName?: string;
    };

    if (!appId) {
      return reply.status(400).send({
        code: "BAD_REQUEST",
        message: "appId 不能为空",
      });
    }

    try {
      // 如果没传appSecret，从数据库取已有的
      let finalSecret = appSecret;
      if (!finalSecret) {
        const existingConfig = await db
          .select({ appSecret: wechatConfigs.appSecret })
          .from(wechatConfigs)
          .where(eq(wechatConfigs.tenantId, tenantId))
          .limit(1);
        if (existingConfig.length > 0) {
          finalSecret = existingConfig[0].appSecret;
        } else {
          return reply.status(400).send({
            code: "BAD_REQUEST",
            message: "首次配置需要填写AppSecret",
          });
        }
      }

      // 先验证配置是否有效
      logger.info("微信: 验证公众号配置...");
      const verifyResult = await verifyConfig(appId, finalSecret);

      const existing = await db
        .select()
        .from(wechatConfigs)
        .where(eq(wechatConfigs.tenantId, tenantId))
        .limit(1);

      const now = new Date();

      if (existing.length > 0) {
        // 更新
        await db
          .update(wechatConfigs)
          .set({
            appId,
            appSecret: finalSecret,
            accountName: accountName || existing[0].accountName,
            isVerified: verifyResult.valid,
            accessToken: null, // 重置token，下次使用时重新获取
            tokenExpiresAt: null,
            thumbMediaId: existing[0].appId !== appId ? null : undefined, // AppID变了则清除封面缓存
            updatedAt: now,
          })
          .where(eq(wechatConfigs.tenantId, tenantId));
      } else {
        // 新建
        await db.insert(wechatConfigs).values({
          tenantId,
          appId,
          appSecret: finalSecret,
          accountName: accountName || "",
          isVerified: verifyResult.valid,
          createdAt: now,
          updatedAt: now,
        });
      }

      return reply.send({
        code: "ok",
        data: {
          appId,
          isVerified: verifyResult.valid,
          verifyError: verifyResult.error,
        },
        message: verifyResult.valid
          ? "公众号配置保存成功，验证通过！"
          : `配置已保存，但验证失败: ${verifyResult.error}`,
      });
    } catch (err) {
      logger.error({ err }, "微信配置保存失败");
      return reply.status(500).send({
        code: "SAVE_FAILED",
        message: err instanceof Error ? err.message : "配置保存失败，请检查服务器日志",
      });
    }
  });

  /**
   * POST /wechat/config/verify - 验证配置是否有效（不保存）
   */
  app.post("/wechat/config/verify", async (request, reply) => {
    const { appId, appSecret } = request.body as { appId: string; appSecret: string };

    if (!appId || !appSecret) {
      return reply.status(400).send({
        code: "BAD_REQUEST",
        message: "appId 和 appSecret 不能为空",
      });
    }

    const result = await verifyConfig(appId, appSecret);

    return reply.send({
      code: "ok",
      data: result,
    });
  });

  /**
   * POST /wechat/draft - 创建草稿（文章进入公众号草稿箱）
   */
  app.post("/wechat/draft", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    const userId = (request as any).userId;
    const { title, content, author, digest } = request.body as {
      title: string;
      content: string;
      author?: string;
      digest?: string;
    };

    if (!title || !content) {
      return reply.status(400).send({
        code: "BAD_REQUEST",
        message: "title 和 content 不能为空",
      });
    }

    // 检查是否已配置公众号
    const configs = await db
      .select()
      .from(wechatConfigs)
      .where(eq(wechatConfigs.tenantId, tenantId))
      .limit(1);

    if (configs.length === 0) {
      return reply.status(400).send({
        code: "NOT_CONFIGURED",
        message: "请先在设置中配置微信公众号AppID和AppSecret",
      });
    }

    // 创建草稿
    const result = await addDraft(tenantId, title, content, author, digest);

    if (result.success) {
      // 保存到内容表
      try {
        await db.insert(contents).values({
          tenantId,
          userId,
          type: "article",
          title,
          body: content,
          status: "draft",
          platforms: [{ platform: "wechat", mediaId: result.mediaId, status: "draft", createdAt: new Date().toISOString() }],
          metadata: { wechatMediaId: result.mediaId },
        });
      } catch (err) {
        logger.warn({ err }, "保存内容记录失败，但草稿已创建");
      }
    }

    return reply.send({
      code: result.success ? "ok" : "FAILED",
      data: result,
      message: result.success
        ? "文章已成功添加到公众号草稿箱！请在微信公众平台确认后发布。"
        : `草稿创建失败: ${result.error}`,
    });
  });

  /**
   * POST /wechat/publish - 发布草稿（从草稿箱正式发布）
   */
  app.post("/wechat/publish", async (request, reply) => {
    const tenantId = (request as any).tenantId;
    const { mediaId } = request.body as { mediaId: string };

    if (!mediaId) {
      return reply.status(400).send({
        code: "BAD_REQUEST",
        message: "mediaId 不能为空",
      });
    }

    const result = await publishDraft(tenantId, mediaId);

    return reply.send({
      code: result.success ? "ok" : "FAILED",
      data: result,
      message: result.success
        ? "文章发布请求已提交！微信审核通过后将自动发布到公众号。"
        : `发布失败: ${result.error}`,
    });
  });
}
