/**
 * 微信客服 AI 应答引擎 —— B-kf 核心
 *
 * 混合模式：能答的自动回（journal_query / service_faq / chitchat），拿不准的转人工（handoff）。
 *
 * 处理流程（单条入站 text）：
 *   1. 会话 upsert + 入站消息落库（wx_msgid 唯一防重，冲突即跳过整条处理）
 *   2. mode=manual → 只落库不回复（人工接管中）
 *   3. 一次 LLM 调用做意图分类（JSON 输出），按 intent 分流
 *   4. journal_query 只用 journals 表真实字段作事实源，缺字段说"暂无数据"，禁止编造
 *   5. 全链路降级：AI/DB 任何异常 → 转人工，绝不向上抛（保回调 200）
 *
 * 运营通知：handoff 时通过企微自建应用（kf-client.notifyStaff）给运营推消息；
 * agent_secret 未配置则静默跳过，通知失败只 warn —— 通知是旁路，绝不影响主流程。
 */
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { kfConversations, kfMessages, kfFaqs, journals } from "../../models/schema.js";
import { chat } from "../ai/chat-service.js";
import { sendKfText, transferServiceState, syncKfMessages, notifyStaff } from "./kf-client.js";
import type { KfSyncedMsg } from "./kf-client.js";
import { logger } from "../../config/logger.js";

export interface KfInboundText {
  tenantId: string;
  openKfid: string;
  externalUserid: string;
  msgid: string;
  content: string;
}

type Intent = "journal_query" | "service_faq" | "chitchat" | "handoff";

const HANDOFF_REPLY = "好的，已为您转接人工客服，请稍候，我们的顾问会尽快回复您～";

/** 会话 upsert：存在则刷 last_msg_at，不存在则建（mode 默认 auto） */
async function upsertConversation(msg: KfInboundText) {
  const [existing] = await db.select().from(kfConversations).where(and(
    eq(kfConversations.tenantId, msg.tenantId),
    eq(kfConversations.openKfid, msg.openKfid),
    eq(kfConversations.externalUserid, msg.externalUserid),
  )).limit(1);
  if (existing) {
    await db.update(kfConversations).set({ lastMsgAt: new Date() }).where(eq(kfConversations.id, existing.id));
    return existing;
  }
  const [created] = await db.insert(kfConversations).values({
    tenantId: msg.tenantId,
    openKfid: msg.openKfid,
    externalUserid: msg.externalUserid,
    lastMsgAt: new Date(),
  }).returning();
  return created;
}

type ChatContext = Array<{ role: string; content: string }>;

const HISTORY_LIMIT = 10;         // 最近 N 条消息进上下文（含入站/出站）
const HISTORY_CHAR_BUDGET = 2400; // 历史总字符预算（约 ≤2K token），超出从最旧开始丢
const HISTORY_ITEM_MAX = 500;     // 单条消息截断上限，防超长粘贴挤爆预算

/**
 * 多轮记忆：取会话最近历史（排除刚落库的当前入站消息），转成 chat() 的 context（旧→新）。
 * 查询走 idx_kf_msg_conv(conversation_id, created_at) 索引。
 * 历史是增强不是关键路径：任何失败返回 []（本条无记忆应答），绝不影响主流程——与本模块"旁路失败只降级"哲学一致。
 */
async function loadHistoryContext(conversationId: string, excludeMessageId?: string): Promise<ChatContext> {
  try {
    const rows = await db.select({ id: kfMessages.id, direction: kfMessages.direction, content: kfMessages.content })
      .from(kfMessages)
      .where(eq(kfMessages.conversationId, conversationId))
      .orderBy(desc(kfMessages.createdAt))
      .limit(HISTORY_LIMIT + 1); // +1：结果可能含当前这条，过滤后仍够 HISTORY_LIMIT 条

    let budget = HISTORY_CHAR_BUDGET;
    const ctx: ChatContext = [];
    for (const r of rows) { // rows 新→旧
      if (excludeMessageId && r.id === excludeMessageId) continue;
      if (ctx.length >= HISTORY_LIMIT) break;
      const content = (r.content ?? "").slice(0, HISTORY_ITEM_MAX);
      if (!content) continue; // 空内容不进上下文
      if (budget < content.length) break; // 预算耗尽，更旧的全部丢弃
      budget -= content.length;
      ctx.push({ role: r.direction === "in" ? "user" : "assistant", content });
    }
    return ctx.reverse(); // 转回旧→新（chat 会按顺序拼进 messages）
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, conversationId }, "kf 历史上下文加载失败（忽略，本条无记忆应答）");
    return [];
  }
}

