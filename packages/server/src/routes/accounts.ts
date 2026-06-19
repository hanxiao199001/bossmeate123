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
import { platformAccounts, contentPublishLog, agentDevices } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { publishToAccounts, verifyAccountCredentials, getSupportedPlatforms } from "../services/publisher/index.js";
import { encryptCredentials, decryptCredentials } from "../utils/crypto.js";
import { loadDecryptedAccount } from "../services/publisher/credentials-loader.js";
import { startQrLogin, getQrLoginStatus, BROWSER_LOGIN_PLATFORMS, submitSmsCode, resendSmsCode, remoteClick } from "../services/publisher/browser-session.js";
import { buildAuthorizeUrl, resolveDouyinAppConfig, signOauthState } from "../services/publisher/douyin-open-api.js";
import { runLoginKeepalive, getLastKeepaliveSummary, isKeepaliveRunning } from "../services/publisher/login-keepalive.js";
import { env } from "../config/env.js";

const createAccountSchema = z.object({
  platform: z.enum(["wechat", "baijiahao", "toutiao", "zhihu", "xiaohongshu", "douyin", "wechat_video"]),
  accountName: z.string().min(1),
  credentials: z.record(z.any()).optional().default({}),
  groupName: z.string().optional(),
  capability: z.enum(["full", "draft_only"]).optional(),
  journalScope: z.enum(["domestic", "international", "both"]).optional(), // PR-K 期刊定位
  discipline: z.enum(["medicine", "psychology", "engineering", "economics", "biology", "education", "law", "agriculture", "computer", "environment", "chemistry", "physics"]).nullable().optional(), // PR-W5 领域定位(单选, 兼容)
  disciplines: z.array(z.enum(["medicine", "psychology", "engineering", "economics", "biology", "education", "law", "agriculture", "computer", "environment", "chemistry", "physics"])).max(12).optional(), // PR-W5b 多选
});

const updateAccountSchema = z.object({
  accountName: z.string().optional(),
  credentials: z.record(z.any()).optional(),
  groupName: z.string().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  capability: z.enum(["full", "draft_only"]).optional(),
  templateId: z.string().uuid().nullable().optional(), // PR Q.2: 绑定模板（NULL=用全局默认）
  journalScope: z.enum(["domestic", "international", "both"]).optional(), // PR-K 期刊定位
  discipline: z.enum(["medicine", "psychology", "engineering", "economics", "biology", "education", "law", "agriculture", "computer", "environment", "chemistry", "physics"]).nullable().optional(), // PR-W5 领域定位(单选, 兼容)
  disciplines: z.array(z.enum(["medicine", "psychology", "engineering", "economics", "biology", "education", "law", "agriculture", "computer", "environment", "chemistry", "physics"])).max(12).optional(), // PR-W5b 多选
  persona: z.string().max(2000).nullable().optional(), // PR-X1 人设画像
  remark: z.string().max(100).nullable().optional(), // 6-19 手动备注名
});

