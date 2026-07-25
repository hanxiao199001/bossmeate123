/**
 * PR-Z3: 内容合规层 — 商业化前置防线。
 * 1. 违禁词检查: 硬词(发布即封号级风险)拦截; 软词(广告法/医疗宣传红线)警告放行并记 metadata。
 *    词库 = 内置基础库 + SYSTEM config.automationConfig.complianceWords {hard[], soft[]} 扩展。
 * 2. AI 生成标识: 按《生成式AI服务管理办法》/《深度合成管理规定》要求, 发布时文末追加标识
 *    (SYSTEM config.automationConfig.aiLabel: false 可关, 默认开)。
 * 注: 词库为技术兜底, 不构成法律意见; 客户行业(医学学术)广告法红线建议请专业人士复核扩充。
 */
import { eq, inArray } from "drizzle-orm";
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
const TITLE_DATA_CLAIM = /(?:审稿|外审|见刊|接收|录用率|命中率)[约仅低于\s]*\d+(?:\.\d+)?\s*(?:天|周|个月|月|%)/g;

// 7-20 补 IF/分区两维(信任红线)。原注释写"IF/分区等几乎必复现, 不查以免误伤" ——
//   这个前提**只对国际刊成立**: 国际刊 DB 有 IF, LLM 写的数字正文能复现, 所以不查没事;
//   国内刊 DB 根本没有 IF/分区(2746 本国内核心刊中 有IF 213 本=7.8%、有分区 8 本=0.3%),
//   LLM 只能凭空编, 而校验对它完全睁眼瞎。
//   生产实测(近30天): 国内刊 185 篇里 57 篇(31%)标题写了 DB 没有的 IF, 其中 40 篇 status=generated
//   可发布、6 篇已推送草稿/已发出。故补这两维, 走与审稿/录用率完全相同的机制, 不新造闸门。
// IF: "IF 2.0+" / "影响因子 3.5" / "IF：2.3" / "impact factor 4.1"
const TITLE_IF_CLAIM = /(?:IF|影响因子|impact\s*factor)\s*[:：]?\s*[约仅低于＜<]?\s*\d+(?:\.\d+)?\s*\+?/gi;
// 分区: "中科院1区" / "JCR Q2" / "Q1" / "一区" / "3区"
const TITLE_PARTITION_CLAIM = /(?:中科院\s*|JCR\s*)?(?:Q\s*[1-4]|[1-4一二三四]\s*区)/gi;
/**
 * 7-20 正文编造检测（评分器用）。
 *
 * 缺口背景: 今早补了**标题**编造校验(无据数字 → needs_review), 但**正文**编造无人管,
 *   而六维评分器反而在**奖励**它 —— 实测重打分时, 一篇标题写"IF9.0+1个月光速审稿、管理学报1区"
 *   的国内刊文章拿到 78 分(全样本第二高), 正因为编出来的数字让"数据准确/信息密度"看起来达标。
 *   → 校验拦它转人工, 评分器却给它高分, 闭环是漏的。本函数补上正文这一侧。
 *
 * 判据与标题侧**完全一致**(复用同三条正则 + 同一套 DB 有无判断, 不新造标准):
 *   DB 该字段为空 = 该刊客观没有这个指标 = 正文里出现的数字必然无源。
 *   同样用"键是否存在"决定要不要查, 调用方没提供该字段就跳过, 不臆断。
 *
 * ⚠️ 只查 IF / 分区 两类。**刻意不查正文里的审稿周期/录用率数字** ——
 *   正文常有"中文核心审稿普遍 6-12 个月"这类**行业通论**(不是对本刊的断言), 查了会大量误伤;
 *   而 IF / 分区 是刊级专属指标, 正文里出现就是在说这本刊, 无源即编造, 判定干净。
 *   标题侧仍然全查四类(标题短、必然指向本刊, 无此歧义)。
 */
