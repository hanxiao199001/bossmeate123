/**
 * 企业微信 inbound webhook —— B.2
 *
 * 路由：
 *   GET  /work-wechat/callback   handshake：解密 echostr 后回明文
 *   POST /work-wechat/callback   外部联系人/客服消息推送
 *
 * 关键约束（同 B.1）：
 *   - 公开路径，无 JWT
 *   - fire-and-forget leadCollector，立即 200
 *   - 失败一律 200 + 空 body，绝不 4xx
 *   - msg_signature **必须 sort 4 参数**（token + timestamp + nonce + encrypt）
 */
import type { FastifyInstance } from "fastify";
import { XMLParser } from "fast-xml-parser";
import { logger } from "../config/logger.js";
import { db } from "../models/db.js";
import { workWechatConfigs, dedupMsgs } from "../models/schema.js";
import { leadCollector } from "../services/sales/lead-collector.js";
import { computeMsgSignature, decrypt } from "../services/work-wechat/crypto.js";
import { parseWorkXml, buildWorkInboundMessage } from "../services/work-wechat/inbound-parser.js";
import { decryptCredentials } from "../utils/crypto.js";

const envelopeParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

/** 取出企微回调 envelope 的 <Encrypt> 字段（外层未加密 XML，仅一个 Encrypt 节点）。 */
function extractEncrypt(rawXml: string): string {
  const parsed = envelopeParser.parse(rawXml);
  const enc = parsed?.xml?.Encrypt;
  if (!enc) throw new Error("envelope 缺 <Encrypt> 字段");
  return String(enc);
}

/** 拉 v1 单租户配置 + 解密 encodingAesKey（密文用 credentialsKey）。 */
async function loadConfig(): Promise<{ tenantId: string; corpId: string; token: string; aesKey: string } | null> {
  const [cfg] = await db.select().from(workWechatConfigs).limit(1);
  if (!cfg) return null;
  let aesKey: string;
  try { aesKey = decryptCredentials(cfg.encodingAesKeyEnc); }
  catch (err) { logger.error({ err: err instanceof Error ? err.message : err }, "encodingAesKey 解密失败"); return null; }
  return { tenantId: cfg.tenantId, corpId: cfg.corpId, token: cfg.token, aesKey };
}

async function isDuplicate(tenantId: string, msgId: string): Promise<boolean> {
  try { await db.insert(dedupMsgs).values({ tenantId, msgId }); return false; }
  catch { return true; }
}

export async function workWechatCallbackRoutes(app: FastifyInstance) {
  for (const ct of ["text/xml", "application/xml"]) {
    if (!app.hasContentTypeParser(ct)) {
      app.addContentTypeParser(ct, { parseAs: "string" }, (_req, body, done) => done(null, body));
    }
  }

  // GET /work-wechat/callback — handshake
  app.get("/work-wechat/callback", async (request, reply) => {
    const q = request.query as { msg_signature?: string; timestamp?: string; nonce?: string; echostr?: string };
    if (!q.msg_signature || !q.timestamp || !q.nonce || !q.echostr) return reply.code(200).send("");
    const cfg = await loadConfig();
    if (!cfg) return reply.code(200).send("");
    const expected = computeMsgSignature(cfg.token, q.timestamp, q.nonce, q.echostr);
    if (expected !== q.msg_signature) {
      logger.warn({ q }, "work-wechat handshake msg_signature mismatch");
      return reply.code(200).send("");
    }
    try {
      const { msg } = decrypt(q.echostr, cfg.aesKey);
      return reply.code(200).type("text/plain").send(msg);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "work-wechat handshake echostr decrypt failed");
      return reply.code(200).send("");
    }
  });

  // POST /work-wechat/callback — 客户消息
  app.post("/work-wechat/callback", async (request, reply) => {
    const q = request.query as { msg_signature?: string; timestamp?: string; nonce?: string };
    if (!q.msg_signature || !q.timestamp || !q.nonce) return reply.code(200).send("");

    const cfg = await loadConfig();
    if (!cfg) { logger.warn({}, "work-wechat 配置不存在"); return reply.code(200).send(""); }

    const raw = typeof request.body === "string" ? request.body : "";
    let encrypt: string;
    try { encrypt = extractEncrypt(raw); }
    catch (err) { logger.warn({ err: err instanceof Error ? err.message : err }, "work-wechat envelope parse failed"); return reply.code(200).send(""); }

    // 第 1 道：4 参数 sort 签名
    if (computeMsgSignature(cfg.token, q.timestamp, q.nonce, encrypt) !== q.msg_signature) {
      logger.warn({ requestId: request.id }, "work-wechat msg_signature invalid"); return reply.code(200).send("");
    }

    // 第 2 道：AES 解密
    let plain: string;
    try { ({ msg: plain } = decrypt(encrypt, cfg.aesKey)); }
    catch (err) { logger.warn({ err: err instanceof Error ? err.message : err }, "work-wechat decrypt failed"); return reply.code(200).send(""); }

    // 第 3 道：解析明文 XML
    let parsed;
    try { parsed = parseWorkXml(plain); }
    catch (err) { logger.warn({ err: err instanceof Error ? err.message : err }, "work-wechat XML parse failed"); return reply.code(200).send(""); }

    // 第 4 道：消息白名单（仅 text 入库；image/event 等 ack 200 不入库）
    if (parsed.msgType !== "text") {
      logger.info({ msgType: parsed.msgType, event: parsed.event }, "work-wechat non-text msg, ack only"); return reply.code(200).send("");
    }

    // 第 5 道：转 InboundMessage
    const inbound = await buildWorkInboundMessage(parsed);
    if (!inbound) return reply.code(200).send("");

    // 第 6 道：幂等
    const msgId = inbound.metadata?.msgId as string;
    if (await isDuplicate(inbound.tenantId, msgId)) {
      logger.info({ msgId, tenantId: inbound.tenantId }, "work-wechat duplicate"); return reply.code(200).send("");
    }

    // 第 7 道：fire-and-forget collect
    void leadCollector.collect(inbound).catch((err) => logger.error({ err: err instanceof Error ? err.message : err, msgId }, "leadCollector.collect 失败"));
    return reply.code(200).send("");
  });
}
