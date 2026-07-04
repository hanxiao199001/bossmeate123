/**
 * PR-Z3: 内容合规层 — 商业化前置防线。
 * 1. 违禁词检查: 硬词(发布即封号级风险)拦截; 软词(广告法/医疗宣传红线)警告放行并记 metadata。
 *    词库 = 内置基础库 + SYSTEM config.automationConfig.complianceWords {hard[], soft[]} 扩展。
 * 2. AI 生成标识: 按《生成式AI服务管理办法》/《深度合成管理规定》要求, 发布时文末追加标识
 *    (SYSTEM config.automationConfig.aiLabel: false 可关, 默认开)。
 * 注: 词库为技术兜底, 不构成法律意见; 客户行业(医学学术)广告法红线建议请专业人士复核扩充。
 */
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { tenants } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { logger } from "../../config/logger.js";

// 硬词: 命中即拦截 (政治敏感类客户自行扩充; 此处放公认高危词根)
const HARD_WORDS = [
  "法轮", "六四", "台独", "藏独", "疆独", "颠覆国家", "暴恐",
];

// 软词: 广告法绝对化用语 + 医疗宣传红线 (命中警告, 不拦截)
const SOFT_WORDS = [
  "最佳", "最优", "第一", "顶级", "国家级", "全球首", "世界级", "极致", "绝无仅有",
  "100%有效", "根治", "治愈率", "包治", "药到病除", "完全无副作用", "保证录用", "包发表", "百分百中刊",
  "稳赚", "躺赚", "保过",
];

export interface ComplianceResult {
  blocked: boolean;
  hardHits: string[];
  softHits: string[];
}

async function loadExtraWords(): Promise<{ hard: string[]; soft: string[] }> {
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    const cw = ((t?.config as any)?.automationConfig?.complianceWords) ?? {};
    return {
      hard: Array.isArray(cw.hard) ? cw.hard.map(String) : [],
      soft: Array.isArray(cw.soft) ? cw.soft.map(String) : [],
    };
  } catch {
    return { hard: [], soft: [] };
  }
}

/** 文本合规检查 (标题+正文拼一起传入) */
export async function checkCompliance(text: string): Promise<ComplianceResult> {
  const extra = await loadExtraWords();
  const plain = text.replace(/<[^>]+>/g, "");
  const hardHits = [...new Set([...HARD_WORDS, ...extra.hard].filter((w) => w && plain.includes(w)))];
  const softHits = [...new Set([...SOFT_WORDS, ...extra.soft].filter((w) => w && plain.includes(w)))];
  if (hardHits.length > 0 || softHits.length > 0) {
    logger.warn({ hardHits, softHits }, "PR-Z3 合规检查命中");
  }
  return { blocked: hardHits.length > 0, hardHits, softHits };
}

// 6-19: 生成阶段自动净化 — 把"无歧义的"绝对化/医疗/投稿过度承诺词替换成合规说法,
// 让生成出来的内容/文案基本不带违规词(避免发布时才拦截 → 白烧 token + 白等生成)。
// 故意不动学术语境常见且合法的词(第一作者/国家级期刊/最佳论文奖), 那些靠 checkCompliance 软词警告人工判。
const SANITIZE_MAP: Array<[RegExp, string]> = [
  // 医疗红线
  [/根治/g, "改善"],
  [/治愈率/g, "有效率"],
  [/包治百病|包治/g, "有助于"],
  [/药到病除/g, "效果明显"],
  [/100\s*%\s*有效|百分之百有效|百分百有效/g, "效果显著"],
  [/完全无副作用|无任何副作用|绝无副作用/g, "副作用较小"],
  // 投稿/录用过度承诺
  [/保证录用|百分百中刊|百分之百录用|包过|保过|包录用|稳过|稳发|稳中|稳录|包中/g, "录用率较高"],
  [/包发表|保发表|保证发表/g, "较易发表"],
  // 7-03 ③: 投稿承诺性话术红线（老韩反馈"据xx查询…可放心投稿"式替读者拍板的承诺全禁）
  [/(?:可以|可)?放心投稿/g, "综合评估后再投稿"],
  [/闭眼[投冲]必中|投了?必中|必中无疑/g, "命中率相对较高"],
  // 赚钱类
  [/稳赚不赔|稳赚|躺赚/g, "有收益空间"],
  // 7-05 脏点清理: 大类学科名叠字(LLM 拼接 discipline+分区串致"医学医学2区TOP"). 限已知学科名, 不误伤合法叠词。
  [/(医学|生物学|工程技术|化学|物理学|材料科学|环境科学与生态学|环境科学|数学|农林科学|地球科学|计算机科学|药学|管理科学|经济学|心理学|社会学)(TOP)?\1/g, "$1$2"],
  // 绝对化(无歧义)
  [/绝无仅有/g, "较为少见"],
  [/全球首创|全球首发|全球第一|世界第一/g, "较早"],
  [/世界级/g, "高水平"],
  [/极致/g, "出色"],
];
export function sanitizeForCompliance(text: string | null | undefined): string {
  if (!text) return text ?? "";
  let out = String(text);
  for (const [re, rep] of SANITIZE_MAP) out = out.replace(re, rep);
  return out;
}

