/**
 * PR-Y1: 企业画像链路 — 跨行业客户开通的核心能力。
 * 流程: 客户资料(官网/产品文档/历史文章)+老板问卷 → LLM 提炼企业画像(存 tenant config.companyProfile)
 *      → 推导账号矩阵定位(每号角色+persona, 回写 platform_accounts.persona)
 *      → 生成选题池(入 keywords 表, tenant 私有, sourcePlatform=onboarding)。
 * 之后该客户的每日生成/人设注入/独家分配全部自动吃到这套定位。
 */
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { keywords, platformAccounts, tenants } from "../../models/schema.js";
import { chat } from "../ai/chat-service.js";
import { logger } from "../../config/logger.js";

export interface CompanyProfile {
  industry: string;
  products: string[];
  targetCustomers: string;   // 谁掏钱, 决策人画像
  sellingPoints: string[];
  competitors?: string[];
  taboos?: string[];         // 禁忌话题/合规边界
  toneSuggestion?: string;   // 整体调性建议
  summary: string;           // 一段话画像
}

function extractJson<T>(raw: string): T | null {
  const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

/** 第一步: 资料+问卷 → 企业画像, 存 tenant config.companyProfile */
export async function extractCompanyProfile(opts: {
  tenantId: string;
  userId: string;
  materials: string[];           // 官网文案/产品介绍/历史文章, 每段一条
  questionnaire?: Record<string, string>; // 老板问卷 {问题: 回答}
}): Promise<CompanyProfile> {
  const mat = opts.materials.map((m, i) => `【资料${i + 1}】\n${m.slice(0, 5000)}`).join("\n\n");
  const qa = opts.questionnaire
    ? Object.entries(opts.questionnaire).map(([q, a]) => `Q: ${q}\nA: ${a}`).join("\n")
    : "(未提供)";
  const res = await chat({
    tenantId: opts.tenantId,
    userId: opts.userId,
    conversationId: `onboarding-profile-${opts.tenantId}`,
    message: `${mat}\n\n【老板问卷】\n${qa}`,
    systemPrompt: `你是企业内容营销顾问。根据客户提供的公司资料和问卷, 提炼"企业画像", 严格输出 JSON (不要任何其他文字):
{"industry":"行业","products":["产品/服务1",...],"targetCustomers":"目标客户与决策人画像(一段话)","sellingPoints":["核心卖点1",...],"competitors":["竞品",...],"taboos":["不能碰的话题/表述",...],"toneSuggestion":"内容整体调性建议(一句话)","summary":"150字以内的企业画像总结"}`,
  });
  const profile = extractJson<CompanyProfile>(res.content);
  if (!profile || !profile.industry || !profile.summary) {
    throw new Error("画像提炼失败: LLM 输出无法解析, 请补充资料后重试");
  }
  const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, opts.tenantId)).limit(1);
  const cfg = (t?.config as Record<string, unknown>) ?? {};
  cfg.companyProfile = { ...profile, extractedAt: new Date().toISOString() };
  await db.update(tenants).set({ config: cfg }).where(eq(tenants.id, opts.tenantId));
  logger.info({ tenantId: opts.tenantId, industry: profile.industry }, "PR-Y1 企业画像已提炼保存");
  return profile;
}

export async function readCompanyProfile(tenantId: string): Promise<CompanyProfile | null> {
  const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const p = (t?.config as { companyProfile?: CompanyProfile } | null)?.companyProfile;
  return p && p.summary ? p : null;
}

