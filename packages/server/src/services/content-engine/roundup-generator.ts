/**
 * 多刊盘点生成器 (学同行"顾老论文说"风格). 选 N 本刊 + LLM 生成盘点全文 → RoundupData → HTML。
 * 选刊: journalIds 指定 / 或按 discipline(+catalog) 自动选(按录用率排序, 对普通作者友好)。
 * 复用 getProviders (DeepSeek/Qwen, 红线#3)。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { getProviders } from "../ai/provider-factory.js";
import { generateJournalRoundupHtml, type RoundupData } from "../publisher/adapters/journal-roundup-template.js";
import { journalScopeCondition } from "../recommendation/journal-scope.js";

interface JRow {
  id: string; name: string | null; discipline: string | null;
  acceptanceRate: number | null; reviewCycle: string | null; scopeDescription: string | null;
  coverImageUrl: string | null; catalogs: unknown; cscdLevel: string | null; pkuCoreLevel: string | null;
}
const COLS = {
  id: journals.id, name: journals.name, discipline: journals.discipline,
  acceptanceRate: journals.acceptanceRate, reviewCycle: journals.reviewCycle,
  scopeDescription: journals.scopeDescription, coverImageUrl: journals.coverImageUrl,
  catalogs: journals.catalogs, cscdLevel: journals.cscdLevel, pkuCoreLevel: journals.pkuCoreLevel,
};

export interface RoundupOptions {
  tenantId: string;
  journalIds?: string[];        // 手动指定 (按顺序)
  discipline?: string;          // 自动选: 学科
  catalog?: string;             // 自动选: 核心目录 pku-core/cssci/cscd
  scope?: string;               // PR-K 期刊定位 domestic/international (空=不限)
  count?: number;               // 自动选数量, 默认 3
  audience: string;             // 目标人群, 如 "普通院校教师评职称"
}

async function resolveJournals(opts: RoundupOptions): Promise<JRow[]> {
  if (opts.journalIds?.length) {
    const rows = (await db.select(COLS).from(journals).where(inArray(journals.id, opts.journalIds))) as JRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return opts.journalIds.map((id) => byId.get(id)).filter((r): r is JRow => !!r);
  }
  const conds = [
    eq(journals.status, "active"),
    // 够格盘点的刊: 有中文核心标签 或 有国际指标(IF/分区)。否则池里无信号的裸刊会混进来。
    // (原来只要求"有中文核心标签", 与"国外期刊"定位矛盾 → 选国外刊时 0 结果)
    sql`(
      (${journals.catalogs} IS NOT NULL AND jsonb_array_length(${journals.catalogs}) > 0)
      OR ${journals.impactFactor} IS NOT NULL OR ${journals.partition} IS NOT NULL
    )`,
  ];
  if (opts.discipline) conds.push(sql`${journals.discipline} ILIKE ${"%" + opts.discipline + "%"}`);
  if (opts.catalog) conds.push(sql`${journals.catalogs} @> ${JSON.stringify([opts.catalog])}::jsonb`);
  const scopeCond = journalScopeCondition(opts.scope);
  if (scopeCond) conds.push(scopeCond);
  return (await db.select(COLS).from(journals).where(and(...conds))
    .orderBy(sql`${journals.acceptanceRate} DESC NULLS LAST, random()`).limit(opts.count ?? 3)) as JRow[];
}

function catalogLabels(j: JRow): string {
  const labels: string[] = [];
  if (j.pkuCoreLevel) labels.push("北大核心");
  const cats = Array.isArray(j.catalogs) ? (j.catalogs as string[]) : [];
  if (cats.includes("cssci")) labels.push("CSSCI");
  if (cats.includes("cssci-ext")) labels.push("CSSCI扩展");
  if (j.cscdLevel) labels.push(`CSCD${j.cscdLevel}`);
  if (cats.includes("sci-core")) labels.push("科技核心");
  return labels.join("/") || "核心期刊";
}
// LLM 偶尔把段落字段返成"字符串"而非"字符串数组"; 直接 for-of 字符串会逐字符迭代 → 每个字一个 <p>。
// 统一归一化: 数组→清洗; 字符串→单段; 其它→空。
function toArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}
function wrapName(n: string | null): string {
  const s = (n ?? "").trim();
  if (!s) return "《期刊》";
  return /^《.*》$/.test(s) ? s : `《${s}》`;
}

async function callLlm(js: JRow[], audience: string): Promise<Partial<RoundupData> & { items?: Array<{ intro: string; experienceParas: string[]; directions?: string[] }> }> {
  const provider = getProviders().cheap[0];
  if (!provider) throw new Error("无可用 LLM provider");
  const sys = `你是学术投稿顾问 + 公众号爆款写手。给定 ${js.length} 本核心期刊和目标人群, 写一篇"多刊盘点"种草长文(对标公众号风格)。
**只输出纯 JSON** (不要 markdown):
{"title":"带钩子的标题","openingParas":["痛点开场段1","段2"],"openingQuestions":["👉式问题1","问题2"],
 "items":[{"intro":"该刊期刊简介一段","experienceParas":["投稿经验段1(初审/外审周期/什么稿子容易中)","段2"],"directions":["匹配方向1","方向2","方向3","方向4"]}, ...],
 "whyParas":["为什么这几本适合该人群一段"],"whyBullets":["共同特点1","特点2","特点3","特点4"],
 "pitfallParas":["常见误区引子"],"pitfallPoints":["误区1","误区2","误区3"],
 "reminderParas":["最后一句最重要的提醒"],"ctaLines":["私信引导1","支持点2","支持点3"]}
要求:
- items 数量必须 = ${js.length} 且顺序与下方期刊一一对应
- 投稿经验只能基于给定数据(学科/收稿范围/审稿周期/录用率/核心目录)写, **不要编造具体数字**, 没有的别瞎写
- 口语化、痛点导向、对"${audience}"有共情; 标题要有钩子`;
  const user = js.map((j, i) =>
    `期刊${i + 1}: ${j.name} | 学科:${j.discipline ?? "?"} | 核心:${catalogLabels(j)} | 审稿周期:${j.reviewCycle ?? "未知"} | 录用率:${j.acceptanceRate != null ? Math.round(j.acceptanceRate * 100) + "%" : "未知"} | 收稿范围:${(j.scopeDescription ?? "").slice(0, 200) || "未知"}`,
  ).join("\n") + `\n\n目标人群: ${audience}`;
  const resp = await provider.chat({
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    temperature: 0.8, maxTokens: Math.min(8000, 1400 + js.length * 700),
  });
  let text = resp.content.trim().replace(/^```json\s*/i, "").replace(/```\s*$/g, "").trim();
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  return JSON.parse(text);
}

function ruleFallback(js: JRow[], audience: string): RoundupData {
  return {
    title: `${audience}发核心，这${js.length}本可以重点关注！`,
    openingParas: [`评职称、发论文，${audience}最关心的就是选对刊物。`, "下面这几本，结合公开信息整理给你参考。"],
    openingQuestions: ["核心期刊是不是只认名校？", "没有大项目是不是没机会？"],
    items: js.map((j) => ({
      index: 0, name: wrapName(j.name), coverUrl: j.coverImageUrl,
      intro: `${wrapName(j.name)}，属于${catalogLabels(j)}${j.discipline ? "，" + j.discipline + "领域" : ""}。${(j.scopeDescription ?? "").slice(0, 120)}`,
      experienceParas: [`审稿周期${j.reviewCycle ?? "以官网为准"}${j.acceptanceRate != null ? "，录用率约 " + Math.round(j.acceptanceRate * 100) + "%" : ""}。建议投稿前对照收稿范围确认方向匹配。`],
      directions: [],
    })).map((it, i) => ({ ...it, index: i + 1 })),
    whyParas: ["核心原因：它们更看研究本身，而不是作者标签。"],
    whyBullets: ["认可度稳定", "看重成果质量", "强调问题意识"],
    ctaLines: ["私信咨询，获取 1V1 投稿期刊匹配", "专业编辑提供成果转化支持", "24h 在线答疑"],
  };
}

/** 生成盘点数据 (RoundupData)。 */
export async function generateRoundup(opts: RoundupOptions): Promise<RoundupData> {
  const js = await resolveJournals(opts);
  if (js.length === 0) throw new Error("generateRoundup: 没选到期刊 (检查 journalIds / discipline)");

  let parsed: Awaited<ReturnType<typeof callLlm>> | null = null;
  try {
    parsed = await callLlm(js, opts.audience);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "roundup.llm_failed_fallback");
  }
  if (!parsed?.items || parsed.items.length === 0) return ruleFallback(js, opts.audience);

  const items = js.map((j, i) => {
    const it = parsed!.items![i] ?? { intro: "", experienceParas: [] };
    const exp = toArr(it.experienceParas);
    return {
      index: i + 1, name: wrapName(j.name), coverUrl: j.coverImageUrl,
      intro: (typeof it.intro === "string" && it.intro.trim()) ? it.intro.trim() : `${wrapName(j.name)}，${catalogLabels(j)}。`,
      experienceParas: exp.length ? exp : [`审稿周期 ${j.reviewCycle ?? "以官网为准"}。`],
      directions: toArr(it.directions),
    };
  });
  const whyParas = toArr(parsed.whyParas);
  const pitfallParas = toArr(parsed.pitfallParas), pitfallPoints = toArr(parsed.pitfallPoints);
  const reminderParas = toArr(parsed.reminderParas);
  return {
    title: (typeof parsed.title === "string" && parsed.title.trim()) ? parsed.title.trim() : `${opts.audience}发核心，这${js.length}本可以重点关注`,
    openingParas: toArr(parsed.openingParas),
    openingQuestions: toArr(parsed.openingQuestions),
    items,
    whyTitle: whyParas.length || toArr(parsed.whyBullets).length ? "为什么这几本更适合？" : undefined,
    whyParas, whyBullets: toArr(parsed.whyBullets),
    pitfallTitle: pitfallParas.length || pitfallPoints.length ? "很多人发不了核心，问题其实在这" : undefined,
    pitfallParas, pitfallPoints,
    reminderTitle: reminderParas.length ? "最后一句最重要的提醒" : undefined,
    reminderParas,
    ctaLines: toArr(parsed.ctaLines),
  };
}

/** 一步到位: 生成盘点 → 渲染 HTML。 */
export async function generateRoundupArticle(opts: RoundupOptions): Promise<{ title: string; html: string; journalCovers: string[] }> {
  const data = await generateRoundup(opts);
  const journalCovers = data.items.map((it) => it.coverUrl).filter((u): u is string => !!u && /^https?:\/\//.test(u));
  return { title: data.title, html: generateJournalRoundupHtml(data), journalCovers };
}
