/**
 * 公众号 inbound webhook —— B.1
 *
 * 路由：
 *   GET  /wechat/callback   公众号管理后台「开发-基本配置」服务器配置验证 handshake
 *   POST /wechat/callback   公众号推送的客户消息（text 优先，其余兜底）
 *
 * 关键约束：
 *   - 公开路径，无 JWT/tenant middleware
 *   - 5s timeout：fire-and-forget leadCollector，立即 200
 *   - 签名失败 → 仍返 200 + 空 body（**绝不**返 4xx，公众号会重发 3 次后停推 5min）
 *   - 同 MsgId 二次提交 → 幂等，不重复入库
 */
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { db } from "../models/db.js";
import { dedupMsgs } from "../models/schema.js";
import { leadCollector } from "../services/sales/lead-collector.js";
import { parseWechatXml, buildInboundMessage, buildFallbackReply } from "../services/wechat/inbound-parser.js";
import { loadBossmateUrl, buildPassiveReplyContent, buildPassiveReplyXml } from "../services/wechat/passive-reply.js";

/** 计算公众号签名：sort([token, timestamp, nonce]).join('') → sha1。 */
export function computeSignature(token: string, timestamp: string, nonce: string): string {
  return createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

/** 检查 (tenantId, msgId) 是否已处理过 → 已处理返 true。INSERT 走幂等 unique conflict。 */
async function isDuplicate(tenantId: string, msgId: string): Promise<boolean> {
  try {
    await db.insert(dedupMsgs).values({ tenantId, msgId });
    return false;
  } catch {
    // 唯一键冲突 = 已处理过
    return true;
  }
}

export async function wechatCallbackRoutes(app: FastifyInstance) {
  // 公众号 POST 是 XML，注册原始 string 解析器（fastify 默认只解析 JSON）
  for (const ct of ["text/xml", "application/xml"]) {
    if (!app.hasContentTypeParser(ct)) {
      app.addContentTypeParser(ct, { parseAs: "string" }, (_req, body, done) => done(null, body));
    }
  }

  // GET /wechat/callback — handshake：公众号后台配置接口验证
  app.get("/wechat/callback", async (request, reply) => {
    const q = request.query as { signature?: string; timestamp?: string; nonce?: string; echostr?: string };
    if (!q.signature || !q.timestamp || !q.nonce || !q.echostr) {
      return reply.code(200).send("");
    }
    const expected = computeSignature(env.WECHAT_VERIFY_TOKEN, q.timestamp, q.nonce);
    if (expected !== q.signature) {
      logger.warn({ q }, "wechat callback handshake signature mismatch");
      return reply.code(200).send("");
    }
    return reply.code(200).type("text/plain").send(q.echostr);
  });

  // POST /wechat/callback — 客户消息推送
  app.post("/wechat/callback", async (request, reply) => {
    const q = request.query as { signature?: string; timestamp?: string; nonce?: string };
    // 第 1 道：签名校验
    if (!q.signature || !q.timestamp || !q.nonce) return reply.code(200).send("");
    const expected = computeSignature(env.WECHAT_VERIFY_TOKEN, q.timestamp, q.nonce);
    if (expected !== q.signature) {
      logger.warn({ q, requestId: request.id }, "wechat callback signature invalid");
      return reply.code(200).send(""); // 不返 4xx 防重发
    }

    // 第 2 道：解析 body XML（fastify 已注册 string parser）
    const raw = typeof request.body === "string" ? request.body : "";
    let parsed;
    try {
      parsed = parseWechatXml(raw);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, requestId: request.id }, "wechat XML parse failed");
      return reply.code(200).send("");
    }

    // 第 3 道：消息类型白名单。非 text → 直接回兜底，不入库
    if (parsed.msgType !== "text") {
      const fb = buildFallbackReply(parsed.msgType);
      logger.info({ msgType: parsed.msgType, msgId: parsed.msgId }, "wechat non-text msg, fallback reply");
      return reply.code(200).send(fb);
    }

    // 第 4 道：转 InboundMessage + tenant 反查
    const inbound = await buildInboundMessage(parsed);
    if (!inbound) {
      logger.warn({ toUser: parsed.toUser }, "wechat tenant 配置不存在，丢弃");
      return reply.code(200).send("");
    }

    // 第 5 道：幂等 — 同 MsgId 二次提交直接 ack
    const dup = await isDuplicate(inbound.tenantId, parsed.msgId);
    if (dup) {
      logger.info({ msgId: parsed.msgId, tenantId: inbound.tenantId }, "wechat msg duplicate, ack only");
      return reply.code(200).send("");
    }

    // 第 6 道：accountType 路由分支
    //   subscription：同步 lead upsert + return XML 兜底（订阅号客服接口不开放，outbound 仅 5s 同步 XML）
    //   service / 其他：fire-and-forget（保留 B.1 行为）
    const accountType = (inbound.metadata?.accountType as string) ?? "service";
    if (accountType === "subscription") {
      try {
        await leadCollector.collect(inbound);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : err, msgId: parsed.msgId }, "leadCollector.collect 失败（subscription path）");
      }
      const url = await loadBossmateUrl(inbound.tenantId);
      const xml = buildPassiveReplyXml({ fromUser: parsed.fromUser, toUser: parsed.toUser, content: buildPassiveReplyContent(url) });
      return reply.code(200).type("text/xml").send(xml);
    }
    void leadCollector.collect(inbound).catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err, msgId: parsed.msgId }, "leadCollector.collect 失败");
    });
    return reply.code(200).send("");
  });
}
