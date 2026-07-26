/**
 * 期刊数据补充采集器（V6 — Scrapling 优先）
 *
 * 数据采集优先级：
 *   1. Scrapling Python 爬虫（LetPub + Springer，绕过反爬）
 *   2. Springer Meta API（快速但数据有限）
 *   3. AI 知识补充（兜底）
 *
 * 结果缓存到 journals 表。
 */

import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { eq } from "drizzle-orm";
import { scrapeJournal, type ScraplingResult } from "./scrapling-bridge.js";
import { validateTrustedFacts, type TrustedFactsValidation } from "./trusted-facts-validator.js";

export interface SpringerJournalData {
  abbreviation?: string;
  foundingYear?: number;
  country?: string;
  website?: string;
  apcFee?: number;
  selfCitationRate?: number;
  casPartition?: string;
  casPartitionNew?: string;
  jcrSubjects?: string; // JSON
  topInstitutions?: string; // JSON
  scopeDescription?: string;
  // Scrapling 额外字段（可选，用于回写更多数据）
  impactFactor?: number;
  partition?: string;
  acceptanceRate?: number;
  reviewCycle?: string;
  annualVolume?: number;
  isWarningList?: boolean;
  /**
   * 7-25 加固: 抓取源给出的刊名。**只做解析健康度探针, 永不入库**
   * (不在 TRUSTED_FACT_FIELDS 白名单, 也不在老缓存写的 updateFields 里)。
   * 事故里 name="按研究方向查看:" 是"整页选择器错位"最灵敏的指示器。
   */
  sourceName?: string;
}

/**
 * 通过 Scrapling 爬取 LetPub + Springer 数据
 * 这是 V6 主要的数据源
 */
export async function fetchViaScrapling(
  journalName: string,
  issn?: string
): Promise<SpringerJournalData | null> {
  try {
    const result = await scrapeJournal({
      name: journalName,
      issn,
      stealthy: false, // 先用快速模式，失败了再 stealthy
      timeoutMs: 30_000,
    });

    if (!result) {
      // 快速模式失败，尝试 StealthySession
      logger.info({ journalName }, "Scrapling 快速模式无结果，尝试 StealthySession");
      const stealthyResult = await scrapeJournal({
        name: journalName,
        issn,
        stealthy: true,
        timeoutMs: 60_000,
      });

      if (!stealthyResult) return null;
      return scraplingToSpringerData(stealthyResult);
    }

    return scraplingToSpringerData(result);
  } catch (err) {
    logger.warn({ err, journalName }, "Scrapling 爬虫调用失败");
    return null;
  }
}

/** 将 Scrapling 结果映射为 SpringerJournalData */
function scraplingToSpringerData(data: ScraplingResult): SpringerJournalData {
  return {
    website: data.website || undefined,
    apcFee: data.apcFee || undefined,
    selfCitationRate: data.selfCitationRate || undefined,
    casPartition: data.casPartition || undefined,
    scopeDescription: data.scopeDescription || undefined,
    // 额外字段——可以回写到 journals 表
    impactFactor: data.impactFactor || undefined,
    partition: data.partition || undefined,
    acceptanceRate: data.acceptanceRate || undefined,
    reviewCycle: data.reviewCycle || undefined,
    annualVolume: data.annualVolume || undefined,
    isWarningList: data.isWarningList,
    // 7-25: 带上刊名做解析健康度探针(不入库), 见 SpringerJournalData.sourceName
    sourceName: data.name || undefined,
  };
}

/**
 * 从 Springer Meta API 抓取期刊补充数据（备用方案）
 */