/** 出站消息：发企微 + 落库（ai_action 记录 answered/transferred 等） */
async function replyAndRecord(conv: { id: string; openKfid: string; externalUserid: string }, text: string, intent: Intent | null, action: string) {
  await sendKfText(conv.openKfid, conv.externalUserid, text);
  await db.insert(kfMessages).values({
    conversationId: conv.id,
    direction: "out",
    msgType: "text",
    content: text,
    aiIntent: intent ?? undefined,
    aiAction: action,
  });
}

/** 转人工：回复 + mode 置 manual + 调企微转接（state=2 待接入池）+ 尽力通知运营 */
async function handoffToHuman(conv: { id: string; tenantId: string; openKfid: string; externalUserid: string }, intent: Intent | null, reason: string) {
  await replyAndRecord(conv, HANDOFF_REPLY, intent, "transferred");
  await db.update(kfConversations).set({ mode: "manual" }).where(eq(kfConversations.id, conv.id));
  await transferServiceState(conv.openKfid, conv.externalUserid, 2); // 2=进待接入池等人工认领
  logger.warn({ conversationId: conv.id, tenantId: conv.tenantId, reason }, "kf 会话已转人工，请运营尽快跟进");
  // 通知运营（企微自建应用 message/send）：失败只 warn，绝不影响 handoff 主流程
  try {
    const [lastIn] = await db.select({ content: kfMessages.content }).from(kfMessages)
      .where(and(eq(kfMessages.conversationId, conv.id), eq(kfMessages.direction, "in")))
      .orderBy(desc(kfMessages.createdAt)).limit(1);
    const lastText = (lastIn?.content ?? "").slice(0, 120);
    await notifyStaff([
      "【AI 客服转人工】",
      `客户: ${conv.externalUserid.slice(0, 12)}…`,
      `原因: ${reason}`,
      `客户最后一条消息: ${lastText || "（无）"}`,
      "请到 BossMate「AI 客服」页接管会话",
    ].join("\n"));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, conversationId: conv.id }, "handoff 运营通知失败（已忽略）");
  }
}

/** 从 LLM 输出里抠 JSON（容忍 ```json 围栏 / 前后废话） */
function extractJson(raw: string): Record<string, unknown> | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
}

/** 意图分类：一次 LLM 调用，JSON 输出；解析失败按 handoff 处理（宁转人工不瞎答） */
async function classifyIntent(tenantId: string, conversationId: string, content: string, history: ChatContext): Promise<{ intent: Intent; journalName?: string }> {
  const systemPrompt = `你是一家学术期刊咨询服务公司的客服意图分类器。业务背景：我们为科研作者提供 SCI / 中文核心期刊的推荐与投稿咨询服务，客户常问某期刊的影响因子、分区、审稿周期、录用难度、版面费，或咨询我们的服务内容与价格。
把用户消息分类为以下四种意图之一，只输出 JSON，不要输出任何其他文字：
- journal_query：询问某本具体期刊的信息（需抽取期刊名，中英文均可，去掉书名号）
- service_faq：询问我们的服务内容、流程、售后等常规问题
- chitchat：寒暄、问候、闲聊
- handoff：投诉、价格谈判、复杂个案，或你不确定属于哪类
用户消息可能是对历史对话的追问（如"那审稿周期呢""这个期刊版面费多少"）。结合对话历史消解指代：journal_name 必须输出完整期刊名（优先取历史中最近提到的期刊），禁止输出"这个期刊"之类的代词；若历史中也定位不到所指期刊，才归类 handoff。
输出格式：{"intent":"journal_query","journal_name":"期刊名"}；非 journal_query 时省略 journal_name。`;
  const res = await chat({
    tenantId,
    userId: "kf-bot",
    conversationId,
    message: content,
    context: history, // 多轮记忆：历史对话（旧→新），供追问/指代消解
    skillType: "customer_service", // 走 Qwen-Plus（model-router 锁 DeepSeek/Qwen）
    systemPrompt,
  });
  const parsed = extractJson(res.content);
  const intent = String(parsed?.intent ?? "");
  if (intent === "journal_query" || intent === "service_faq" || intent === "chitchat" || intent === "handoff") {
    const journalName = typeof parsed?.journal_name === "string" ? parsed.journal_name.trim() : undefined;
    return { intent, journalName };
  }
  return { intent: "handoff" }; // 分类不出来 = 拿不准 → 转人工
}

