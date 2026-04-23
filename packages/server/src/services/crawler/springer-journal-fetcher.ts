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
  "foundingYear": 创刊年份数字,
  "country": "出版国家（如 英国、美国、荷兰）",
  "website": "期刊官方网站URL",
  "apcFee": APC费用美元数字,
  "selfCitationRate": 自引率百分比数字,
  "casPartition": "中科院大类分区（如 医学2区）",
  "casPartitionNew": "中科院新锐分区（如 医学1区TOP）",
  "jcrSubjects": [{"subject":"学科名","rank":"Q1","position":"9/100"}],
  "topInstitutions": ["机构1","机构2","机构3"]
}`,
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
    return {
      abbreviation: parsed.abbreviation || undefined,
      foundingYear: typeof parsed.foundingYear === "number" ? parsed.foundingYear : undefined,
      country: parsed.country || undefined,
      website: parsed.website || undefined,
      apcFee: typeof parsed.apcFee === "number" ? parsed.apcFee : undefined,
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

/**
 * 补充并缓存期刊数据到 DB
 *
 * 采集优先级：
 *   1. Scrapling（LetPub + Springer 完整爬取）
 *   2. Springer Meta API（快速备用）
 *   3. AI 知识补充（兜底）
 *
 * @param journalId - journals 表的 UUID，传 "skip-cache" 跳过 DB 写入
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
  provider?: any
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

  // 第三优先：AI 补充（abbreviation、foundingYear 等 Scrapling 拿不到的字段）
  if (provider && (!data || !data.abbreviation)) {
    const aiData = await enrichJournalWithAI(provider, journal);
    // AI 数据优先级最低——只补充空缺字段
    data = { ...aiData, ...(data || {}) };
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
      if (data.website) updateFields.website = data.website;
      if (data.apcFee) updateFields.apcFee = data.apcFee;
      if (data.selfCitationRate) updateFields.selfCitationRate = data.selfCitationRate;
      if (data.casPartition) updateFields.casPartition = data.casPartition;
      if (data.casPartitionNew) updateFields.casPartitionNew = data.casPartitionNew;
      if (data.jcrSubjects) updateFields.jcrSubjects = data.jcrSubjects;
      if (data.topInstitutions) updateFields.topInstitutions = data.topInstitutions;
      if (data.scopeDescription) updateFields.scopeDescription = data.scopeDescription;
      // Scrapling 可能拿到更新的 IF/分区/录用率，也回写
      if (data.impactFactor) updateFields.impactFactor = data.impactFactor;
      if (data.partition) updateFields.partition = data.partition;
      if (data.acceptanceRate) updateFields.acceptanceRate = data.acceptanceRate;
      if (data.reviewCycle) updateFields.reviewCycle = data.reviewCycle;
      if (data.annualVolume) updateFields.annualVolume = data.annualVolume;
      if (data.isWarningList !== undefined) updateFields.isWarningList = data.isWarningList;

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
