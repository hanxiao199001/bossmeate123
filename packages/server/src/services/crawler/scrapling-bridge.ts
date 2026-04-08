/**
 * Scrapling Python 桥接模块
 *
 * 通过 child_process 调用 Python Scrapling 爬虫脚本，
 * 返回结构化的期刊数据（LetPub + Springer 合并结果）。
 *
 * 数据流：Node.js → child_process.execFile → journal_scraper.py → JSON stdout → Node.js
 */

import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../config/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Python 脚本路径（相对于 packages/server/src/services/crawler/ → ../../scripts/）
const SCRAPER_SCRIPT = resolve(__dirname, "../../../scripts/journal_scraper.py");

/** Python 脚本爬取的原始数据 */
export interface ScraplingResult {
  // LetPub 字段
  name?: string;
  nameEn?: string;
  issn?: string;
  publisher?: string;
  discipline?: string;
  partition?: string;
  impactFactor?: number;
  acceptanceRate?: number;
  reviewCycle?: string;
  annualVolume?: number;
  isWarningList?: boolean;
  isOA?: boolean;
  casPartition?: string;
  selfCitationRate?: number;
  chineseRatio?: string;
  letpub_id?: string;

  // Springer 字段
  apcFee?: number;
  citeScore?: number;
  timeToFirstDecision?: string;
  submissionToAcceptance?: string;
  scopeDescription?: string;
  website?: string;

  // 元数据
  sources?: string[];
  error?: string;
  warning?: string;
}

export interface ScraplingOptions {
  name?: string;
  issn?: string;
  keyword?: string;
  stealthy?: boolean;
  letpubOnly?: boolean;
  springerOnly?: boolean;
  timeoutMs?: number;
}

/**
 * 调用 Python Scrapling 爬虫获取期刊数据
 *
 * @returns 合并后的期刊数据，或 null（脚本失败/超时）
 */
export function scrapeJournal(options: ScraplingOptions): Promise<ScraplingResult | null> {
  return new Promise((resolve) => {
    const args: string[] = [SCRAPER_SCRIPT];

    if (options.name) {
      args.push("--name", options.name);
    }
    if (options.issn) {
      args.push("--issn", options.issn);
    }
    if (options.keyword) {
      args.push("--keyword", options.keyword);
    }
    if (options.stealthy) {
      args.push("--stealthy");
    }
    if (options.letpubOnly) {
      args.push("--letpub-only");
    }
    if (options.springerOnly) {
      args.push("--springer-only");
    }

    const timeout = options.timeoutMs || 60_000; // 默认 60s（StealthySession 需要时间）

    logger.info(
      { script: SCRAPER_SCRIPT, args: args.slice(1), timeout },
      "调用 Scrapling 爬虫"
    );

    const startTime = Date.now();

    execFile("python3", args, { timeout, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      const elapsed = Date.now() - startTime;

      // stderr 里可能有 warning 信息，不一定是错误
      if (stderr) {
        logger.debug({ stderr: stderr.slice(0, 500) }, "Scrapling stderr");
      }

      if (error) {
        // 区分超时 vs 其他错误
        if (error.killed || (error as any).code === "ETIMEDOUT") {
          logger.warn({ elapsed, timeout }, "Scrapling 爬虫超时");
        } else {
          logger.warn(
            { err: error.message, code: (error as any).code, elapsed },
            "Scrapling 爬虫执行失败"
          );
        }
        resolve(null);
        return;
      }

      // 解析 stdout JSON
      const trimmed = (stdout || "").trim();
      if (!trimmed) {
        logger.warn({ elapsed }, "Scrapling 爬虫无输出");
        resolve(null);
        return;
      }

      try {
        const data = JSON.parse(trimmed) as ScraplingResult;

        // 检查是否有 error 字段
        if (data.error) {
          logger.warn({ error: data.error, elapsed }, "Scrapling 爬虫返回错误");
          resolve(null);
          return;
        }

        logger.info(
          {
            sources: data.sources,
            name: data.name,
            hasIF: !!data.impactFactor,
            hasPartition: !!data.partition,
            hasAPC: !!data.apcFee,
            elapsed,
          },
          "Scrapling 爬虫成功"
        );

        resolve(data);
      } catch (parseErr) {
        logger.warn(
          { err: (parseErr as Error).message, stdout: trimmed.slice(0, 200), elapsed },
          "Scrapling 输出 JSON 解析失败"
        );
        resolve(null);
      }
    });
  });
}

/**
 * 将 Scrapling 爬取结果转换为 SpringerJournalData 格式
 * 用于与现有 ensureJournalEnriched 逻辑兼容
 */
export function toSpringerJournalData(data: ScraplingResult): Record<string, any> {
  return {
    abbreviation: undefined, // Scrapling 暂不爬简称
    foundingYear: undefined,
    country: undefined,
    website: data.website || undefined,
    apcFee: data.apcFee || undefined,
    selfCitationRate: data.selfCitationRate || undefined,
    casPartition: data.casPartition || undefined,
    casPartitionNew: undefined,
    jcrSubjects: undefined,
    topInstitutions: undefined,
    scopeDescription: data.scopeDescription || undefined,
  };
}

/**
 * 将 Scrapling 爬取结果转换为 JournalInfo 格式（用于 V6 模板）
 */
export function toJournalInfo(data: ScraplingResult): Partial<import("../data-collection/journal-content-collector.js").JournalInfo> {
  return {
    name: data.name || "",
    nameEn: data.nameEn || null,
    issn: data.issn || null,
    publisher: data.publisher || null,
    discipline: data.discipline || null,
    partition: data.partition || null,
    impactFactor: data.impactFactor || null,
    acceptanceRate: data.acceptanceRate || null,
    reviewCycle: data.reviewCycle || null,
    annualVolume: data.annualVolume || null,
    isWarningList: data.isWarningList ?? false,
    warningYear: null,
    coverUrl: null,
    dataCardUri: "",
    abbreviation: null,
    foundingYear: null,
    country: null,
    website: data.website || null,
    apcFee: data.apcFee || null,
    selfCitationRate: data.selfCitationRate || null,
    casPartition: data.casPartition || null,
    casPartitionNew: null,
    jcrSubjects: null,
    topInstitutions: null,
    scopeDescription: data.scopeDescription || null,
  };
}