/** 期刊查询：先精确后模糊（name/name_en/abbreviation），取 confidence 最高一条 */
async function findJournal(tenantId: string, name: string) {
  const scope = or(isNull(journals.tenantId), eq(journals.tenantId, tenantId)); // 全局共享刊 + 租户自有刊
  const byConfidence = desc(sql`coalesce(${journals.confidence}, 0)`);

  // 精确匹配（不区分大小写）
  const exact = await db.select().from(journals).where(and(scope, or(
    sql`lower(${journals.name}) = lower(${name})`,
    sql`lower(${journals.nameEn}) = lower(${name})`,
    sql`lower(${journals.abbreviation}) = lower(${name})`,
  ))).orderBy(byConfidence).limit(1);
  if (exact[0]) return exact[0];

  // 模糊匹配
  const kw = `%${name}%`;
  const fuzzy = await db.select().from(journals).where(and(scope, or(
    ilike(journals.name, kw),
    ilike(journals.nameEn, kw),
    ilike(journals.abbreviation, kw),
  ))).orderBy(byConfidence).limit(1);
  return fuzzy[0] ?? null;
}

/** journals 行 → 事实清单（只挑客服常问字段；null 显式标"暂无数据"让 LLM 无从编造） */
function journalFacts(j: typeof journals.$inferSelect): string {
  const na = "暂无数据";
  const lines = [
    `期刊名称: ${j.name}${j.nameEn && j.nameEn !== j.name ? `（${j.nameEn}）` : ""}`,
    `影响因子(IF): ${j.impactFactor ?? na}`,
    `中科院分区: ${j.casPartition ?? j.casPartitionNew ?? na}`,
    `JCR 分区: ${j.partition ?? na}`,
    `录用率: ${j.acceptanceRate != null ? `${Math.round(j.acceptanceRate * 100)}%` : (j.acceptanceDifficulty ?? na)}`,
    `审稿周期: ${j.reviewCycle ?? na}`,
    `中科院预警: ${j.isWarningList ? `是（${j.warningYear ?? "年份未知"}），投稿需谨慎` : "未在预警名单"}`,
    `版面费(APC): ${j.apcFee != null ? `${j.apcFee} 美元` : na}`,
  ];
  return lines.join("\n");
}

/** journal_query：DB 真实字段是唯一事实源；查不到诚实说没收录并转人工 */
async function answerJournalQuery(conv: { id: string; tenantId: string; openKfid: string; externalUserid: string }, content: string, journalName: string | undefined, history: ChatContext) {
  const name = journalName?.trim();
  if (!name) { await handoffToHuman(conv, "journal_query", "未抽取到期刊名"); return; }

  const journal = await findJournal(conv.tenantId, name);
  if (!journal) {
    // 诚实说没收录 + 转人工（不走 handoffToHuman 是为了发定制文案而非通用转接语）
    await replyAndRecord(conv, `抱歉，「${name}」暂未收录在我们的期刊数据库中，无法给您准确数据。已为您转接人工顾问进一步查询～`, "journal_query", "transferred");
    await db.update(kfConversations).set({ mode: "manual" }).where(eq(kfConversations.id, conv.id));
    await transferServiceState(conv.openKfid, conv.externalUserid, 2);
    logger.warn({ conversationId: conv.id, journalName: name }, "kf 期刊未收录，已转人工");
    return;
  }

  const systemPrompt = `你是学术期刊咨询客服。下面「期刊数据」是数据库里的真实数据，是你回答的唯一事实来源。
红线（违反即事故）：
1. 只准使用给定数据回答，一个数字都不允许自己补；
2. 数据里标"暂无数据"的字段，就如实告诉用户"该项暂无数据"；
3. 禁止编造影响因子、分区、录用率、周期、费用等任何数值；
4. 若期刊在预警名单，必须明确提醒用户。
5. 对话历史仅用于理解指代与衔接语气，任何数值仍只能来自「期刊数据」。
风格：中文、简洁友好、适当分行，结尾可提示"还想了解其他期刊或投稿服务，随时问我"。

期刊数据：
${journalFacts(journal)}`;
  const res = await chat({ tenantId: conv.tenantId, userId: "kf-bot", conversationId: conv.id, message: content, context: history, skillType: "customer_service", systemPrompt });
  await replyAndRecord(conv, res.content.trim(), "journal_query", "answered");
}

