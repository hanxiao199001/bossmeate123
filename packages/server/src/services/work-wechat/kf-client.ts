/**
 * 企业微信「微信客服」API 客户端 —— B-kf
 *
 * 职责：access_token 缓存、sync_msg 拉取（游标持久化）、send_msg 发文本、service_state 转人工。
 * 凭证：workWechatConfigs.corpId + kfSecretEnc（credentialsKey 加密，见 utils/crypto.ts）。
 * HTTP 外呼与 chat-service 一致用全局 fetch，不引新依赖。
 *
 * 错误码约定：
 *   - 42001/40014（token 过期/非法）→ 失效缓存重试一次
 *   - 95xxx（send_msg 超 48h / 超 5 条限制等）→ 记日志静默返回，不抛（回调链路不能被打断）
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { workWechatConfigs, kfSyncCursors } from "../../models/schema.js";
import { decryptCredentials } from "../../utils/crypto.js";
import { logger } from "../../config/logger.js";

const QY_API = "https://qyapi.weixin.qq.com";

/** sync_msg 返回的单条消息（只声明用到的字段） */
export interface KfSyncedMsg {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number; // 3=客户发送 4=系统推送 5=接待人员发送
  msgtype: string;
  text?: { content: string };
  event?: { event_type: string };
}

interface KfCredential { tenantId: string; corpId: string; kfSecret: string }

/** 读单租户 kf 凭证（v1 与回调同款 LIMIT 1）；未配 kf_secret 返回 null */
async function loadKfCredential(): Promise<KfCredential | null> {
  const [cfg] = await db.select().from(workWechatConfigs).limit(1);
  if (!cfg || !cfg.kfSecretEnc) return null;
  try {
    return { tenantId: cfg.tenantId, corpId: cfg.corpId, kfSecret: decryptCredentials(cfg.kfSecretEnc) };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "kf_secret 解密失败");
    return null;
  }
}