const publishSchema = z.object({
  contentId: z.string().uuid(),
  accountIds: z.array(z.string().uuid()).min(1),
  options: z.object({
    author: z.string().optional(),
    digest: z.string().optional(),
    coverImageUrl: z.string().optional(),
  }).optional(),
  // 5-20 P2 风控: 用户二次确认强制放行 (跳过 audit gate)
  forceOverride: z.boolean().optional(),
  overrideReason: z.string().max(200).optional(),
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

      // 6-19 惰性自愈: 早期(回填代码部署前)登录的号 — accountId 已回填但占位名"待登录·X"没改,
      //   /profile 只在登录时跑一次不会重来。读列表时补正: 有 accountId 就用 真实昵称 或 "平台·账号号",
      //   改响应 + 异步存库, 客户无需重新扫码。
      for (const a of accounts) {
        if (typeof a.accountName === "string" && a.accountName.startsWith("待登录") && a.accountId) {
          const nick = (a.metadata as Record<string, unknown> | null)?.realNickname;
          const platLabel = a.platform === "douyin" ? "抖音" : a.platform === "wechat_video" ? "视频号" : a.platform;
          const realName = (typeof nick === "string" && nick) ? nick : `${platLabel}·${a.accountId}`;
          a.accountName = String(realName).slice(0, 100);
          db.update(platformAccounts).set({ accountName: a.accountName }).where(eq(platformAccounts.id, a.id)).catch(() => { /* 自愈失败不影响列表 */ });
        }
      }

      // 6-17 #4: 抖音/视频号发布走本地 Agent → "能不能发"取决于绑定设备是否在线, 而非服务器扫码态。
      const devs = await db
        .select({ id: agentDevices.id, status: agentDevices.status, lastSeenAt: agentDevices.lastSeenAt })
        .from(agentDevices)
        .where(eq(agentDevices.tenantId, request.tenantId));
      const nowMs = Date.now();
      const onlineDevs = new Set(
        devs.filter((d) => d.status === "active" && d.lastSeenAt && nowMs - d.lastSeenAt.getTime() < 90_000).map((d) => d.id),
      );
      const agentOnlineOf = (a: typeof accounts[number]) => (a.agentDeviceId ? onlineDevs.has(a.agentDeviceId) : false);

      // 解密并脱敏凭证信息
      const masked = accounts.map(a => {
        try {
          // 尝试解密凭证
          const decryptedCreds = decryptCredentials(a.credentials as unknown as string);
          const parsedCreds = JSON.parse(decryptedCreds);
          return {
            ...a,
            loginState: undefined, // PR-S1: 加密登录态不出接口
            credentials: maskCredentials(parsedCreds),
            agentOnline: agentOnlineOf(a),
          };
        } catch (err) {
          // 如果解密失败，使用原始凭证直接脱敏（向后兼容）
          logger.warn({ accountId: a.id, error: err instanceof Error ? err.message : "未知错误" }, "凭证解密失败，使用原始凭证");
          return {
            ...a,
            loginState: undefined,
            credentials: maskCredentials(a.credentials as Record<string, any>),
            agentOnline: agentOnlineOf(a),
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
      // PR-Z4 套餐闸: 账号数上限
      {
        const { checkBilling, logBillingDenied } = await import("../services/billing/plan.js");
        const bill = await checkBilling(request.tenantId, "add_account");
        if (!bill.allowed) {
          logBillingDenied(request.tenantId, "add_account", bill.reason);
          return reply.code(403).send({ code: "BILLING_LIMIT", message: bill.reason });
        }
      }
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
          discipline: body.discipline ?? null,
          disciplines: body.disciplines ?? (body.discipline ? [body.discipline] : []),
          journalScope: body.journalScope ?? "both",
          isVerified: false,
          // 默认 draft_only（保守兜底），仅当前端显式选择"已认证"时才存 full
          capability: body.capability ?? "draft_only",
        })
        .returning();

      // 半自动平台(抖音/视频号/小红书): 第三方无稳定发布 API, 内容人工发布。账号只是矩阵"名字标签",
      // 无凭证时跳过 API 验证、直接视为就绪(有凭证仍正常验证)。
      const SEMI_AUTO_PLATFORMS = new Set(["douyin", "wechat_video", "xiaohongshu"]);
      // PR-P2: "有凭证"按值判断 — 前端可能提交 {clientKey:"",...} 空占位, 只看 key 数会误判去走 API 验证
      const hasCreds = body.credentials && Object.values(body.credentials).some(
        (v) => (typeof v === "string" ? v.trim().length > 0 : v != null)
      );
      let verifyResult: { valid: boolean; error?: string } = { valid: false, error: "解密失败" };
      if (SEMI_AUTO_PLATFORMS.has(body.platform) && !hasCreds) {
        verifyResult = { valid: true }; // 半自动无凭证 → 就绪(人工发布)
      } else {
        try {
          const loaded = await loadDecryptedAccount(account.id, request.tenantId);
          if (loaded) {
            verifyResult = await verifyAccountCredentials(loaded.platform, loaded.credentials);
          }
        } catch (err) {
          verifyResult = { valid: false, error: err instanceof Error ? err.message : "凭证解密失败" };
          logger.error({ err, accountId: account.id }, "入库后解密验证失败");
        }
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
      if (body.templateId !== undefined) updateData.templateId = body.templateId;
      if (body.journalScope) updateData.journalScope = body.journalScope;
      if (body.discipline !== undefined) updateData.discipline = body.discipline; // PR-W5
      if (body.disciplines !== undefined) updateData.disciplines = body.disciplines; // PR-W5b 多选
      if (body.persona !== undefined) updateData.persona = body.persona; // PR-X1 人设
      if (body.remark !== undefined) updateData.remark = body.remark; // 6-19 备注名

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

      // 先删依赖的发布日志(content_publish_log.account_id FK NOT NULL 无级联, 否则删账号被外键挡 500),
      // 再删账号 — 同一事务保证原子性。
      const deleted = await db.transaction(async (tx) => {
        await tx
          .delete(contentPublishLog)
          .where(and(eq(contentPublishLog.accountId, id), eq(contentPublishLog.tenantId, request.tenantId)));
        const [d] = await tx
          .delete(platformAccounts)
          .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, request.tenantId)))
          .returning();
        return d;
      });

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

      // PR-P2: 半自动平台空凭证 → 直接就绪(人工发布不需要 API), 也让存量"验证失败"账号一键修复
      const SEMI_AUTO_PLATFORMS = new Set(["douyin", "wechat_video", "xiaohongshu"]);
      const credsEmpty = !Object.values(credentialsForVerify).some(
        (v) => (typeof v === "string" ? v.trim().length > 0 : v != null)
      );
      const result = SEMI_AUTO_PLATFORMS.has(account.platform) && credsEmpty
        ? { valid: true }
        : await verifyAccountCredentials(account.platform, credentialsForVerify);

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
   * PR-S1: POST /accounts/:id/qr-login - 发起扫码登录 (抖音/视频号浏览器登录态)
   */
  app.post("/accounts/:id/qr-login", async (request, reply) => {
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
      if (!BROWSER_LOGIN_PLATFORMS[account.platform]) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: `平台 ${account.platform} 不支持扫码登录` });
      }
      const { sessionId } = await startQrLogin({ accountId: id, tenantId: request.tenantId, platform: account.platform });
      return { code: "OK", data: { sessionId } };
    } catch (err) {
      logger.error({ err }, "发起扫码登录失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "操作失败，请稍后重试" });
    }
  });

  /**
   * PR-S1: GET /accounts/qr-login/:sessionId - 轮询扫码登录状态 (waiting 时带二维码 base64)
   */
  app.get("/accounts/qr-login/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const status = getQrLoginStatus(sessionId, request.tenantId);
    if (!status) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "会话不存在或已过期" });
    }
    return { code: "OK", data: status };
  });

  /**
   * PR-S26: POST /accounts/qr-login/:sessionId/sms-code - 抖音身份验证, 提交短信验证码
   */
  app.post("/accounts/qr-login/:sessionId/sms-code", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code || !/^\d{4,8}$/.test(code.trim())) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "请输入4-8位数字验证码" });
    }
    const result = await submitSmsCode(sessionId, request.tenantId, code);
    if (!result.ok) {
      return reply.code(400).send({ code: "SMS_FAILED", message: result.message ?? "提交失败" });
    }
    return { code: "OK", data: { submitted: true } };
  });

  /**
   * PR-S27: POST /accounts/qr-login/:sessionId/resend-sms - 抖音身份验证, 重发短信验证码
   */
  app.post("/accounts/qr-login/:sessionId/resend-sms", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const result = await resendSmsCode(sessionId, request.tenantId);
    if (!result.ok) return reply.code(400).send({ code: "RESEND_FAILED", message: result.message ?? "重发失败" });
    return { code: "OK", data: { sent: true } };
  });

  /**
   * PR-S29: POST /accounts/qr-login/:sessionId/click - 远程点击 (在实时截图上按比例坐标操作页面)
   */
  app.post("/accounts/qr-login/:sessionId/click", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { x, y } = (request.body ?? {}) as { x?: number; y?: number };
    if (typeof x !== "number" || typeof y !== "number") {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "缺少坐标" });
    }
    const result = await remoteClick(sessionId, request.tenantId, x, y);
    if (!result.ok) return reply.code(400).send({ code: "CLICK_FAILED", message: result.message ?? "点击失败" });
    return { code: "OK", data: { clicked: true } };
  });

  /**
   * POST /publish - 批量发布内容到多个账号
   */
  // 6-10 双轨 A 轨: 生成抖音官方 OAuth 授权链接（scope video.create.bind, 服务端代发）。
  // 前端打开该 URL → 客户用抖音 App 扫码/确认授权 → 抖音重定向到 /douyin/oauth/callback 落 token。
  app.get("/accounts/:id/douyin-oauth-url", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await loadDecryptedAccount(id, request.tenantId!);
    if (!account) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });
    }
    if (account.platform !== "douyin") {
      return reply.code(400).send({ code: "BAD_PLATFORM", message: "仅抖音账号支持 OAuth 授权" });
    }
    const appConfig = resolveDouyinAppConfig(account.credentials);
    if (!appConfig) {
      return reply.code(400).send({
        code: "DOUYIN_APP_NOT_CONFIGURED",
        message: "未配置抖音开放平台应用凭证: 请在服务器 .env 配置 DOUYIN_CLIENT_KEY/DOUYIN_CLIENT_SECRET（或在账号凭证里填 clientKey/clientSecret）",
      });
    }
    const redirectUri = env.DOUYIN_OAUTH_REDIRECT_URL;
    if (!redirectUri) {
      return reply.code(400).send({
        code: "DOUYIN_REDIRECT_NOT_CONFIGURED",
        message: "未配置 DOUYIN_OAUTH_REDIRECT_URL（须与开放平台控制台回调域名一致, 如 https://<domain>/api/v1/douyin/oauth/callback）",
      });
    }
    const state = signOauthState({ accountId: id, tenantId: request.tenantId! });
    return { authorizeUrl: buildAuthorizeUrl(appConfig, redirectUri, state), expiresInMinutes: 30 };
  });

  // 6-11: 登录态保活 — 手动触发巡检(fire-and-forget, 串行慢任务)+查最近结果
  app.post("/accounts/keepalive", async (request, reply) => {
    if (isKeepaliveRunning()) {
      return reply.code(409).send({ code: "KEEPALIVE_RUNNING", message: "巡检正在进行中, 请稍后查看结果" });
    }
    void runLoginKeepalive(request.tenantId!).catch((err) =>
      logger.error({ err }, "手动保活巡检异常")
    );
    return { started: true, message: "巡检已启动(账号间8-20s串行, 视账号数需几分钟), 稍后刷新查看登录状态" };
  });

  app.get("/accounts/keepalive", async () => {
    return { running: isKeepaliveRunning(), lastSummary: getLastKeepaliveSummary() };
  });

  /**
   * PR-X3: 风格学习 — 喂 1-5 篇范文(自己的爆款或对标号文章), LLM 提炼风格画像存账号,
   * 之后该账号的独家生成都会模仿此风格 (经 batch worker → personaPrompt 注入)。
   */
  app.post("/accounts/:id/learn-style", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { samples?: string[] };
    const samples = (Array.isArray(body.samples) ? body.samples : [])
      .map((t) => String(t).trim())
      .filter((t) => t.length >= 100)
      .slice(0, 5);
    if (samples.length === 0) {
      return reply.code(400).send({ code: "BAD_SAMPLES", message: "至少提供 1 篇 ≥100 字的范文" });
    }
    const [acct] = await db
      .select({ id: platformAccounts.id, accountName: platformAccounts.accountName })
      .from(platformAccounts)
      .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, request.tenantId)))
      .limit(1);
    if (!acct) return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });

    try {
      const { chat } = await import("../services/ai/chat-service.js");
      const joined = samples.map((t, i) => `【范文${i + 1}】\n${t.slice(0, 4000)}`).join("\n\n");
      const res = await chat({
        tenantId: request.tenantId,
        userId: request.user.userId,
        conversationId: `style-learn-${id}`,
        message: joined,
        systemPrompt: `你是文风分析师。从用户提供的范文中提炼可复用的"风格画像", 输出 300-500 字纯文本(不要markdown标题), 必须覆盖: 1.语气与人设(怎么称呼自己和读者) 2.句式节奏(长短句/段落长度) 3.开头套路 4.高频用词与口头禅 5.数据呈现习惯 6.结尾习惯 7.三条"模仿此风格写作时的硬性要求"。只描述风格, 不复述内容。`,
      });
      const styleProfile = res.content.trim().slice(0, 2000);
      await db
        .update(platformAccounts)
        .set({ styleProfile, updatedAt: new Date() })
        .where(eq(platformAccounts.id, id));
      logger.info({ accountId: id, samples: samples.length, len: styleProfile.length }, "PR-X3 风格画像已提炼并保存");
      return { code: "OK", data: { styleProfile } };
    } catch (err) {
      logger.error({ err, accountId: id }, "PR-X3 风格学习失败");
      return reply.code(500).send({ code: "LEARN_FAILED", message: "风格提炼失败, 请稍后重试" });
    }
  });

  app.post("/publish", async (request, reply) => {
    try {
      const body = publishSchema.parse(request.body);

      const results = await publishToAccounts({
        contentId: body.contentId,
        tenantId: request.tenantId,
        accountIds: body.accountIds,
        options: body.options,
        // 5-20 P2: 风控 forceOverride 透传
        forceOverride: body.forceOverride,
        overrideReason: body.overrideReason,
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
      return reply.code(500).send({ code: "ERROR", message: "发布失败，请稍后重试" });
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