export async function fetchSpringerJournalData(
  journalName: string,
  issn?: string
): Promise<SpringerJournalData | null> {
  try {
    let url: string;
    if (issn) {
      url = `https://api.springernature.com/meta/v2/json?q=issn:${issn}&p=1&s=1`;
    } else {
      url = `https://api.springernature.com/meta/v2/json?q=journal:"${encodeURIComponent(journalName)}"&p=1&s=1`;
    }

    const res = await fetch(url, {
      headers: { "User-Agent": "BossMate/1.0 (Academic Research)" },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.debug({ status: res.status, journalName }, "Springer API 请求失败");
      return null;
    }

    const data = await res.json() as any;
    if (!data?.records?.length) return null;

    const record = data.records[0];
    const journalUrl = record?.url?.[0]?.value || "";

    return {
      website: journalUrl || undefined,
    };
  } catch (err) {
    logger.debug({ err, journalName }, "Springer API 采集失败");
    return null;
  }
}

/**
 * 用 AI 补充期刊详细信息（兜底方案）
 */
export async function enrichJournalWithAI(
  provider: any,
  journal: {
    name: string;
    nameEn?: string | null;
    issn?: string | null;
    impactFactor?: number | null;
    partition?: string | null;
    discipline?: string | null;
    publisher?: string | null;
  }
): Promise<SpringerJournalData> {
  try {
    const result = await provider.chat({
      messages: [
        {
          role: "system",
          content: `你是学术期刊数据库专家。根据期刊名称，提供其详细信息。只输出你确定的信息，不确定的字段输出 null。
输出纯 JSON，不要 markdown 包裹：
{
  "abbreviation": "期刊简称（如 EHO、JHO 等）",
  "website": "期刊官方网站URL",
  "selfCitationRate": 自引率百分比数字,
  "casPartition": "中科院大类分区（如 医学2区）",
  "casPartitionNew": "中科院新锐分区（如 医学1区TOP）",
  "jcrSubjects": [{"subject":"学科名","rank":"Q1","position":"9/100"}],
  "topInstitutions": ["机构1","机构2","机构3"]
}

##禁止字段## (PR #169 + #170: 0 真源, 你之前编了 1976/英国/APC 1000 等假数据被 validator 拦截)
- 严禁返回 foundingYear / country / apcFee, JSON 中不要包含这三个 key
- 即使你认为知道该期刊真实创刊年/出版国/版面费, 也不要返 (BossMate 不信任 AI 推测这 3 字段)`,
        },
        {
          role: "user",
          content: `期刊名称：${journal.name}
${journal.nameEn ? `英文名：${journal.nameEn}` : ""}
${journal.issn ? `ISSN：${journal.issn}` : ""}
${journal.impactFactor ? `影响因子：${journal.impactFactor}` : ""}
${journal.partition ? `分区：${journal.partition}` : ""}
${journal.discipline ? `学科：${journal.discipline}` : ""}
${journal.publisher ? `出版商：${journal.publisher}` : ""}

请提供该期刊的详细信息。`,
        },
      ],
      temperature: 0.2,
      maxTokens: 1024,
    });

    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]);

    // 5-23 PR #169 / 5-19 PR #170: AI 模型可能"自作主张"仍返禁字段, 防御性 strip + warn log
    if (parsed && parsed.foundingYear !== undefined && parsed.foundingYear !== null) {
      logger.warn({ journal: journal.name, raw: parsed.foundingYear }, "PR #169: AI 自作主张返 foundingYear, 已 strip");
      delete parsed.foundingYear;
    }
    if (parsed && parsed.country !== undefined && parsed.country !== null) {
      logger.warn({ journal: journal.name, raw: parsed.country }, "PR #169: AI 自作主张返 country, 已 strip");
      delete parsed.country;
    }
    if (parsed && parsed.apcFee !== undefined && parsed.apcFee !== null) {
      logger.warn({ journal: journal.name, raw: parsed.apcFee }, "PR #170: AI 自作主张返 apcFee, 已 strip");
      delete parsed.apcFee;
    }

    return {
      abbreviation: parsed.abbreviation || undefined,
      // PR #169: foundingYear / country 砍 / PR #170: apcFee 砍 (全 0 真源, AI 编 100%, template 已 NULL safe)
      website: parsed.website || undefined,
      selfCitationRate: typeof parsed.selfCitationRate === "number" ? parsed.selfCitationRate : undefined,
      casPartition: parsed.casPartition || undefined,
      casPartitionNew: parsed.casPartitionNew || undefined,
      jcrSubjects: parsed.jcrSubjects ? JSON.stringify(parsed.jcrSubjects) : undefined,
      topInstitutions: parsed.topInstitutions ? JSON.stringify(parsed.topInstitutions) : undefined,
    };
  } catch (err) {
    logger.warn({ err, journal: journal.name }, "AI 补充期刊数据失败");
    return {};
  }
}

// ============ 7-25 backlog-C: enrichment 可信数据回写 journals 表 ============