// access_token 内存缓存：key=corpId。7200s 有效，提前 5 分钟刷新
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(cred: KfCredential, forceRefresh = false): Promise<string> {
  const cached = tokenCache.get(cred.corpId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;

  const url = `${QY_API}/cgi-bin/gettoken?corpid=${encodeURIComponent(cred.corpId)}&corpsecret=${encodeURIComponent(cred.kfSecret)}`;
  const res = await fetch(url);
  const data = (await res.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
  if (data.errcode || !data.access_token) {
    throw new Error(`kf gettoken 失败: ${data.errcode} ${data.errmsg}`);
  }
  const ttlMs = ((data.expires_in ?? 7200) - 300) * 1000; // 提前 5 分钟过期
  tokenCache.set(cred.corpId, { token: data.access_token, expiresAt: Date.now() + ttlMs });
  return data.access_token;
}

/** POST 企微 API，token 过期自动重试一次 */
async function postWithToken<T extends { errcode?: number; errmsg?: string }>(cred: KfCredential, path: string, body: Record<string, unknown>): Promise<T> {
  let token = await getAccessToken(cred);
  const doPost = async (): Promise<T> => {
    const res = await fetch(`${QY_API}${path}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  };
  let data = await doPost();
  if (data.errcode === 42001 || data.errcode === 40014) { // token 过期/非法 → 强刷重试
    token = await getAccessToken(cred, true);
    data = await doPost();
  }
  return data;
}

/**
 * 拉取微信客服消息（游标持久化到 kf_sync_cursors，断点续拉，分页拉完）。
 * @param callbackToken 回调事件里的 <Token>，传给 sync_msg 可拿到最新一条
 * @param openKfid 可选，限定客服账号（也是游标的维度；空时游标记在 "" 键下）
 */
export async function syncKfMessages(callbackToken?: string, openKfid?: string): Promise<{ tenantId: string; msgs: KfSyncedMsg[] } | null> {
  const cred = await loadKfCredential();
  if (!cred) { logger.warn({}, "kf 凭证未配置（kf_secret_enc 为空），跳过 sync_msg"); return null; }

  const cursorKey = openKfid ?? "";
  const [row] = await db.select().from(kfSyncCursors)
    .where(and(eq(kfSyncCursors.tenantId, cred.tenantId), eq(kfSyncCursors.openKfid, cursorKey))).limit(1);
  let cursor = row?.cursor ?? "";

  const msgs: KfSyncedMsg[] = [];
  // 上限 20 页防死循环（单页 1000 条，正常远用不满）
  for (let page = 0; page < 20; page++) {
    const body: Record<string, unknown> = { limit: 1000 };
    if (cursor) body.cursor = cursor;
    if (callbackToken) body.token = callbackToken;
    if (openKfid) body.open_kfid = openKfid;

    const data = await postWithToken<{ errcode?: number; errmsg?: string; next_cursor?: string; has_more?: number; msg_list?: KfSyncedMsg[] }>(cred, "/cgi-bin/kf/sync_msg", body);
    if (data.errcode) { logger.error({ errcode: data.errcode, errmsg: data.errmsg }, "kf sync_msg 失败"); break; }

    if (data.msg_list?.length) msgs.push(...data.msg_list);
    if (data.next_cursor) cursor = data.next_cursor;
    if (!data.has_more) break;
  }

  // 游标落库（upsert）：即便本轮消息处理失败，下轮也从新游标开始 —— 消息级防重靠 kf_messages.wx_msgid
  if (cursor) {
    await db.insert(kfSyncCursors)
      .values({ tenantId: cred.tenantId, openKfid: cursorKey, cursor, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [kfSyncCursors.tenantId, kfSyncCursors.openKfid], set: { cursor, updatedAt: new Date() } });
  }

  return { tenantId: cred.tenantId, msgs };
}

/**
 * 发送客服文本消息。95xxx 类业务限制（超 48h 未互动 / 超条数）记日志返回 false，不抛。
 * @returns 是否发送成功
 */
export async function sendKfText(openKfid: string, externalUserid: string, text: string): Promise<boolean> {
  const cred = await loadKfCredential();
  if (!cred) return false;
  try {
    const data = await postWithToken<{ errcode?: number; errmsg?: string; msgid?: string }>(cred, "/cgi-bin/kf/send_msg", {
      touser: externalUserid,
      open_kfid: openKfid,
      msgtype: "text",
      text: { content: text.slice(0, 2000) }, // 企微 text 上限约 2048 字节，粗截断保底
    });
    if (!data.errcode) return true;
    if (data.errcode >= 95000 && data.errcode < 96000) {
      // 95xxx：48h 窗口外 / 条数超限等业务限制 —— 预期内，不算异常
      logger.warn({ errcode: data.errcode, errmsg: data.errmsg, openKfid, externalUserid }, "kf send_msg 被业务规则限制，消息未送达");
      return false;
    }
    logger.error({ errcode: data.errcode, errmsg: data.errmsg, openKfid }, "kf send_msg 失败");
    return false;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, openKfid }, "kf send_msg 异常");
    return false;
  }
}

/**
 * 变更会话状态（转人工）。state: 2=待接入池 3=由智能助手转人工/指定接待 4=结束。
 * 常用：transferServiceState(kfid, uid, 2) 进待接入池等人工认领。
 */
export async function transferServiceState(openKfid: string, externalUserid: string, state: number, servicerUserid?: string): Promise<boolean> {
  const cred = await loadKfCredential();
  if (!cred) return false;
  try {
    const body: Record<string, unknown> = { open_kfid: openKfid, external_userid: externalUserid, service_state: state };
    if (servicerUserid) body.servicer_userid = servicerUserid;
    const data = await postWithToken<{ errcode?: number; errmsg?: string }>(cred, "/cgi-bin/kf/service_state/trans", body);
    if (data.errcode) {
      logger.warn({ errcode: data.errcode, errmsg: data.errmsg, openKfid, externalUserid, state }, "kf service_state/trans 失败（可能未配置接待人员），仅记日志");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, openKfid }, "kf service_state/trans 异常");
    return false;
  }
}

// ============ 自建应用通知（handoff 通知运营，B-kf ①） ============
// 走 workWechatConfigs.agentId 对应自建应用的 Secret（agent_secret_enc），token 与 kf token 分开缓存互不干扰。

interface AgentCredential { tenantId: string; corpId: string; agentId: string; agentSecret: string; notifyUserids: string | null }

/** 读自建应用凭证；agent_secret_enc 未配置返回 null（调用方静默跳过通知） */
async function loadAgentCredential(): Promise<AgentCredential | null> {
  const [cfg] = await db.select().from(workWechatConfigs).limit(1);
  if (!cfg || !cfg.agentSecretEnc) return null;
  try {
    return { tenantId: cfg.tenantId, corpId: cfg.corpId, agentId: cfg.agentId, agentSecret: decryptCredentials(cfg.agentSecretEnc), notifyUserids: cfg.notifyUserids };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "agent_secret 解密失败，跳过运营通知");
    return null;
  }
}

// 自建应用 access_token 独立缓存（key=corpId）；kf 与自建应用 Secret 不同，token 不可混用
const agentTokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAgentAccessToken(cred: AgentCredential, forceRefresh = false): Promise<string> {
  const cached = agentTokenCache.get(cred.corpId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;

  const url = `${QY_API}/cgi-bin/gettoken?corpid=${encodeURIComponent(cred.corpId)}&corpsecret=${encodeURIComponent(cred.agentSecret)}`;
  const res = await fetch(url);
  const data = (await res.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
  if (data.errcode || !data.access_token) {
    throw new Error(`agent gettoken 失败: ${data.errcode} ${data.errmsg}`);
  }
  const ttlMs = ((data.expires_in ?? 7200) - 300) * 1000; // 同 kf token：提前 5 分钟过期
  agentTokenCache.set(cred.corpId, { token: data.access_token, expiresAt: Date.now() + ttlMs });
  return data.access_token;
}

/**
 * 自建应用给运营推文本通知（POST /cgi-bin/message/send，msgtype=text）。
 * touser = notify_userids（DB 逗号分隔 → API 竖线分隔）；未配置则 "@all"。
 * 红线：任何失败只 warn 返回 false 绝不抛 —— 通知是 handoff 的旁路，不能拖垮主流程。
 */
export async function notifyStaff(text: string): Promise<boolean> {
  try {
    const cred = await loadAgentCredential();
    if (!cred) {
      logger.debug({}, "agent_secret 未配置，跳过 handoff 运营通知");
      return false;
    }
    const touser = cred.notifyUserids
      ? (cred.notifyUserids.split(",").map((s) => s.trim()).filter(Boolean).join("|") || "@all")
      : "@all";

    const doSend = async (token: string) => {
      const res = await fetch(`${QY_API}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser,
          msgtype: "text",
          agentid: Number(cred.agentId),
          text: { content: text.slice(0, 2000) }, // message/send text 上限 2048 字节，粗截断保底
        }),
      });
      return (await res.json()) as { errcode?: number; errmsg?: string };
    };

    let data = await doSend(await getAgentAccessToken(cred));
    if (data.errcode === 42001 || data.errcode === 40014) { // token 过期/非法 → 强刷重试一次
      data = await doSend(await getAgentAccessToken(cred, true));
    }
    if (data.errcode) {
      logger.warn({ errcode: data.errcode, errmsg: data.errmsg, touser }, "运营通知 message/send 失败（不影响主流程）");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "运营通知发送异常（不影响主流程）");
    return false;
  }
}