/** service_faq：租户 enabled FAQ 全量（≤30）塞 prompt；覆盖不了 → 转人工 */
async function answerServiceFaq(conv: { id: string; tenantId: string; openKfid: string; externalUserid: string }, content: string, history: ChatContext) {
  const faqs = await db.select().from(kfFaqs)
    .where(and(eq(kfFaqs.tenantId, conv.tenantId), eq(kfFaqs.enabled, true)))
    .orderBy(asc(kfFaqs.sort), asc(kfFaqs.createdAt)).limit(30);

  if (faqs.length === 0) { await handoffToHuman(conv, "service_faq", "FAQ 库为空"); return; }

  const faqText = faqs.map((f, i) => `${i + 1}. 问：${f.question}\n   答：${f.answer}`).join("\n");
  const systemPrompt = `你是学术期刊咨询服务公司的客服。只能基于下面 FAQ 列表回答用户问题，不得自行发挥或承诺 FAQ 里没有的内容。
如果 FAQ 覆盖不了用户的问题，只输出四个大写字母：NO_ANSWER（不要输出其他任何内容）。
回答风格：中文、简洁友好。

FAQ 列表：
${faqText}`;
  const res = await chat({ tenantId: conv.tenantId, userId: "kf-bot", conversationId: conv.id, message: content, context: history, skillType: "customer_service", systemPrompt });
  const answer = res.content.trim();
  if (!answer || answer.includes("NO_ANSWER")) { await handoffToHuman(conv, "service_faq", "FAQ 未覆盖该问题"); return; }
  await replyAndRecord(conv, answer, "service_faq", "answered");
}

/** chitchat：简短友好 + 引导到期刊咨询 */
async function answerChitchat(conv: { id: string; tenantId: string; openKfid: string; externalUserid: string }, content: string, history: ChatContext) {
  const systemPrompt = `你是学术期刊咨询服务公司的客服。用户在寒暄闲聊，用 1-2 句中文简短友好地回应，并自然地引导：可以直接发期刊名查影响因子/分区/审稿周期，也可咨询论文投稿服务。不要长篇大论。`;
  const res = await chat({ tenantId: conv.tenantId, userId: "kf-bot", conversationId: conv.id, message: content, context: history, skillType: "customer_service", systemPrompt });
  await replyAndRecord(conv, res.content.trim() || "您好～有期刊或投稿方面的问题，随时问我！", "chitchat", "answered");
}

/**
 * 处理一条入站 text 消息（kf-client sync 后逐条喂入）。
 * 任何异常内部消化：能定位到会话就降级转人工，定位不到只记日志——绝不向调用方抛错。
 */
export async function processKfTextMessage(msg: KfInboundText): Promise<void> {
  let conv: Awaited<ReturnType<typeof upsertConversation>> | null = null;
  try {
    conv = await upsertConversation(msg);

    // 入站落库 + wx_msgid 防重：冲突说明这条已处理过（sync 游标重叠重放），直接跳过
    const inserted = await db.insert(kfMessages).values({
      conversationId: conv.id,
      direction: "in",
      msgType: "text",
      content: msg.content,
      wxMsgid: msg.msgid,
    }).onConflictDoNothing().returning({ id: kfMessages.id });
    if (inserted.length === 0) return;

    // 人工接管中：只落库，AI 静默
    if (conv.mode === "manual") return;

    // 多轮记忆：取最近历史（排除刚落库的当前消息）作对话上下文；失败返回 [] 不影响应答
    const history = await loadHistoryContext(conv.id, inserted[0]?.id);

    const { intent, journalName } = await classifyIntent(msg.tenantId, conv.id, msg.content, history);
    logger.info({ conversationId: conv.id, intent, journalName, historyLen: history.length }, "kf 意图分类完成");

    if (intent === "journal_query") await answerJournalQuery(conv, msg.content, journalName, history);
    else if (intent === "service_faq") await answerServiceFaq(conv, msg.content, history);
    else if (intent === "chitchat") await answerChitchat(conv, msg.content, history);
    else await handoffToHuman(conv, "handoff", "分类为 handoff（投诉/议价/复杂/不确定）");
  } catch (err) {
    // AI/DB 挂了不能把回调拖成 5xx：降级转人工
    logger.error({ err: err instanceof Error ? err.message : err, msgid: msg.msgid }, "kf responder 处理失败，降级转人工");
    if (conv) {
      try { await handoffToHuman(conv, null, "AI 处理异常降级"); }
      catch (e2) { logger.error({ err: e2 instanceof Error ? e2.message : e2 }, "kf 降级转人工也失败"); }
    }
  }
}