/**
 * **信任字段**回写白名单 —— 精确等于事后校验器(content-check 的 findBodyFabrication /
 *   checkTitleDataConsistency / quality-check-v2 的 journalFacts)会读的那几列。
 *
 * 选这个集合而不是"能抓到的都写"的理由: backlog-C 的病根是**供数源(enrichment 实时抓)
 *   与校验源(DB 快照)不一致**, 治病只需让这两个集合对齐; 回写面每多一列, 污染面就多一分。
 *   其余列(annualVolume / selfCitationRate / isWarningList / scopeDescription …)不在
 *   校验器视野内, 不属于本问题域, 留给 journal-enricher orchestrator 的正规富化路径写。
 *
 * ⚠️ casPartitionNew **故意不在**白名单: scraplingToSpringerData() 根本不产这个字段,
 *   SpringerJournalData.casPartitionNew 的唯一来源是 enrichJournalWithAI() —— 即 AI 猜的。
 *   写它 = 把 AI 幻觉洗成"DB 权威值", 会让校验器反过来给编造背书, 比现在的误判严重得多。
 */
const TRUSTED_FACT_FIELDS = [
  "impactFactor", "partition", "casPartition", "acceptanceRate", "reviewCycle",
] as const;
type TrustedFactField = (typeof TRUSTED_FACT_FIELDS)[number];

/** DB 侧对应列(drizzle camelCase key 与 TRUSTED_FACT_FIELDS 同名, 这里只做类型收敛)。 */
const TRUSTED_FACT_COLUMNS = {
  impactFactor: journals.impactFactor,
  partition: journals.partition,
  casPartition: journals.casPartition,
  acceptanceRate: journals.acceptanceRate,
  reviewCycle: journals.reviewCycle,
} as const;

/** 回写来源标记(写进 field_provenance)。区别于 orchestrator 的 "letpub"(离线正规富化)。 */
export const INLINE_ENRICH_PROVENANCE = "letpub_inline_enrich";

export interface TrustedFactsWriteBackResult {
  /** 实际写入的字段(空数组 = 全部已有值/无新数据/被拒/开关关闭, 无 UPDATE 发生) */
  written: TrustedFactField[];
  /** 因 DB 已有值而跳过的字段(用于日志观察, 证明"不覆盖") */
  skippedExisting: TrustedFactField[];
  /** 没写的原因(写成功时不带此字段): disabled=开关未开; rejected=护栏拒写 */
  skipped?: "disabled" | "rejected";
  /** skipped="rejected" 时带上完整校验结果, 便于调用方/测试断言 */
  validation?: TrustedFactsValidation;
}

/**
 * 7-25 事故后的**默认关闭**开关。
 *
 * ⚠️ **上游 LetPub 选择器 2026-07 已失效**(journal_scraper.py 抓回 impactFactor=2026 的年份、
 *    name="按研究方向查看:" 的导航文案), scrapling 也已卸载。**重写并验证选择器之前不要打开。**
 *    打开前先确认 validateTrustedFacts 能拦住异常值(单测: trusted-facts-guardrail.test.ts)。
 *
 * 为什么用"代码留着 + 默认关"而不是删掉: backlog-C(供数源与校验源不一致 → 骑墙刊被三道闸误判)
 *   是真问题, 回写是正确解法; 错的只是"在上游已经坏了的时候启用它"。删了下次还得重写一遍, 留着
 *   并锁死开关, 等 LetPub 抓取重写验证通过后一行 env 即可启用。
 *
 * 与 ENRICH_SKIP_LETPUB 同族: 运行时直读 process.env, **不进 env.ts 的 zod schema**
 *   (见 .env.example 第 17 节的说明与其代价)。每次调用现读, 便于测试与线上热改后重启生效。
 */
export function isWriteBackEnabled(): boolean {
  return process.env.ENRICH_WRITEBACK_ENABLED === "true";
}

/** 拒写告警的进程内节流窗口(见 persistTrustedJournalFacts 里的用法) */
const REJECT_ALERT_COOLDOWN_MS = 10 * 60_000;
let lastRejectAlertAt = 0;
let suppressedRejectAlerts = 0;
/** 仅供单测重置节流状态(线上没有调用方) */
export function __resetWriteBackAlertThrottle(): void {
  lastRejectAlertAt = 0;
  suppressedRejectAlerts = 0;
}

