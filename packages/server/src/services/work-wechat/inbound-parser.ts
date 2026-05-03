/**
 * 企业微信 inbound XML → InboundMessage —— B.2
 *
 * 明文 XML schema (text 消息)：
 *   <ToUserName>      corpId (企业微信公司 ID)
 *   <FromUserName>    用户 OpenID（外部联系人 / 客户）
 *   <CreateTime>      Unix 秒
 *   <MsgType>         text | image | event ...
 *   <Event>           external_contact | kf_msg | ... (仅当 MsgType=event 时存在)
 *   <Content>         text only
 *   <MsgId>           消息 ID（幂等键）
 *
 * v1 单租户：tenant 反查走 SELECT * FROM workWechatConfigs LIMIT 1（fallback）。
 */
import { XMLParser } from "fast-xml-parser";
import { db } from "../../models/db.js";
import { workWechatConfigs } from "../../models/schema.js";
import type { InboundMessage } from "../sales/lead-collector.js";

export interface ParsedWorkMsg {
  msgType: string;
  event?: string;
  msgId: string;
  fromUser: string;
  toUser: string;
  createTime: number;
  content?: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

export function parseWorkXml(rawXml: string): ParsedWorkMsg {
  const parsed = xmlParser.parse(rawXml);
  const xml = parsed?.xml;
  if (!xml) throw new Error("XML 缺 <xml> 根节点");
  const msgType = String(xml.MsgType ?? "").toLowerCase();
  const event = xml.Event ? String(xml.Event).toLowerCase() : undefined;
  const msgId = String(xml.MsgId ?? "");
  const fromUser = String(xml.FromUserName ?? "");
  const toUser = String(xml.ToUserName ?? "");
  const createTime = Number(xml.CreateTime ?? 0);
  if (!msgType || !fromUser || !toUser) throw new Error(`work XML 缺字段: type=${msgType} from=${fromUser} to=${toUser}`);
  return { msgType, event, msgId, fromUser, toUser, createTime, content: xml.Content ? String(xml.Content) : undefined };
}

/** 仅 text 消息（含 external_contact / kf_msg event 包裹的 text）转 InboundMessage；其余返 null。 */
export async function buildWorkInboundMessage(parsed: ParsedWorkMsg): Promise<InboundMessage | null> {
  if (parsed.msgType !== "text") return null;
  const [cfg] = await db.select().from(workWechatConfigs).limit(1);
  if (!cfg) return null;
  return {
    tenantId: cfg.tenantId,
    channel: "wechat_work",
    externalUserId: parsed.fromUser,
    content: parsed.content ?? "",
    metadata: {
      msgId: parsed.msgId || `work-${parsed.fromUser}-${parsed.createTime}`, // 部分 event 无 MsgId，补
      msgType: parsed.msgType,
      event: parsed.event,
      toUser: parsed.toUser,
      createTime: parsed.createTime,
    },
    receivedAt: parsed.createTime > 0 ? new Date(parsed.createTime * 1000) : new Date(),
  };
}