// 客户非 text 消息的占位文案（管理页会话完整性用；AI 只答 text，这些不触发 AI）
const NON_TEXT_PLACEHOLDER: Record<string, string> = {
  image: "[图片]",
  voice: "[语音]",
  video: "[视频]",
  file: "[文件]",
  location: "[位置]",
};

/** 客户(origin=3)发的非 text 消息 → 落一条占位入站消息，不触发 AI */
async function recordNonTextInbound(tenantId: string, m: KfSyncedMsg): Promise<void> {
  try {
    const conv = await upsertConversation({ tenantId, openKfid: m.open_kfid, externalUserid: m.external_userid, msgid: m.msgid, content: "" });
    await db.insert(kfMessages).values({
      conversationId: conv.id,
      direction: "in",
      msgType: m.msgtype,
      content: NON_TEXT_PLACEHOLDER[m.msgtype] ?? "[不支持的消息类型]",
      aiAction: "skipped", // AI 只答 text，占位消息明确标跳过
      wxMsgid: m.msgid,    // 防重照旧：冲突即静默跳过
    }).onConflictDoNothing();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, msgid: m.msgid }, "kf 非文本占位消息落库失败");
  }
}

/**
 * 接待人员(origin=5)在企微客户端发的 text 回复 → 回流落库 + 会话置 manual。
 * 置 manual 是防 AI 与人工打架的关键：人工既已在企微端接管，AI 必须让位。
 */
async function recordHumanWecomReply(tenantId: string, m: KfSyncedMsg): Promise<void> {
  try {
    const conv = await upsertConversation({ tenantId, openKfid: m.open_kfid, externalUserid: m.external_userid, msgid: m.msgid, content: "" });
    const inserted = await db.insert(kfMessages).values({
      conversationId: conv.id,
      direction: "out",
      msgType: "text",
      content: m.text?.content ?? "",
      aiAction: "human_wecom", // 企微端人工回复（区分系统内 manual 回复）
      wxMsgid: m.msgid,        // 防重照旧
    }).onConflictDoNothing().returning({ id: kfMessages.id });
    if (inserted.length === 0) return; // sync 重放，这条已处理过

    if (conv.mode !== "manual") {
      await db.update(kfConversations).set({ mode: "manual" }).where(eq(kfConversations.id, conv.id));
      logger.info({ conversationId: conv.id }, "接待人员已在企微端回复，会话切 manual（AI 让位）");
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, msgid: m.msgid }, "kf 接待人员回复回流失败");
  }
}

/**
 * 回调 kf_msg_or_event 事件入口：sync_msg 拉增量 → 按 origin 分流。
 * origin 语义（企微官方文档「微信客服-读取消息」sync_msg 返回字段）：
 *   3=微信客户发送的消息  4=系统推送的消息（欢迎语/系统事件等）  5=接待人员在企业微信客户端发送的消息
 * 分流规则：
 *   - origin=3 + text     → AI 应答主流程（processKfTextMessage）
 *   - origin=3 + 非 text  → 落占位消息（[图片]/[语音]…），不触发 AI
 *   - origin=5 + text     → 回流落库（ai_action=human_wecom）+ 会话置 manual（AI 让位）
 *   - origin=4 / event    → 跳过不落库
 */
export async function handleKfMsgEvent(callbackToken?: string, openKfid?: string): Promise<void> {
  const synced = await syncKfMessages(callbackToken, openKfid);
  if (!synced) return;
  // 串行处理保证同会话消息顺序；各分支内部消化所有异常
  for (const m of synced.msgs) {
    if (m.origin === 3) {
      if (m.msgtype === "text" && m.text?.content) {
        await processKfTextMessage({
          tenantId: synced.tenantId,
          openKfid: m.open_kfid,
          externalUserid: m.external_userid,
          msgid: m.msgid,
          content: m.text.content,
        });
      } else if (m.msgtype !== "event") {
        await recordNonTextInbound(synced.tenantId, m);
      }
    } else if (m.origin === 5 && m.msgtype === "text" && m.text?.content) {
      await recordHumanWecomReply(synced.tenantId, m);
    }
    // origin=4（系统推送）及其余情况：跳过不落库
  }
}
