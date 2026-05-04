/**
 * 公众号订阅号 passive XML 回复 —— PR B.7-A
 *
 * 订阅号客服接口微信不开放 → outbound 唯一通道是 5s 内同步 XML 返 callback response。
 * 设计：固定文案 + 注入 BossMate URL，引流自服务，后台异步发 lead.need_human 等真人接手。
 * 不调 LLM 同步等待（5s budget 不稳）— 客户秒回兜底，AI 不在订阅号路径上。
 */
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { tenants } from "../../models/schema.js";

const DEFAULT_BOSSMATE_URL = "https://bossmate.app/try";
const PASSIVE_TEMPLATE = "您好我是 BossMate 客服小王 ☕ 收到您的消息，老师马上联系您~\n同时您可以打开 BossMate 平台 {bossmate_url}，AI 3 秒帮您匹配 5 本最对口期刊，免费试用~";

export async function loadBossmateUrl(tenantId: string): Promise<string> {
  const [t] = await db.select({ url: tenants.bossmatePlatformUrl }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return t?.url ?? DEFAULT_BOSSMATE_URL;
}

export function buildPassiveReplyContent(bossmateUrl: string): string {
  return PASSIVE_TEMPLATE.replace("{bossmate_url}", bossmateUrl);
}

/** 构造公众号 passive reply XML（CDATA 包文本，防 & < > 转义炸） */
export function buildPassiveReplyXml(args: { fromUser: string; toUser: string; content: string }): string {
  const ts = Math.floor(Date.now() / 1000);
  return `<xml>
<ToUserName><![CDATA[${args.fromUser}]]></ToUserName>
<FromUserName><![CDATA[${args.toUser}]]></FromUserName>
<CreateTime>${ts}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${args.content}]]></Content>
</xml>`;
}