export function findBodyFabrication(
  body: string | null | undefined,
  db?: TitleDataDbFields,
): string[] {
  if (!db || !body) return [];
  const plain = body.replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ");
  const hits: string[] = [];
  if ("impactFactor" in db || "compositeImpactFactor" in db) {
    if (db.impactFactor == null && db.compositeImpactFactor == null) {
      for (const c of [...new Set(plain.match(TITLE_IF_CLAIM) || [])]) hits.push(`${c.trim()}(DB无影响因子)`);
    }
  }
  if ("partition" in db || "casPartition" in db || "casPartitionNew" in db || "jcrFull" in db) {
    if (!(db.partition || db.casPartition || db.casPartitionNew || db.jcrFull)) {
      for (const c of [...new Set(plain.match(TITLE_PARTITION_CLAIM) || [])]) hits.push(`${c.trim()}(DB无分区)`);
    }
  }
  return hits;
}

/**
 * 7-25 多刊事实并集 —— roundup(多刊盘点)编造检测用。
 *
 * 语义: 把 N 本刊的 DB 事实压成"一本虚拟刊", 再交给 findBodyFabrication 判 ——
 *   **不新造判据**, 完全复用单刊那套(与全系统一致的"键存在才查, 值为空才算编造")。
 *
 * 两条规则:
 *   ① **键的存在性取并集**: 只要有一本刊提供了该键, 结果就带这个键(=可以查);
 *      没有任何一本提供 → 键缺席 → 校验跳过(不臆断)。
 *   ② **值取"任一非空"**: 只要有一本刊有真 IF/分区, 并集就算"有" → 正文里的
 *      IF/分区数字视为有源, 放行。
 *
 * 为什么是"任一"而不是"逐刊就近匹配": 盘点正文里"XX刊 IF 3.2"与刊名的绑定关系,
 *   经 LLM 改写 + HTML 模板重排后已不可靠(刊名被 《》 包裹/简称/改写), 就近匹配会产生
 *   大量误判 —— 而误判正是 6577b9a 被回滚的原因。"任一"是保守侧: 绝不新增误伤,
 *   只抓最高危也最干净的一类 —— **全部相关刊都没有 IF/分区, 正文却写了数字**
 *   (纯国内刊盘点的典型编造形态)。代价是混合刊单里针对某一本的编造抓不到(见已知限制)。
 */
export function mergeJournalFacts(
  facts: Array<TitleDataDbFields | null | undefined>,
): TitleDataDbFields | undefined {
  const list = facts.filter((f): f is TitleDataDbFields => !!f);
  if (list.length === 0) return undefined;
  const KEYS = [
    "reviewCycle", "acceptanceRate", "impactFactor", "compositeImpactFactor",
    "partition", "casPartition", "casPartitionNew", "jcrFull",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    const provided = list.filter((f) => k in f);
    if (provided.length === 0) continue; // 无人提供该键 → 保持缺席, 校验跳过
    const hit = provided.find((f) => {
      const v = (f as Record<string, unknown>)[k];
      return v !== null && v !== undefined && v !== "";
    });
    out[k] = hit ? (hit as Record<string, unknown>)[k] : null;
  }
  return out as TitleDataDbFields;
}

/** 多刊版正文编造检测(roundup)。等价于"把 N 本刊并成一本"后跑 findBodyFabrication。 */
export function findBodyFabricationMulti(
  body: string | null | undefined,
  facts: Array<TitleDataDbFields | null | undefined>,
): string[] {
  return findBodyFabrication(body, mergeJournalFacts(facts));
}

const CN_CORE_TAGS_GATE = ["pku-core", "cssci", "cssci-ext", "cscd"];

/** 纯国内刊判定(与 article-skill 的 isPureDomesticJournal 同口径): 有中文核心标签且不含 sci-core。 */
function isPureDomesticCatalogs(catalogs: unknown): boolean {
  const cats = (catalogs as string[] | null) || [];
  return cats.some((c) => CN_CORE_TAGS_GATE.includes(c)) && !cats.includes("sci-core");
}