/**
 * 把 enrichment 抓到的**可信源**指标回写 journals 表(backlog-C 治本)。
 *
 * 三条铁律:
 *   ① **只收可信源**: 入参必须是 scrapling(LetPub/Springer) 那一层的原始结果, 调用方负责
 *      在 merge AI 兜底数据**之前**取快照。AI 猜的值一律不得进来(见 TRUSTED_FACT_FIELDS 注释)。
 *      OpenAlex 同理不走这条路 —— 它的近似 IF/分区按老韩 7-09 判定禁入信任字段。
 *   ② **只填空, 绝不覆盖**: 逐字段读当前 DB 值, 非空即跳过。人工核实值 / manual_seed /
 *      multi_source_verified / orchestrator 写过的值全都动不了。天然幂等(第二次跑写 0 字段)。
 *   ③ **打来源标记**: field_provenance.<字段> = "letpub_inline_enrich", 与 orchestrator 的
 *      "letpub" 区分, 事后可审计/可回滚。**不动 dataSource / confidence** —— 本路径只有单源,
 *      写 dataSource 会把 multi_source_verified 降级成 letpub_only, 那是污染不是治理。
 *
 * 7-25 事故后追加的**第 4、5 条**(它们比上面三条更靠前, 是能不能启用回写的前提):
 *   ④ **合理性护栏**: 写之前跑 validateTrustedFacts。任一字段不合理 → **整条拒写**(绝不部分
 *      写入) + logger.error + 落 ops_incidents(kind=enrich_writeback_rejected) 让次日简报报出来。
 *      理由: 抓取失败是常态, 而回写会把"一次抓取失败"升级成"永久数据污染"并让三道防编造闸失效。
 *   ⑤ **默认关闭**: isWriteBackEnabled() 为假时只校验不落笔(影子模式)。
 *      注意顺序 —— **校验在开关之前**: 开关关着也照样跑校验并告警, 这样"上游到底修好没有"能被
 *      日常运行自动探出来, 而不是等哪天有人壮着胆子打开开关才发现还是坏的。
 *
 * 失败不抛(生成链路绝不能被回写拖挂), 返回写了什么。
 */
export async function persistTrustedJournalFacts(
  journalId: string,
  trusted: SpringerJournalData | null | undefined,
): Promise<TrustedFactsWriteBackResult> {
  const empty: TrustedFactsWriteBackResult = { written: [], skippedExisting: [] };
  if (!journalId || journalId === "skip-cache" || !trusted) return empty;

  // 先看这次抓到了哪些候选值(非空才算)
  const candidates = TRUSTED_FACT_FIELDS.filter((f) => {
    const v = (trusted as Record<string, unknown>)[f];
    return v !== null && v !== undefined && v !== "";
  });
  if (candidates.length === 0) return empty;

  // ④ 护栏: 不合理 → 整条拒写 + 告警。sourceName 探针也参与判定(它本身不入库)。
  const validation = validateTrustedFacts(trusted as Parameters<typeof validateTrustedFacts>[0]);
  if (!validation.ok) {
    logger.error(
      {
        journalId,
        rejected: validation.rejected,
        checked: validation.checked,
        drift: validation.drift,
        writeBackEnabled: isWriteBackEnabled(),
      },
      validation.drift
        ? "疑似上游解析漂移, 已拒绝回写(整条, 不部分写入) —— 多字段同时异常, LetPub 选择器很可能已失效"
        : "字段值不合理, 已拒绝回写(整条, 不部分写入)",
    );
    // 告警旁路: 落 ops_incidents → 次日 09:30 运营简报。绝不阻塞、绝不抛。
    // 节流: 上游一旦坏掉, 每篇生成都会命中 —— 不限速会把 ops_incidents 刷屏, 把别的告警淹了。
    //   进程内 10 分钟一条, 并把这期间被压掉的次数带上(信息不丢, 只是不逐条落库)。
    const now = Date.now();
    if (now - lastRejectAlertAt < REJECT_ALERT_COOLDOWN_MS) {
      suppressedRejectAlerts += 1;
    } else {
      const suppressed = suppressedRejectAlerts;
      lastRejectAlertAt = now;
      suppressedRejectAlerts = 0;
      void import("../ops/incidents.js")
        .then((m) => m.recordIncident({
          kind: "enrich_writeback_rejected",
          severity: validation.drift ? "error" : "warn",
          message: `期刊回写被护栏拒绝(${validation.drift ? "疑似解析漂移" : "单字段异常"}): ${validation.reason}`.slice(0, 500),
          detail: { journalId, rejected: validation.rejected, checked: validation.checked, drift: validation.drift, suppressedSinceLastAlert: suppressed },
        }))
        .catch(() => { /* 告警链路自己挂了不能反过来搞挂生成 */ });
    }
    return { written: [], skippedExisting: [], skipped: "rejected", validation };
  }

  // ⑤ 开关: 默认 false。校验已在上面跑过(影子模式), 这里只是不落笔。
  if (!isWriteBackEnabled()) {
    logger.debug(
      { journalId, candidates },
      "回写开关未开(ENRICH_WRITEBACK_ENABLED != true), 数据校验通过但不入库",
    );
    return { written: [], skippedExisting: [], skipped: "disabled" };
  }

  try {
    const [existing] = await db
      .select({ ...TRUSTED_FACT_COLUMNS, fieldProvenance: journals.fieldProvenance })
      .from(journals)
      .where(eq(journals.id, journalId))
      .limit(1);
    if (!existing) return empty;

    const written: TrustedFactField[] = [];
    const skippedExisting: TrustedFactField[] = [];
    const updateFields: Record<string, unknown> = {};
    for (const f of candidates) {
      const cur = (existing as Record<string, unknown>)[f];
      // 铁律②: 只填空。0 视为"有值"(录用率 0 也是数据), 只有 null/undefined/"" 算空。
      if (cur !== null && cur !== undefined && cur !== "") { skippedExisting.push(f); continue; }
      updateFields[f] = (trusted as Record<string, unknown>)[f];
      written.push(f);
    }
    if (written.length === 0) return { written, skippedExisting };

    const provenance = {
      ...((existing.fieldProvenance as Record<string, string> | null) ?? {}),
      ...Object.fromEntries(written.map((f) => [f, INLINE_ENRICH_PROVENANCE])),
    };
    await db.update(journals)
      .set({ ...updateFields, fieldProvenance: provenance, updatedAt: new Date() })
      .where(eq(journals.id, journalId));
    logger.info(
      { journalId, written, skippedExisting, provenance: INLINE_ENRICH_PROVENANCE },
      "backlog-C 回写: enrichment 可信指标已入库(只填空/不覆盖)"
    );
    return { written, skippedExisting };
  } catch (err) {
    logger.warn({ err, journalId }, "backlog-C 回写失败(不阻塞生成)");
    return empty;
  }
}

