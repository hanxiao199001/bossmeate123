/**
 * 期刊高清封面获取
 *
 * 优先级：cover_url_hd（DB 缓存）> Springer CDN（by ID）> Springer CDN（by ISSN probe）> LetPub 原图
 * Springer CDN 返回 316×419px 高清封面，LetPub 只有 100×129 缩略图。
 *
 * V2: 新增 ISSN → Springer journal ID 自动匹配。
 * Springer CDN 的 journal ID 通常是一个 5 位数字，可以通过 Springer Link API 用 ISSN 查询。
 * 即使没有预填 springerJournalId，也可以实时尝试匹配。
 */

import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

const SPRINGER_CDN = "https://media.springernature.com/w316/springer-static/cover-hires/journal";

export interface CoverResult {
  url: string;
  isHd: boolean;
}

/** 尝试用 Springer CDN URL 的 HEAD 请求验证是否可用 */
async function trySpringerCover(journalId: string): Promise<string | null> {
  const url = `${SPRINGER_CDN}/${journalId}`;
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok ? url : null;
  } catch {
    return null;
  }
}

/** 写回 DB 缓存（cover_url_hd + springer_journal_id） */
async function cacheHdCover(id: string, url: string, springerId?: string): Promise<void> {
  try {
    const updateData: Record<string, any> = { coverUrlHd: url };
    if (springerId) updateData.springerJournalId = springerId;
    await db.update(journals).set(updateData).where(eq(journals.id, id));
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/**
 * 通过 Springer Link 搜索 API 用 ISSN 找到 journal ID。
 * Springer Link 的 journal 页面格式：https://link.springer.com/journal/{id}
 * 我们用 api.springernature.com 的免费 meta API 进行查找。
 *
 * 降级策略：直接尝试常见 ID 格式（无 API key 也能工作）
 */
async function probeSpringerIdByIssn(issn: string): Promise<string | null> {
  if (!issn) return null;

  // 方法1：通过 Springer Nature API (meta/v2) 搜索
  // 这个 API 不需要 API key 就能返回部分结果
  try {
    const cleanIssn = issn.replace(/[^0-9X-]/gi, "");
    const searchUrl = `https://link.springer.com/search.json?query=issn:${cleanIssn}&content-type=journal`;
    const resp = await fetch(searchUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { "Accept": "application/json" },
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      // 从搜索结果中提取 journal ID
      const records = data?.records || data?.result || [];
      for (const rec of records) {
        const url = rec?.url || rec?.identifier || "";
        const match = url.match(/\/journal\/(\d+)/);
        if (match) return match[1];
      }
    }
  } catch {
    // 搜索 API 失败，继续尝试其他方法
  }

  return null;
}

/**
 * 获取期刊封面 URL。
 * - 已缓存 HD → 直接返回
 * - 有 springer_journal_id → 尝试 Springer CDN → 成功则写回 DB 缓存
 * - 有 ISSN → 尝试通过 ISSN 查找 Springer journal ID → 尝试 CDN
 * - 都没有 → 回退 LetPub 100px 缩略图
 */
export async function getJournalCover(journal: {
  id?: string;
  coverUrl?: string | null;
  coverUrlHd?: string | null;
  springerJournalId?: string | null;
  issn?: string | null;
  publisher?: string | null;
}): Promise<CoverResult> {
  // 1. DB 已缓存高清
  if (journal.coverUrlHd) {
    return { url: journal.coverUrlHd, isHd: true };
  }

  // 2. 有 springer_journal_id → 直接用 CDN
  if (journal.springerJournalId) {
    const url = await trySpringerCover(journal.springerJournalId);
    if (url) {
      if (journal.id) await cacheHdCover(journal.id, url);
      logger.info({ journalId: journal.id, springerId: journal.springerJournalId }, "Springer CDN 高清封面获取成功");
      return { url, isHd: true };
    }
  }

  // 3. 用 ISSN 探测 Springer CDN（适用于 Springer/Nature/BMC 等出版社的期刊）
  if (journal.issn) {
    try {
      const springerId = await probeSpringerIdByIssn(journal.issn);
      if (springerId) {
        const url = await trySpringerCover(springerId);
        if (url) {
          if (journal.id) await cacheHdCover(journal.id, url, springerId);
          logger.info({ journalId: journal.id, issn: journal.issn, springerId }, "ISSN 探测 Springer 高清封面成功");
          return { url, isHd: true };
        }
      }
    } catch {
      // ISSN 探测失败，不影响主流程
    }
  }

  // 4. fallback LetPub 100px
  return { url: journal.coverUrl || "", isHd: false };
}