/** 第二步: 画像 + 账号列表 → 每号角色定位与 persona (overwrite=false 时只填空白的) */
export async function deriveAccountPositioning(opts: {
  tenantId: string;
  userId: string;
  overwrite?: boolean;
}): Promise<Array<{ accountId: string; accountName: string; role: string; persona: string }>> {
  const profile = await readCompanyProfile(opts.tenantId);
  if (!profile) throw new Error("请先提炼企业画像 (POST /admin/onboarding/profile)");
  const accts = await db
    .select({ id: platformAccounts.id, accountName: platformAccounts.accountName, platform: platformAccounts.platform, persona: platformAccounts.persona })
    .from(platformAccounts)
    .where(eq(platformAccounts.tenantId, opts.tenantId));
  if (accts.length === 0) throw new Error("该租户还没有账号, 先添加账号");

  const res = await chat({
    tenantId: opts.tenantId,
    userId: opts.userId,
    conversationId: `onboarding-accounts-${opts.tenantId}`,
    message: `企业画像: ${JSON.stringify(profile)}\n\n账号列表: ${JSON.stringify(accts.map((a) => ({ id: a.id, name: a.accountName, platform: a.platform })))}`,
    systemPrompt: `你是新媒体矩阵操盘手。根据企业画像给每个账号分配差异化角色定位, 角色从[获客号(痛点引流), 专业权威号(深度内容建信任), 老板IP号(人设化第一人称), 案例展示号, 行业资讯号]中选或自拟, 同公司账号角色尽量不重复。为每个号写一段 persona(120字内: 自称/对读者称呼/语气/口头禅/禁忌)。严格输出 JSON 数组: [{"id":"账号id","role":"角色","persona":"人设描述"}]`,
  });
  const parsed = extractJson<Array<{ id: string; role: string; persona: string }>>(res.content);
  if (!parsed || !Array.isArray(parsed)) throw new Error("账号定位推导失败: LLM 输出无法解析");

  const out: Array<{ accountId: string; accountName: string; role: string; persona: string }> = [];
  for (const p of parsed) {
    const acct = accts.find((a) => a.id === p.id);
    if (!acct || !p.persona) continue;
    if (!opts.overwrite && acct.persona) continue; // 已有人设不覆盖
    const persona = `【角色: ${p.role}】${p.persona}`.slice(0, 1800);
    await db.update(platformAccounts).set({ persona, updatedAt: new Date() }).where(eq(platformAccounts.id, acct.id));
    out.push({ accountId: acct.id, accountName: acct.accountName, role: p.role, persona });
  }
  logger.info({ tenantId: opts.tenantId, updated: out.length }, "PR-Y1 账号定位已推导回写");
  return out;
}

/** 第三步: 画像 → 选题池 (keywords 表, tenant 私有) */
export async function generateTopicPool(opts: {
  tenantId: string;
  userId: string;
  count?: number;
}): Promise<string[]> {
  const profile = await readCompanyProfile(opts.tenantId);
  if (!profile) throw new Error("请先提炼企业画像");
  const count = Math.min(Math.max(opts.count ?? 50, 10), 100);
  const res = await chat({
    tenantId: opts.tenantId,
    userId: opts.userId,
    conversationId: `onboarding-topics-${opts.tenantId}`,
    message: `企业画像: ${JSON.stringify(profile)}\n\n生成 ${count} 条选题。`,
    systemPrompt: `你是内容选题策划。根据企业画像, 站在"客户的客户"视角生成选题(他们搜什么/愁什么/想比较什么), 覆盖: 痛点科普/产品场景/避坑指南/行业趋势/常见问答, 每条 ≤25 字, 不带编号。严格输出 JSON 数组: ["选题1","选题2",...]`,
  });
  const topics = (extractJson<string[]>(res.content) ?? []).filter((t) => typeof t === "string" && t.trim().length >= 4).slice(0, count);
  if (topics.length === 0) throw new Error("选题池生成失败: LLM 输出无法解析");
  await db.insert(keywords).values(topics.map((t) => ({
    tenantId: opts.tenantId,
    keyword: t.trim().slice(0, 200),
    sourcePlatform: "onboarding",
    heatScore: 50,
    compositeScore: 50,
    crawlDate: new Date().toISOString().slice(0, 10),
  })));
  // PR-V1: 自动给该租户配 topicPool 每日配额, 让每日生成从选题池取题(跨行业最后一公里)
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, opts.tenantId)).limit(1);
    const cfg = (t?.config as Record<string, any>) ?? {};
    const auto = (cfg.automationConfig as Record<string, any>) ?? {};
    const cq = (auto.contentQuota as Record<string, any>) ?? {};
    if (!cq.topicPool) {
      cq.topicPool = { count: Math.min(5, topics.length), disciplines: [] };
      auto.contentQuota = cq;
      cfg.automationConfig = auto;
      await db.update(tenants).set({ config: cfg }).where(eq(tenants.id, opts.tenantId));
      logger.info({ tenantId: opts.tenantId }, "PR-V1 已自动配 topicPool 每日配额");
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "PR-V1 自动配 topicPool 配额失败(可手动配)");
  }
  logger.info({ tenantId: opts.tenantId, count: topics.length }, "PR-Y1 选题池已入库");
  return topics;
}