// 7-03 标题-正文一致性检查（行7 教训: 标题喊"稳发", 正文却"CAR 高风险, 建议避开" = 信任事故）。
// 规则级、零 LLM、极便宜: 只在正文出现高风险/预警/退稿信号时, 才禁止标题的"稳发/稳过/闭眼冲/放心/沾边就收"类保录承诺。
// (无风险信号时这些狠话由 rotation 限量放行, 不在此拦; 命中即转 needs_review, 标题需人工/重生修正)
const BODY_RISK_SIGNAL = /高风险|预警名单|已列入预警|上了?预警|建议(?:谨慎|避开|回避|绕行)|谨慎评估|已被\s*SCI\s*除名|被踢出|剔除出|拒稿率(?:高|偏高)|退稿率(?:高|偏高)|自引率[^。]{0,8}(?:高风险|偏高|过高)/;
const TITLE_OVERPROMISE = /稳发|稳过|稳中|稳录|闭眼[投冲]|放心[投冲发]|包过|包录|沾边就收|必中|无脑冲/g;

export function checkTitleBodyConsistency(
  title: string | null | undefined,
  body: string | null | undefined,
): { ok: boolean; titleHits: string[]; riskSignal: string | null } {
  const plainBody = (body || "").replace(/<[^>]+>/g, "");
  const risk = plainBody.match(BODY_RISK_SIGNAL);
  if (!risk) return { ok: true, titleHits: [], riskSignal: null };
  const hits = [...new Set((title || "").match(TITLE_OVERPROMISE) || [])];
  return { ok: hits.length === 0, titleHits: hits, riskSignal: risk[0] };
}

// 7-05 脏点清理(行1 教训): 标题的"审稿周期/录用率"具体数字必须在正文复现。
// 正文由核验过的期刊库派生 → 正文没有 = DB 没有 = 标题编造(行1 标题"审稿60天/录用率35%", DB两者皆空, 正文写"3-4个月/较低")。
// 只查 审稿周期(天/周/月) + 录用率(%) 这两个 DB 常缺、最易被 LLM 编造吸睛的字段; IF/分区等几乎必复现, 不查以免误伤。
const TITLE_DATA_CLAIM = /(?:审稿|外审|见刊|接收|录用率|命中率)[约仅低于\s]*\d+(?:\.\d+)?\s*(?:天|周|个月|月|%)/g;
export function checkTitleDataConsistency(
  title: string | null | undefined,
  body: string | null | undefined,
): { ok: boolean; mismatches: string[] } {
  const plainBody = (body || "").replace(/<[^>]+>/g, "");
  const claims = [...new Set((title || "").match(TITLE_DATA_CLAIM) || [])];
  const mismatches = claims.filter((c) => {
    const m = c.match(/(\d+(?:\.\d+)?)\s*(天|周|个月|月|%)/);
    if (!m) return false;
    const [, num, unit] = m;
    const unitAlt = unit === "月" || unit === "个月" ? "(?:个月|月)" : unit === "%" ? "%" : unit;
    // 正文出现 同数字+同单位 即算复现(月/个月 等价)
    return !new RegExp(num.replace(".", "\\.") + "\\s*" + unitAlt).test(plainBody);
  });
  return { ok: mismatches.length === 0, mismatches };
}

const AI_LABEL_HTML = `<p style="color:#999;font-size:12px;margin-top:24px;">本文由 AI 辅助生成，内容仅供参考。</p>`;

/** 发布时给正文追加 AI 生成标识 (config aiLabel=false 可关; 已含标识不重复加) */
export async function appendAiLabel(body: string): Promise<string> {
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    if (((t?.config as any)?.automationConfig?.aiLabel) === false) return body;
  } catch { /* 默认开 */ }
  if (body.includes("AI 辅助生成") || body.includes("AI辅助生成")) return body;
  return body + AI_LABEL_HTML;
}
