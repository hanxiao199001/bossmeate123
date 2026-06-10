/**
 * 抖音 OAuth 回调 — 6-10 双轨 A 轨（官方 video.create.bind 代发）
 *
 * 路由（公开，无 JWT — 抖音服务器重定向用户浏览器过来）:
 *   GET /douyin/oauth/callback?code=&state=
 *
 * 安全:
 *   - state 为 HMAC 签名串（services/publisher/douyin-open-api.ts signOauthState），
 *     带 accountId+tenantId+时间戳（30 分钟有效），伪造/过期一律拒绝
 *   - code 换 token 后 AES-GCM 加密落 platform_accounts.credentials（persistAccountCredentials）
 *
 * 发起入口: GET /accounts/:id/douyin-oauth-url（受保护路由, routes/accounts.ts）
 */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../models/db.js";
import { platformAccounts } from "../models/schema.js";
import { logger } from "../config/logger.js";
import {
  exchangeCodeForToken,
  resolveDouyinAppConfig,
  verifyOauthState,
} from "../services/publisher/douyin-open-api.js";
import { loadDecryptedAccount, persistAccountCredentials } from "../services/publisher/credentials-loader.js";

function htmlPage(title: string, body: string, ok: boolean): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#f5f6f8}
.card{background:#fff;border-radius:12px;padding:40px 48px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;max-width:420px}
.icon{font-size:48px}h1{font-size:20px;margin:16px 0 8px}p{color:#666;font-size:14px;line-height:1.6;margin:0}</style></head>
<body><div class="card"><div class="icon">${ok ? "✅" : "❌"}</div><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

export async function douyinCallbackRoutes(app: FastifyInstance) {
  app.get("/douyin/oauth/callback", async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    reply.type("text/html");

    if (q.error || !q.code) {
      logger.warn({ q }, "douyin oauth callback: 用户拒绝或抖音返回错误");
      return reply.code(200).send(htmlPage("授权未完成", q.error_description || "用户取消了授权，或抖音返回错误。可回到 BossMate 账号管理重新发起。", false));
    }
    if (!q.state) {
      return reply.code(200).send(htmlPage("授权失败", "缺少 state 参数。", false));
    }

    const parsed = verifyOauthState(q.state);
    if (!parsed) {
      logger.warn("douyin oauth callback: state 校验失败/过期");
      return reply.code(200).send(htmlPage("授权链接已失效", "授权链接超过 30 分钟或签名无效，请回到 BossMate 账号管理重新发起授权。", false));
    }

    try {
      const account = await loadDecryptedAccount(parsed.accountId, parsed.tenantId);
      if (!account || account.platform !== "douyin") {
        return reply.code(200).send(htmlPage("授权失败", "对应的抖音账号不存在，请先在账号管理里创建。", false));
      }

      const appConfig = resolveDouyinAppConfig(account.credentials);
      if (!appConfig) {
        return reply.code(200).send(htmlPage("授权失败", "服务端未配置抖音应用凭证（DOUYIN_CLIENT_KEY/SECRET）。", false));
      }

      const token = await exchangeCodeForToken(appConfig, q.code);
      await persistAccountCredentials(parsed.accountId, parsed.tenantId, {
        accessToken: token.accessToken,
        tokenExpiresAt: new Date(Date.now() + token.expiresInSec * 1000).toISOString(),
        refreshToken: token.refreshToken,
        refreshTokenExpiresAt: new Date(Date.now() + token.refreshExpiresInSec * 1000).toISOString(),
        openId: token.openId,
        authMode: "oauth", // 标记走官方 API（区别于半自动）
      });

      await db
        .update(platformAccounts)
        .set({
          accountId: token.openId,
          isVerified: true,
          status: "active",
          loginStatus: "logged_in",
          loginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(platformAccounts.id, parsed.accountId), eq(platformAccounts.tenantId, parsed.tenantId)));

      logger.info({ accountId: parsed.accountId, openId: token.openId }, "douyin oauth 授权成功");
      return reply.code(200).send(htmlPage("抖音授权成功", `账号「${account.accountName}」已绑定官方发布通道（token 30 天内自动续期）。本页可关闭，回到 BossMate 即可使用一键发布。`, true));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      logger.error({ err, accountId: parsed.accountId }, "douyin oauth 回调处理失败");
      return reply.code(200).send(htmlPage("授权失败", msg, false));
    }
  });
}
