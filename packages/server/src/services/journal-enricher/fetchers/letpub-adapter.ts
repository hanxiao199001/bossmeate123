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

import { scrapeLetPubDetail, type LetPubJournalDetail } from "../../crawler/letpub-detail-scraper.js";
import { logger } from "../../../config/logger.js";

export interface LetpubFetchInput {
  journalName: string;
  issn?: string | null;
}

export async function fetchLetpubDetail(
  input: LetpubFetchInput
): Promise<LetPubJournalDetail | null> {
  const { journalName, issn } = input;
  if (!journalName) {
    logger.warn("LetPub adapter: journalName 缺失，跳过");
    return null;
  }
  try {
    const detail = await scrapeLetPubDetail(journalName, issn || undefined);
    if (!detail) {
      logger.info({ journalName, issn }, "LetPub adapter: 期刊未找到");
      return null;
    }
    return detail;
  } catch (err) {
    logger.warn({ journalName, issn, err: String(err) }, "LetPub adapter: 抓取异常");
    return null;
  }
}

// 为了 unit test 方便，re-export 类型
export type { LetPubJournalDetail };
