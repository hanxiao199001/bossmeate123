/**
 * Fenqubiao Warning List fetcher (B.2.2)
 *
 * 中科院文献情报中心 - 期刊分区表团队 - 国际期刊预警名单
 * Source: https://earlywarning.fenqubiao.com/zh-cn/early-warning-journal-list-{YEAR}.md
 *
 * 公开 docsify 静态站，无 login。每年 3 月发布。返回 ISSN → 预警原因 map。
 *
 * Redis cache: key = "fenqubiao:warning-list:v1"，TTL 24h（数据每年只更新一次，
 * 24h 完全足够；调用方多刊批量 enrich 也只首调一次）。
 */

import * as cheerio from "cheerio";
import { logger } from "../../../config/logger.js";
import { getRedisConnection } from "../../task/queue.js";

const FENQUBIAO_BASE = "https://earlywarning.fenqubiao.com";
/** 调研发现 5 年版本（缺 2022） */
const SUPPORTED_YEARS = [2025, 2024, 2023, 2021, 2020] as const;

const CACHE_KEY = "fenqubiao:warning-list:v1";
const CACHE_TTL_SEC = 86400; // 24h
const REQUEST_TIMEOUT_MS = 10000;

export interface FenqubiaoWarningEntry {
  /** 命中的最近年份（按 SUPPORTED_YEARS 顺序首个） */
  latestYear: number;
  /** 该年份的预警原因（如 "论文工厂"） */
  reason: string;
}

export type FenqubiaoWarningMap = Map<string, FenqubiaoWarningEntry>;

/**
 * 拿全 5 年 ISSN → entry 合并 map。带 redis cache 24h。
 * 失败 return 空 Map（不抛错，orchestrator 走 partial OK）。
 */
export async function fetchFenqubiaoWarningList(): Promise<FenqubiaoWarningMap> {
  // Cache hit?
  try {
    const redis = getRedisConnection();
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      try {
        const arr = JSON.parse(cached) as Array<[string, FenqubiaoWarningEntry]>;
        return new Map(arr);
      } catch {
        logger.warn({ key: CACHE_KEY }, "fenqubiao cache 反序列化失败，忽略 cache");
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "fenqubiao redis 不可用，跳过 cache");
  }

  // Cache miss → fetch all 5 years
  const merged: FenqubiaoWarningMap = new Map();
  for (const year of SUPPORTED_YEARS) {
    const yearMap = await fetchOneYear(year);
    for (const [issn, entry] of yearMap) {
      // 仅首条（latest year，per SUPPORTED_YEARS 顺序）
      if (!merged.has(issn)) merged.set(issn, entry);
    }
  }

  // 写 cache（即便 0 条也写，避免每次 enrich 都重抓 5 个 URL）
  try {
    const redis = getRedisConnection();
    await redis.set(CACHE_KEY, JSON.stringify([...merged.entries()]), "EX", CACHE_TTL_SEC);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "fenqubiao cache 写入失败");
  }

  return merged;
}

/** 抓单年 markdown 表格 → ISSN map. Exported for tests. */
export async function fetchOneYear(year: number): Promise<FenqubiaoWarningMap> {
  const url = `${FENQUBIAO_BASE}/zh-cn/early-warning-journal-list-${year}.md`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      logger.warn({ year, status: resp.status }, "fenqubiao 单年抓取失败");
      return new Map();
    }
    const md = await resp.text();
    return parseFenqubiaoMarkdown(md, year);
  } catch (err) {
    clearTimeout(timer);
    logger.warn(
      { year, err: err instanceof Error ? err.message : String(err) },
      "fenqubiao 单年抓取异常",
    );
    return new Map();
  }
}

/** 解析 markdown 中嵌入的 HTML <table> → ISSN map. Exported for tests. */
export function parseFenqubiaoMarkdown(md: string, year: number): FenqubiaoWarningMap {
  const map: FenqubiaoWarningMap = new Map();
  // markdown 文档里嵌的就是 <table> HTML，可直接 cheerio 喂全文
  const $ = cheerio.load(md);
  $("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 2) return;
    const issnRaw = $(tds[1]).text().trim();
    const reason = tds.length >= 3 ? $(tds[2]).text().trim() : "";
    // ISSN 格式：可能含 / 分隔（issn/eissn）。取第一个匹配 4-4 模式
    const issnMatch = issnRaw.match(/\b\d{4}-\d{3}[\dXx]\b/);
    if (!issnMatch) return;
    const issn = issnMatch[0].toUpperCase();
    if (!map.has(issn)) {
      map.set(issn, { latestYear: year, reason });
    }
  });
  return map;
}