/**
 * 7-21 发布前编造硬闸(确定性兜底) — draft-distributor / publishToAccounts 共用。
 *
 * 定位: "prompt 降低 + 确定性兜底"里的确定性那半。生成侧 prompt 已把纯国内刊正文编造从 56% 压到
 *   ~13%, 但 prompt 有天花板(LLM 在卖点诱导下仍偶尔编 IF/分区)。这道闸让漏网的 13% 即使
 *   分数侥幸过线, 也**发不出去** —— 对外零编造。
 *
 * 只对**纯国内刊 + DB 无 IF/分区**生效:
 *   - 骑墙刊(catalogs 含 sci-core)**豁免** —— 它们分区可能是 enrichment 从 LetPub 抓的真数据(backlog-C),
 *     误挡有据内容正是 6577b9a 被回滚的原因。
 *   - 无中文核心标签的国际刊也不进(它们本就该有 IF/分区)。
 *   复用 findBodyFabrication(同一套判断), 不新写检测逻辑。
 *
 * 7-25 扩多刊(roundup 多刊盘点): 传 journalIds 即可。语义是单刊那套的保守推广 ——
 *   ① 只要**任一**相关刊不是纯国内刊(骑墙/国际) → 整篇豁免(沿用骑墙豁免, 绝不新增误挡);
 *   ② 全是纯国内刊时, 用 mergeJournalFacts 并集判(任一刊有真 IF/分区就放行)。
 *   单刊调用行为与 7-21 完全一致(rows 只有一行时 every === 原 isPureDomestic 判定)。
 *
 * @returns 命中的无据指标列表; 空 = 放行。调用方据此决定是否拦下 + 标 needs_review/body_fabrication。
 */
