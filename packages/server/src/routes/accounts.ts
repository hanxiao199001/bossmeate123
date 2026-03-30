/**
 * 平台账号管理 API
 *
 * GET    /accounts          获取所有平台账号
 * POST   /accounts          添加平台账号
 * PATCH  /accounts/:id      更新账号信息
 * DELETE /accounts/:id      删除账号
 * POST   /accounts/:id/verify  验证账号凭证
 * POST   /publish           批量发布内容
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../models/db.js";
import { platformAccounts } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { publishToAccounts, verifyAccountCredentials, getSupportedPlatforms } from "../services/publisher/index.js";

const createAccountSchema = z.object({
  platform: z.enum(["wechat", "baijiahao", "toutiao", "zhihu", "xiaohongshu"]),
  accountName: z.string().min(1),
  credentials: z.record(z.any()),
  groupName: z.string().optional(),
});

const updateAccountSchema = z.object({
  accountName: z.string().optional(),
  credentials: z.record(z.any()).optional(),
  groupName: z.string().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

const publishSchema = z.object({
  contentId: z.string().uuid(),
  accountIds: z.array(z.string().uuid()).min(1),
  options: z.object({
    author: z.string().optional(),
    digest: z.string().optional(),
    coverImageUrl: z.string().optional(),
  }).optional(),
});

export async function accountRoutes(app: FastifyInstance) {
  /**
   * GET /accounts - 获取所有平台账号
   */
  app.get("/accounts", async (request) => {
    const query = request.query as { platform?: string; group?: string };

    let conditions = [eq(platformAccounts.tenantId, request.tenantId)];

    if (query.platform) {
      conditions.push(eq(platformAccounts.platform, query.platform));
    }
    if (query.group) {
      conditions.push(eq(platformAccounts.groupName, query.group));
    }

    const accounts = await db
      .select()
      .from(platformAccounts)
      .where(and(...conditions))
      .orderBy(desc(platformAccounts.updatedAt));

    // 脱敏凭证信息
    const masked = accounts.map(a => ({
      ...a,
      credentials: maskCredentials(a.credentials as Record<string, any>),
    }));

    return { code: "OK", data: masked };
  });

  /**
   * GET /accounts/platforms - 获取支持的平台列表
   */
  app.get("/accounts/platforms", async () => {
    const platforms = [
      { id: "wechat", name: "微信公众号", icon: "💬", credentialFields: ["appId", "appSecret"], description: "需要AppID和AppSecret" },
      { id: "baijiahao", name: "百家号", icon: "📰", credentialFields: ["accessToken"], description: "需要百家号开放平台AccessToken" },
      { id: "toutiao", name: "头条号", icon: "📱", credentialFields: ["accessToken"], description: "需要头条号开放平台AccessToken" },
      { id: "zhihu", name: "知乎", icon: "🔍", credentialFields: ["cookie", "columnId"], description: "需要登录Cookie和专栏ID（可选）" },
      { id: "xiaohongshu", name: "小红书", icon: "📕", credentialFields: ["cookie"], description: "需要登录Cookie" },
    ];
    return { code: "OK", data: platforms };
  });

  /**
   * POST /accounts - 添加平台账号
   */
  app.post("/accounts", async (request, reply) => {
    const body = createAccountSchema.parse(request.body);

    // 验证凭证
    const verifyResult = await verifyAccountCredentials(body.platform, body.credentials);

    const [account] = await db
      .insert(platformAccounts)
      .values({
        tenantId: request.tenantId,
        platform: body.platform,
        accountName: body.accountName,
        credentials: body.credentials,
        groupName: body.groupName,
        isVerified: verifyResult.valid,
      })
      .returning();

    logger.info({
      accountId: account.id,
      platform: body.platform,
      verified: verifyResult.valid,
    }, "平台账号添加成功");

    return reply.code(201).send({
      code: "OK",
      data: {
        ...account,
        credentials: maskCredentials(body.credentials),
        verifyError: verifyResult.error,
      },
      message: verifyResult.valid
        ? `${body.accountName} 添加成功，凭证验证通过`
        : `${body.accountName} 已添加，但凭证验证失败: ${verifyResult.error}`,
    });
  });

  /**
   * PATCH /accounts/:id - 更新账号
   */
  app.patch("/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateAccountSchema.parse(request.body);

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (body.accountName) updateData.accountName = body.accountName;
    if (body.credentials) updateData.credentials = body.credentials;
    if (body.groupName !== undefined) updateData.groupName = body.groupName;
    if (body.status) updateData.status = body.status;

    // 如果更新了凭证，重新验证
    if (body.credentials) {
      // 先获取平台类型
      const [existing] = await db.select().from(platformAccounts)
        .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, request.tenantId)))
        .limit(1);

      if (existing) {
        const verifyResult = await verifyAccountCredentials(existing.platform, body.credentials);
        updateData.isVerified = verifyResult.valid;
      }
    }

    const [updated] = await db
      .update(platformAccounts)
      .set(updateData)
      .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, request.tenantId)))
      .returning();

    if (!updated) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });
    }

    return {
      code: "OK",
      data: { ...updated, credentials: maskCredentials(updated.credentials as Record<string, any>) },
    };
  });

  /**
   * DELETE /accounts/:id - 删除账号
   */
  app.delete("/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [deleted] = await db
      .delete(platformAccounts)
      .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, request.tenantId)))
      .returning();

    if (!deleted) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });
    }

    logger.info({ accountId: id, platform: deleted.platform }, "平台账号删除成功");
    return { code: "OK", data: { id } };
  });

  /**
   * POST /accounts/:id/verify - 验证账号凭证
   */
  app.post("/accounts/:id/verify", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [account] = await db
      .select()
      .from(platformAccounts)
      .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, request.tenantId)))
      .limit(1);

    if (!account) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });
    }

    const result = await verifyAccountCredentials(
      account.platform,
      account.credentials as Record<string, any>
    );

    // 更新验证状态
    await db
      .update(platformAccounts)
      .set({
        isVerified: result.valid,
        status: result.valid ? "active" : "expired",
        updatedAt: new Date(),
      })
      .where(eq(platformAccounts.id, id));

    return { code: "OK", data: result };
  });

  /**
   * POST /publish - 批量发布内容到多个账号
   */
  app.post("/publish", async (request) => {
    const body = publishSchema.parse(request.body);

    const results = await publishToAccounts({
      contentId: body.contentId,
      tenantId: request.tenantId,
      accountIds: body.accountIds,
      options: body.options,
    });

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return {
      code: "OK",
      data: {
        results,
        summary: {
          total: results.length,
          success: successCount,
          failed: failCount,
        },
      },
      message: `发布完成：${successCount} 成功，${failCount} 失败`,
    };
  });
}

/** 凭证脱敏 */
function maskCredentials(creds: Record<string, any>): Record<string, any> {
  const masked: Record<string, any> = {};
  for (const [key, value] of Object.entries(creds)) {
    if (typeof value === "string" && value.length > 8) {
      masked[key] = `${value.slice(0, 4)}****${value.slice(-4)}`;
    } else if (typeof value === "string") {
      masked[key] = "****";
    } else {
      masked[key] = value;
    }
  }
  return masked;
}
