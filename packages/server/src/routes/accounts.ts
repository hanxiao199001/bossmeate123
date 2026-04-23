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
import { encryptCredentials, decryptCredentials } from "../utils/crypto.js";
import { loadDecryptedAccount } from "../services/publisher/credentials-loader.js";

const createAccountSchema = z.object({
  platform: z.enum(["wechat", "baijiahao", "toutiao", "zhihu", "xiaohongshu", "douyin", "wechat_video"]),
  accountName: z.string().min(1),
  credentials: z.record(z.any()),
  groupName: z.string().optional(),
  capability: z.enum(["full", "draft_only"]).optional(),
});

const updateAccountSchema = z.object({
  accountName: z.string().optional(),
  credentials: z.record(z.any()).optional(),
  groupName: z.string().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  capability: z.enum(["full", "draft_only"]).optional(),
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
  app.get("/accounts", async (request, reply) => {
    try {
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

      // 解密并脱敏凭证信息
      const masked = accounts.map(a => {
        try {
          // 尝试解密凭证
          const decryptedCreds = decryptCredentials(a.credentials as unknown as string);
          const parsedCreds = JSON.parse(decryptedCreds);
          return {
            ...a,
            credentials: maskCredentials(parsedCreds),
          };
        } catch (err) {
          // 如果解密失败，使用原始凭证直接脱敏（向后兼容）
          logger.warn({ accountId: a.id, error: err instanceof Error ? err.message : "未知错误" }, "凭证解密失败，使用原始凭证");
          return {
            ...a,
            credentials: maskCredentials(a.credentials as Record<string, any>),
          };
        }
      });

      return { code: "OK", data: masked };
    } catch (err) {
      logger.error({ err }, "获取平台账号列表失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /accounts/platforms - 获取支持的平台列表
   */
  app.get("/accounts/platforms", async (request, reply) => {
    try {
      const platforms = [
        { id: "wechat", name: "微信公众号", icon: "💬", credentialFields: ["appId", "appSecret"], description: "需要AppID和AppSecret" },
        { id: "baijiahao", name: "百家号", icon: "📰", credentialFields: ["accessToken"], description: "需要百家号开放平台AccessToken" },
        { id: "toutiao", name: "头条号", icon: "📱", credentialFields: ["accessToken"], description: "需要头条号开放平台AccessToken" },
        { id: "zhihu", name: "知乎", icon: "🔍", credentialFields: ["cookie", "columnId"], description: "需要登录Cookie和专栏ID（可选）" },
        { id: "xiaohongshu", name: "小红书", icon: "📕", credentialFields: ["cookie"], description: "需要登录Cookie" },
        { id: "douyin", name: "抖音", icon: "🎵", credentialFields: ["clientKey", "clientSecret", "accessToken"], description: "需要抖音开放平台OAuth授权" },
        { id: "wechat_video", name: "视频号", icon: "📹", credentialFields: ["appId", "appSecret"], description: "需要公众号绑定视频号" },
      ];
      return { code: "OK", data: platforms };
    } catch (err) {
      logger.error({ err }, "获取平台列表失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /accounts - 添加平台账号
   */
  app.post("/accounts", async (request, reply) => {
    try {
      const body = createAccountSchema.parse(request.body);

      // 1. 加密凭证后入库，先标 is_verified=false；verify 放到入库后重新做，
      //    确保验证的是"加密-解密-调用"完整链路，而不是一份刚从前端来的明文。
      const encryptedCreds = encryptCredentials(JSON.stringify(body.credentials));

      const [account] = await db
        .insert(platformAccounts)
        .values({
          tenantId: request.tenantId,
          platform: body.platform,
          accountName: body.accountName,
          credentials: encryptedCreds as any,
          groupName: body.groupName,
          isVerified: false,
          // 默认 draft_only（保守兜底），仅当前端显式选择"已认证"时才存 full
          capability: body.capability ?? "draft_only",
        })
        .returning();

      // 2. 从 DB 重新读并解密，跑真实 verify
      let verifyResult: { valid: boolean; error?: string } = { valid: false, error: "解密失败" };
      try {
        const loaded = await loadDecryptedAccount(account.id, request.tenantId);
        if (loaded) {
          verifyResult = await verifyAccountCredentials(loaded.platform, loaded.credentials);
        }
      } catch (err) {
        verifyResult = { valid: false, error: err instanceof Error ? err.message : "凭证解密失败" };
        logger.error({ err, accountId: account.id }, "入库后解密验证失败");
      }

      // 3. 回填 is_verified
      if (verifyResult.valid !== account.isVerified) {
        await db
          .update(platformAccounts)
          .set({ isVerified: verifyResult.valid, updatedAt: new Date() })
          .where(eq(platformAccounts.id, account.id));
        account.isVerified = verifyResult.valid;
      }

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
    } catch (err) {
      logger.error({ err }, "添加平台账号失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * PATCH /accounts/:id - 更新账号
   */
  app.patch("/accounts/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateAccountSchema.parse(request.body);

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (body.accountName) updateData.accountName = body.accountName;

      // 如果更新凭证，进行加密存储
      if (body.credentials) {
        updateData.credentials = encryptCredentials(JSON.stringify(body.credentials));
      }

      if (body.groupName !== undefined) updateData.groupName = body.groupName;
      if (body.status) updateData.status = body.status;
      if (body.capability) updateData.capability = body.capability;

      // 如果更新了凭证，先标 false；下面入库后再用"加密-解密"链路重验
      if (body.credentials) {
        updateData.isVerified = false;
      }

      const [updated] = await db
        .update(platformAccounts)
        .set(updateData)
        .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, request.tenantId)))
        .returning();

      if (!updated) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });
      }

      // 凭证有变更：入库后重新加载解密 → verify → 回填 is_verified
      if (body.credentials) {
        try {
          const loaded = await loadDecryptedAccount(id, request.tenantId);
          if (loaded) {
            const verifyResult = await verifyAccountCredentials(loaded.platform, loaded.credentials);
            if (verifyResult.valid !== updated.isVerified) {
              await db
                .update(platformAccounts)
                .set({ isVerified: verifyResult.valid, updatedAt: new Date() })
                .where(eq(platformAccounts.id, id));
              updated.isVerified = verifyResult.valid;
            }
          }
        } catch (err) {
          logger.error({ err, accountId: id }, "入库后解密验证失败");
        }
      }

      // 尝试解密凭证用于返回脱敏版本
      let credentialsToMask = updated.credentials as Record<string, any>;
      if (body.credentials) {
        credentialsToMask = body.credentials; // 新上传的凭证已知
      } else {
        try {
          const decrypted = decryptCredentials(updated.credentials as unknown as string);
          credentialsToMask = JSON.parse(decrypted);
        } catch (err) {
          logger.warn({ accountId: id }, "解密凭证失败，使用空对象");
          credentialsToMask = {};
        }
      }

      return {
        code: "OK",
        data: { ...updated, credentials: maskCredentials(credentialsToMask) },
      };
    } catch (err) {
      logger.error({ err }, "更新账号失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * DELETE /accounts/:id - 删除账号
   */
  app.delete("/accounts/:id", async (request, reply) => {
    try {
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
    } catch (err) {
      logger.error({ err }, "删除账号失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /accounts/:id/verify - 验证账号凭证
   */
  app.post("/accounts/:id/verify", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const [account] = await db
        .select()
        .from(platformAccounts)
        .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, request.tenantId)))
        .limit(1);

      if (!account) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });
      }

      // 解密凭证用于验证；解密失败就明确报错，不再兜底把密文当对象传下去
      let credentialsForVerify: Record<string, any>;
      try {
        const decrypted = decryptCredentials(account.credentials as unknown as string);
        credentialsForVerify = JSON.parse(decrypted);
      } catch (err) {
        logger.error({ err, accountId: id }, "凭证解密失败");
        return reply.code(500).send({
          code: "CRED_DECRYPT_FAILED",
          message: "凭证解密失败，请删除账号重新绑定",
        });
      }

      const result = await verifyAccountCredentials(account.platform, credentialsForVerify);

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
    } catch (err) {
      logger.error({ err }, "验证账号失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /publish - 批量发布内容到多个账号
   */
  app.post("/publish", async (request) => {
    try {
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
    } catch (err) {
      logger.error({ err }, "批量发布失败");
      return { code: "ERROR", message: "发布失败，请稍后重试" };
    }
  });
}

/**
 * 凭证脱敏
 * 对于长字符串（>8 chars），显示前4个字符 + **** + 后4个字符
 * 对于短字符串或其他类型，显示为 ****
 */
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