export async function checkBodyFabricationForPublish(content: {
  body?: string | null;
  journalId?: string | null;
  /** 7-25 多刊盘点(roundup): 本篇涉及的全部刊。与 journalId 可同时传, 内部去重。 */
  journalIds?: string[] | null;
}): Promise<string[]> {
  const ids = [...new Set([
    ...(Array.isArray(content.journalIds) ? content.journalIds : []),
    ...(content.journalId ? [content.journalId] : []),
  ].filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (!content.body || ids.length === 0) return [];
  const { journals } = await import("../../models/schema.js");
  const rows = await db
    .select({
      catalogs: journals.catalogs,
      impactFactor: journals.impactFactor,
      compositeImpactFactor: journals.compositeImpactFactor,
      partition: journals.partition,
      casPartition: journals.casPartition,
      casPartitionNew: journals.casPartitionNew,
      jcrFull: journals.jcrFull,
    })
    .from(journals)
    .where(inArray(journals.id, ids));
  if (rows.length === 0) return [];
  // 骑墙豁免 + 只管纯国内刊(多刊: 有一本骑墙/国际就整篇豁免)
  if (!rows.every((r) => isPureDomesticCatalogs(r.catalogs))) return [];
  return findBodyFabricationMulti(content.body, rows.map((j) => ({
    impactFactor: j.impactFactor, compositeImpactFactor: j.compositeImpactFactor,
    partition: j.partition, casPartition: j.casPartition, casPartitionNew: j.casPartitionNew, jcrFull: j.jcrFull,
  })));
}

/**
 * 标题的审稿周期/录用率具体数字校验。两道:
 *  ① DB 硬校验(最强): 传 db 时, 审稿数字要求 db.reviewCycle 非空、录用率数字要求 db.acceptanceRate 非空;
 *     字段 DB 为空 = 该数字必是编造(行4: 标题+正文都写"审稿60天/录用率35%"一致编造, 但 DB 两者皆空)。
 *  ② 正文复现(兜底, 未传 db 时): 标题数字须在正文出现(治标题-正文脱节, 行1)。
 */
/** 标题数字校验用的 DB 字段。7-20 扩 IF/分区两维(原仅 reviewCycle/acceptanceRate)。 */
export interface TitleDataDbFields {
  reviewCycle?: string | null;
  acceptanceRate?: number | null;
  impactFactor?: number | null;
  compositeImpactFactor?: number | null;
  /** 分区证据。⚠️ 实测(7-20)真正有数据的是 casPartitionNew(国际刊 2182 本)与 jcrFull(4158 本);
   *  partition 仅 32 本、casPartition **整列为空(0 行)** —— 只查前两者会把大量国际刊误判编造。 */
  partition?: string | null;
  casPartition?: string | null;
  casPartitionNew?: string | null;
  jcrFull?: unknown;
}

export function checkTitleDataConsistency(
  title: string | null | undefined,
  body: string | null | undefined,
  db?: TitleDataDbFields,
): { ok: boolean; mismatches: string[] } {
  const plainBody = (body || "").replace(/<[^>]+>/g, "");
  const claims = [...new Set((title || "").match(TITLE_DATA_CLAIM) || [])];
  const mismatches: string[] = [];
  for (const c of claims) {
    const m = c.match(/(\d+(?:\.\d+)?)\s*(天|周|个月|月|%)/);
    if (!m) continue;
    const [, num, unit] = m;
    const isAcceptance = unit === "%";
    // ① DB 硬校验: 字段空 → 编造
    if (db) {
      if (isAcceptance && db.acceptanceRate == null) { mismatches.push(`${c}(DB无录用率数据)`); continue; }
      if (!isAcceptance && !db.reviewCycle) { mismatches.push(`${c}(DB无审稿周期数据)`); continue; }
    }
    // ② 正文复现
    const unitAlt = unit === "月" || unit === "个月" ? "(?:个月|月)" : unit === "%" ? "%" : unit;
    if (!new RegExp(num.replace(".", "\\.") + "\\s*" + unitAlt).test(plainBody)) mismatches.push(`${c}(正文未复现)`);
  }

  // 7-20 IF/分区两维: **只做 DB 有无校验, 不做正文复现**。
  //   理由: 一致编造(标题正文都写 IF 2.0)对国内刊是常态 —— 正文本身就是 LLM 写的, 复现校验拦不住;
  //   而 DB 空 = 该刊客观没有这个指标 = 标题里的数字必然无源。不传 db 时跳过(退化为原行为, 不误伤)。
  //   ⚠️ 用"键是否存在"而非"值是否为 null"决定要不要查 —— 调用方若只传了
  //   { reviewCycle, acceptanceRate }（IF 字段整个缺席），说明它没提供 IF 信息，
  //   此时必须跳过，不能当成"DB 无 IF"去判编造，否则会把所有带 IF 的标题全误伤。
  //   (这些字段类型上都是可选的，TS 拦不住漏传；显式 in 判断是唯一可靠护栏。)
  if (db) {
    if ("impactFactor" in db || "compositeImpactFactor" in db) {
      const hasIf = db.impactFactor != null || db.compositeImpactFactor != null;
      if (!hasIf) {
        for (const c of [...new Set((title || "").match(TITLE_IF_CLAIM) || [])]) {
          mismatches.push(`${c.trim()}(DB无影响因子数据)`);
        }
      }
    }
    if ("partition" in db || "casPartition" in db || "casPartitionNew" in db || "jcrFull" in db) {
      const hasPartition = !!(db.partition || db.casPartition || db.casPartitionNew || db.jcrFull);
      if (!hasPartition) {
        for (const c of [...new Set((title || "").match(TITLE_PARTITION_CLAIM) || [])]) {
          mismatches.push(`${c.trim()}(DB无分区数据)`);
        }
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * 7-25 多刊盘点(roundup)编造检测 —— 生成期用。
 *
 * 缺口: roundup 不走 batch-worker / quality-pipeline(那两处才有 journalId → journalFacts 的接线),
 *   于是三道编造闸对它**全部空转**: findBodyFabrication 无 facts 直接 return []、
 *   checkTitleDataConsistency 无 dbFields 退化成"正文复现"(而正文也是同一个 LLM 写的, 拦不住
 *   一致编造)、发布期硬闸查不到 journalId 直接放行。而 roundup 每天在产, 一篇说 3 本刊,
 *   是编 IF/分区风险最高的形态之一。
 *
 * 判定 = 单刊那套的多刊保守推广, **不新造标准**:
 *   ① 骑墙豁免(与发布硬闸同口径): 任一相关刊不是纯国内刊 → 整篇跳过。
 *      roundup 选刊直接读 DB、**不跑 enrichment**, 所以骑墙刊在这里必然是"DB 空但实际有数据",
 *      查了就是 6577b9a 的覆辙(把有据当编造)。宁可漏, 不可误伤。
 *   ② 全纯国内刊时: 用 mergeJournalFacts 并集 → 复用 checkTitleDataConsistency(标题四维)
 *      + findBodyFabrication(正文 IF/分区两维)。
 */
export async function checkRoundupFabrication(content: {
  title?: string | null;
  body?: string | null;
  journalIds?: string[] | null;
}): Promise<{ ok: boolean; mismatches: string[]; checked: boolean }> {
  const ids = [...new Set((content.journalIds ?? []).filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (ids.length === 0 || !content.body) return { ok: true, mismatches: [], checked: false };
  try {
    const { journals } = await import("../../models/schema.js");
    const rows = await db
      .select({
        catalogs: journals.catalogs,
        reviewCycle: journals.reviewCycle,
        acceptanceRate: journals.acceptanceRate,
        impactFactor: journals.impactFactor,
        compositeImpactFactor: journals.compositeImpactFactor,
        partition: journals.partition,
        casPartition: journals.casPartition,
        casPartitionNew: journals.casPartitionNew,
        jcrFull: journals.jcrFull,
      })
      .from(journals)
      .where(inArray(journals.id, ids));
    if (rows.length === 0) return { ok: true, mismatches: [], checked: false };
    // ① 骑墙豁免
    if (!rows.every((r) => isPureDomesticCatalogs(r.catalogs))) return { ok: true, mismatches: [], checked: false };
    // ② 并集判定
    const facts = rows.map((r) => ({
      reviewCycle: r.reviewCycle, acceptanceRate: r.acceptanceRate,
      impactFactor: r.impactFactor, compositeImpactFactor: r.compositeImpactFactor,
      partition: r.partition, casPartition: r.casPartition, casPartitionNew: r.casPartitionNew, jcrFull: r.jcrFull,
    }));
    const merged = mergeJournalFacts(facts);
    const mismatches = [
      ...checkTitleDataConsistency(content.title, content.body, merged).mismatches,
      ...findBodyFabrication(content.body, merged),
    ];
    return { ok: mismatches.length === 0, mismatches: [...new Set(mismatches)], checked: true };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "roundup 编造检测异常, 放行(不阻塞每日生成)");
    return { ok: true, mismatches: [], checked: false };
  }
}

/**
 * 发布期数据编造硬闸决策（纯函数，复用 checkTitleDataConsistency）。
 * 仅对生成期已标 needs_review / hasWarnings 的内容生效；标题审稿周期/录用率数字无 DB 支撑 = 编造。
 * 同客服线 findUnsourcedNumbers 哲学：LLM 嘴里的数字必须有源。DB 查询留调用方（本函数纯）。
 * @returns action: pass(放行) | block(拒发) | override(forceOverride 强发, 调用方须落审计); mismatches 列无源数字
 */
export function fabricationPublishGate(opts: {
  status?: string | null;
  hasWarnings?: boolean;
  title?: string | null;
  body?: string | null;
  dbFields?: TitleDataDbFields;
  forceOverride?: boolean;
}): { action: "pass" | "block" | "override"; mismatches: string[] } {
  const flagged = opts.status === "needs_review" || opts.hasWarnings === true;
  if (!flagged) return { action: "pass", mismatches: [] }; // 正常内容零触发, 保证零回归
  const td = checkTitleDataConsistency(opts.title, opts.body, opts.dbFields);
  if (td.ok) return { action: "pass", mismatches: [] };
  return { action: opts.forceOverride ? "override" : "block", mismatches: td.mismatches };
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
