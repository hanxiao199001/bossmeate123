/**
 * 公众号 inbound webhook XML → InboundMessage 转换。
 *
 * 公众号回调 XML schema (text 消息)：
 *   <ToUserName>      公众号原生 ID（gh_xxxx）
 *   <FromUserName>    用户 OpenID
 *   <CreateTime>      Unix 秒
 *   <MsgType>         text | image | voice | video | shortvideo | location | link | event
 *   <Content>         text only
 *   <MsgId>           消息全局唯一 ID（用于幂等）
 *
 * v1 单租户期：tenant 反查走 SELECT * FROM wechatConfigs LIMIT 1（fallback）；
 * v2 多租户：按 ToUserName == wechatConfigs.wechatId 反查（schema 加列后）。
 */
import { XMLParser } from "fast-xml-parser";
import { db } from "../../models/db.js";
import { wechatConfigs } from "../../models/schema.js";
import type { InboundMessage } from "../sales/lead-collector.js";

export interface ParsedWechatMsg {
  msgType: string;
  msgId: string;
  fromUser: string;     // 客户 OpenID
  toUser: string;       // 公众号 gh_xxx
  createTime: number;
  content?: string;
  event?: string;       // msgType=event 时的事件名（subscribe/unsubscribe/CLICK…），小写
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // 全部按字符串拿（避免 OpenID 数字化）
  trimValues: true,
});

/** 解析公众号 inbound XML 字符串到结构体；缺字段 → 抛错（caller catch + 200 ack）。 */
export function parseWechatXml(rawXml: string): ParsedWechatMsg {
  const parsed = xmlParser.parse(rawXml);
  const xml = parsed?.xml;
  if (!xml) throw new Error("XML 缺 <xml> 根节点");
  const msgType = String(xml.MsgType ?? "").toLowerCase();
  const msgId = String(xml.MsgId ?? "");
  const fromUser = String(xml.FromUserName ?? "");
  const toUser = String(xml.ToUserName ?? "");
  const createTime = Number(xml.CreateTime ?? 0);
  const event = xml.Event ? String(xml.Event).toLowerCase() : undefined;
  // event 类消息(关注/取关/菜单点击)没有 MsgId, 不能按缺字段抛错 —— 否则 subscribe 事件在 parse 阶段就炸, 新粉白流失。
  if (!msgType || !fromUser || !toUser || (msgType !== "event" && !msgId)) {
    throw new Error(`XML 缺必需字段：MsgType=${msgType} MsgId=${msgId} From=${fromUser} To=${toUser}`);
  }
  return { msgType, msgId, fromUser, toUser, createTime, content: xml.Content ? String(xml.Content) : undefined, event };
}

/**
 * 把已解析消息转 InboundMessage（喂 leadCollector.collect）。
 * v1 单租户：直接 SELECT first wechatConfigs，把 tenantId 灌进来。多租户在 schema 加 wechatId 列后改造。
 * 返 null = 找不到 tenant 配置（公众号根本没接进来过 — caller ack 200 + 不入库）。
 */
export async function buildInboundMessage(parsed: ParsedWechatMsg): Promise<InboundMessage | null> {
  const [cfg] = await db.select().from(wechatConfigs).limit(1);
  if (!cfg) return null;
  return {
    tenantId: cfg.tenantId,
    channel: "wechat_oa",
    externalUserId: parsed.fromUser,
    content: parsed.content ?? "",
    metadata: {
      msgId: parsed.msgId,
      msgType: parsed.msgType,
      toUser: parsed.toUser,
      createTime: parsed.createTime,
      // B.3 hard guard 决策 reply 通道：service → 客服接口；subscription → 仅静默切 handover
      accountType: cfg.accountType ?? "service",
    },
    receivedAt: parsed.createTime > 0 ? new Date(parsed.createTime * 1000) : new Date(),
  };
}

/** text 之外消息类型的兜底回复文案（B.1 仅返字符串，B.3 才负责发回）。 */
export function buildFallbackReply(msgType: string): string {
  if (msgType === "image" || msgType === "voice" || msgType === "video" || msgType === "shortvideo") {
    return "敬请期待图片/语音支持，先发文字消息描述你的问题给我吧～";
  }
  if (msgType === "event") return ""; // 关注/取关/菜单点击等事件 v1 不响应
  return "暂不支持此类消息，请发文字～";
}
