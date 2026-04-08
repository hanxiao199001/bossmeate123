/**
 * 期刊封面图预抓取服务（按选题定向抓取）
 *
 * 核心思路：根据当日选题 topics，找到对应的期刊，定向抓取封面
 * 这样保证缓存的封面图一定是当天文章会用到的，不会乱配
 *
 * 流程：
 * 1. 从今日选题提取 topics + referenceJournals
 * 2. 在 journals 表中按 topic 匹配期刊（与 collectJournalContent 同逻辑）
 * 3. 筛出无封面的，多源抓取：LetPub → CrossRef/Springer → 英文名重试
 * 4. 成功写入 DB；连续失败 3 次暂停（防封 IP）
 * 5. 每条间隔 1s（LetPub 限速）
 */

import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { eq, isNull, desc, and, or, ilike, sql } from "drizzle-orm";
import {
  fetchJournalCoverFromLetPub,
  fetchJournalCoverFromCrossRef,
} from "./journal-image-crawler.js";

export interface PrefetchResult {
  total: number;      // 本次处理数
  success: number;    // 成功抓取
  failed: number;     // 失败
  skipped: number;    // 跳过（已有封面 / 暂停）
  sources: Record<string, number>; // 按来源统计
  topicsCovered: string[]; // 命中了哪些选题
}

/**
 * 按选题定向预抓取期刊封面
 *
 * @param tenantId 租户 ID
 * @param topics 今日选题关键词列表（从 plan tasks 提取）
 * @param referenceJournalNames 计划中显式引用的期刊名（优先抓取）
 */
export async function prefetchJournalCovers(
  tenantId: string,
  topics: string[] = [],
  referenceJournalNames: string[] = []
): Promise<PrefetchResult> {
  const result: PrefetchResult = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    sources: {},
    topicsCovered: [],
  };

  if (topics.length === 0 && referenceJournalNames.length === 0) {
    logger.info({ tenantId }, "无选题信息，跳过封面预抓取");
    return result;
  }

  // ── 第一步：按选题匹配期刊（与 collectJournalContent 同逻辑）──
  // 去重：同一期刊可能匹配多个 topic
  const journalMap = new Map<string, {
    id: string;
    name: string;
    nameEn: string | null;
    issn: string | null;
    impactFactor: number | null;
    coverImageUrl: string | null;
    matchedTopic: string;
  }>();

  // 1a: 优先处理显式引用的期刊名
  for (const jName of referenceJournalNames) {
    if (!jName) continue;
    const rows = await db
      .select({
        id: journals.id,
        name: journals.name,
        nameEn: journals.nameEn,
        issn: journals.issn,
        impactFactor: journals.impactFactor,
        coverImageUrl: journals.coverImageUrl,
      })
      .from(journals)
      .where(
        and(
          eq(journals.tenantId, tenantId),
          eq(journals.status, "active"),
          or(
            ilike(journals.name, `%${jName}%`),
            ilike(journals.nameEn, `%${jName}%`)
          )
        )
      )
      .limit(2);

    for (const row of rows) {
      if (!journalMap.has(row.id)) {
        journalMap.set(row.id, { ...row, matchedTopic: `ref:${jName}` });
      }
    }
  }

  // 1b: 按 topic 关键词匹配（每个 topic 最多取 3 个期刊）
  for (const topic of topics) {
    if (!topic) continue;
    const rows = await db
      .select({
        id: journals.id,
        name: journals.name,
        nameEn: journals.nameEn,
        issn: journals.issn,
        impactFactor: journals.impactFactor,
        coverImageUrl: journals.coverImageUrl,
      })
      .from(journals)
      .where(
        and(
          eq(journals.tenantId, tenantId),
          eq(journals.status, "active"),
          or(
            ilike(journals.discipline, `%${topic}%`),
            ilike(journals.name, `%${topic}%`)
          )
        )
      )
      .orderBy(desc(journals.impactFactor))
      .limit(3);

    for (const row of rows) {
      if (!journalMap.has(row.id)) {
        journalMap.set(row.id, { ...row, matchedTopic: topic });
      }
    }

    if (rows.length > 0) {
      result.topicsCovered.push(topic);
    }
  }

  // ── 第二步：筛选出无封面的期刊 ──
  const needFetch = [...journalMap.values()].filter((j) => !j.coverImageUrl);
  const alreadyCached = journalMap.size - needFetch.length;

  result.total = needFetch.length;
  result.skipped = alreadyCached; // 已有缓存的算跳过

  if (needFetch.length === 0) {
    logger.info(
      { tenantId, matched: journalMap.size, cached: alreadyCached },
      "今日选题相关期刊均已有封面缓存"
    );
    return result;
  }

  logger.info(
    {
      tenantId,
      topics,
      matched: journalMap.size,
      needFetch: needFetch.length,
      alreadyCached,
    },
    "开始定向预抓取期刊封面图"
  );

  // ── 第三步：逐个抓取 ──
  let consecutiveFailures = 0;

  for (const journal of needFetch) {
    if (consecutiveFailures >= 3) {
      logger.warn(
        { tenantId, consecutiveFailures },
        "连续失败次数过多，暂停本轮预抓取"
      );
      result.skipped += needFetch.length - result.success - result.failed;
      break;
    }

    try {
      let coverUrl: string | null = null;
      let source = "";

      // 源 1：LetPub（中文名）
      coverUrl = await fetchJournalCoverFromLetPub(
        journal.name,
        journal.issn || undefined
      );
      source = "letpub";

      // 源 2：CrossRef / Springer
      if (!coverUrl) {
        coverUrl = await fetchJournalCoverFromCrossRef(
          journal.name,
          journal.issn || undefined
        );
        source = "crossref";
      }

      // 源 3：英文名再试 LetPub
      if (!coverUrl && journal.nameEn) {
        coverUrl = await fetchJournalCoverFromLetPub(
          journal.nameEn,
          journal.issn || undefined
        );
        source = "letpub-en";
      }

      if (coverUrl) {
        const valid = await validateImageUrl(coverUrl);
        if (valid) {
          await db
            .update(journals)
            .set({
              coverImageUrl: coverUrl,
              coverImageSource: source,
              coverFetchedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(journals.id, journal.id));

          result.success++;
          result.sources[source] = (result.sources[source] || 0) + 1;
          consecutiveFailures = 0;

          logger.debug(
            { journal: journal.name, source, topic: journal.matchedTopic },
            "封面图缓存成功"
          );
        } else {
          result.failed++;
          consecutiveFailures++;
        }
      } else {
        result.failed++;
        consecutiveFailures++;
      }
    } catch (err) {
      result.failed++;
      consecutiveFailures++;
      logger.debug(
        { journal: journal.name, err: String(err) },
        "封面图抓取异常"
      );
    }

    // 限速 1s
    await new Promise((r) => setTimeout(r, 1000));
  }

  logger.info(
    { tenantId, ...result },
    "期刊封面图定向预抓取完成"
  );

  return result;
}

/**
 * 验证图片 URL 是否可访问
 */
async function validateImageUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const resp = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (resp.ok) {
      const ct = resp.headers.get("content-type") || "";
      return ct.startsWith("image") || ct.includes("svg");
    }
    return false;
  } catch {
    return false;
  }
}
