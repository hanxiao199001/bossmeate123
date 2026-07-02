/**
 * LetPub adapter（B.2.1.A）
 *
 * 不重写 HTML 解析 —— 复用现有 services/crawler/letpub-detail-scraper.ts 的
 * scrapeLetPubDetail()（440 行已生产跑了月度更新 cron）。
 *
 * 本 adapter 只做：
 *  1. 用 (journalName, issn) 调 scrapeLetPubDetail
 *  2. 透传 LetPubJournalDetail 给上游 extractor
 *  3. null/异常时降级为 null（不抛，让 orchestrator partial OK）
 */

import { scrapeLetPubDetailClassified, type LetPubJournalDetail, type LetPubFetchOutcome } from "../../crawler/letpub-detail-scraper.js";
import { logger } from "../../../config/logger.js";

export interface LetpubFetchInput {
  journalName: string;
  issn?: string | null;
}

// 7-02: 返回分类 outcome(ok/not_found/blocked) 供断路器分级。缺名字=自然查无; 抓取异常=反爬信号。
export async function fetchLetpubDetail(
  input: LetpubFetchInput
): Promise<LetPubFetchOutcome> {
  const { journalName, issn } = input;
  if (!journalName) {
    logger.warn("LetPub adapter: journalName 缺失，跳过");
    return { kind: "not_found" };
  }
  try {
    return await scrapeLetPubDetailClassified(journalName, issn || undefined);
  } catch (err) {
    logger.warn({ journalName, issn, err: String(err) }, "LetPub adapter: 抓取异常(计入熔断)");
    return { kind: "blocked", reason: String(err) };
  }
}

// 为了 unit test 方便，re-export 类型
export type { LetPubJournalDetail, LetPubFetchOutcome };