/**
 * 补充并缓存期刊数据到 DB
 *
 * 采集优先级：
 *   1. Scrapling（LetPub + Springer 完整爬取）
 *   2. Springer Meta API（快速备用）
 *   3. AI 知识补充（兜底）
 *
 * @param journalId - journals 表的 UUID，传 "skip-cache" 跳过 DB 写入
 * @param options.writeBackJournalId - 7-25 backlog-C: 传真实 journalId 时, 把**可信源**(scrapling,
 *   不含 AI 兜底)抓到的 IF/分区/录用率/审稿周期以"只填空"方式回写该刊。生成热路径专用 ——
 *   article-skill 仍传 journalId="skip-cache"(不走上面那条全量覆盖式老缓存), 只开这条窄回写。
 *   ⚠️ 传了也未必写: 回写受 ENRICH_WRITEBACK_ENABLED(**默认 false**) + validateTrustedFacts
 *   护栏双重把关, 见 isWriteBackEnabled / persistTrustedJournalFacts 的注释。
 */
export async function ensureJournalEnriched(
  journalId: string,
  journal: {
    name: string;
    nameEn?: string | null;
    issn?: string | null;
    impactFactor?: number | null;
    partition?: string | null;
    discipline?: string | null;
    publisher?: string | null;
  },
  provider?: any,
  options?: { writeBackJournalId?: string | null }
): Promise<SpringerJournalData> {
  let data: SpringerJournalData | null = null;

  // 第一优先：Scrapling 爬虫（LetPub + Springer 完整数据）
  data = await fetchViaScrapling(journal.name, journal.issn || undefined);

  // 第二优先：Springer Meta API
  if (!data || (!data.apcFee && !data.selfCitationRate && !data.scopeDescription)) {
    const springerData = await fetchSpringerJournalData(journal.name, journal.issn || undefined);
    if (springerData) {
      data = { ...(data || {}), ...springerData };
    }
  }

  // 7-25 backlog-C: **在 AI 兜底 merge 之前**扣下可信源快照。
  //   AI 那一步会往同一个对象里塞 casPartition 等猜测值, merge 后就再也分不出哪些是爬来的、
  //   哪些是编的 —— 回写只认这份快照。
  const trusted: SpringerJournalData = { ...(data || {}) };

  // 第三优先：AI 补充（abbreviation、foundingYear 等 Scrapling 拿不到的字段）
  if (provider && (!data || !data.abbreviation)) {
    const aiData = await enrichJournalWithAI(provider, journal);
    // AI 数据优先级最低——只补充空缺字段
    data = { ...aiData, ...(data || {}) };
  }

  // 7-25 backlog-C 回写(骑墙刊治本): 只写可信源、只填空、打 provenance。失败不阻塞。
  if (options?.writeBackJournalId) {
    await persistTrustedJournalFacts(options.writeBackJournalId, trusted);
  }

  if (!data || Object.keys(data).length === 0) return {};

  // 写入 DB 缓存（跳过 "skip-cache"）
  if (journalId && journalId !== "skip-cache") {
    try {
      const updateFields: Record<string, any> = {
        springerFetchedAt: new Date(),
        updatedAt: new Date(),
      };
      if (data.abbreviation) updateFields.abbreviation = data.abbreviation;
      if (data.foundingYear) updateFields.foundingYear = data.foundingYear;
      if (data.country) updateFields.country = data.country;
      // PR #180 fix: website 只在 DB 无值时写入, 不覆盖已有正确官网 (防 Springer 登录 URL 覆写)
      if (data.website) {
        const [existing] = await db.select({ website: journals.website }).from(journals).where(eq(journals.id, journalId)).limit(1);
        if (!existing?.website) updateFields.website = data.website;
      }
      if (data.apcFee) updateFields.apcFee = data.apcFee;
      if (data.jcrSubjects) updateFields.jcrSubjects = data.jcrSubjects;
      if (data.topInstitutions) updateFields.topInstitutions = data.topInstitutions;
      if (data.scopeDescription) updateFields.scopeDescription = data.scopeDescription;
      // 7-25 排雷: 指标类字段一律只认可信源 trusted, 不认 AI 兜底的 data ——
      //   casPartition / casPartitionNew / selfCitationRate 在 AI 分支里是"模型猜的",
      //   老写法把它们直写信任列 = 用幻觉污染唯一真相源。
      //   (当前唯一调用方传的是 "skip-cache", 这段是历史遗留的哑弹, 顺手拆掉引信。)
      // 7-25 事故后再加固: 这条**老路径**是第二扇门 —— 它比 persistTrustedJournalFacts 还粗暴
      //   (直接覆盖, 连"只填空"都没有)。同样过一遍护栏, 不合理就整块指标不写, 只留 website /
      //   scopeDescription 这类非指标字段。否则将来谁传个真 journalId 进来, 假 IF 照样进库。
      const legacyCheck = validateTrustedFacts(trusted as Parameters<typeof validateTrustedFacts>[0]);
      if (!legacyCheck.ok) {
        logger.error(
          { journalId, rejected: legacyCheck.rejected, drift: legacyCheck.drift },
          "疑似上游解析漂移, 已拒绝回写(老缓存路径的指标字段整块跳过)",
        );
      } else if (isWriteBackEnabled()) {
        if (trusted.selfCitationRate) updateFields.selfCitationRate = trusted.selfCitationRate;
        if (trusted.casPartition) updateFields.casPartition = trusted.casPartition;
        // Scrapling 可能拿到更新的 IF/分区/录用率，也回写
        if (trusted.impactFactor) updateFields.impactFactor = trusted.impactFactor;
        if (trusted.partition) updateFields.partition = trusted.partition;
        if (trusted.acceptanceRate) updateFields.acceptanceRate = trusted.acceptanceRate;
        if (trusted.reviewCycle) updateFields.reviewCycle = trusted.reviewCycle;
        if (trusted.annualVolume) updateFields.annualVolume = trusted.annualVolume;
        if (trusted.isWarningList !== undefined) updateFields.isWarningList = trusted.isWarningList;
      }

      await db.update(journals).set(updateFields).where(eq(journals.id, journalId));
      logger.info(
        { journalId, journal: journal.name, fields: Object.keys(updateFields).length },
        "期刊补充数据已缓存"
      );
    } catch (err) {
      logger.warn({ err, journalId }, "期刊补充数据写入失败");
    }
  }

  return data;
}
