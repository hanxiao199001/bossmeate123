/**
 * PR #178 — 60 天内容保留 + 自动清理.
 *
 * 用法 (prod 手动 dry-run):
 *   ssh "$BOSSMATE_DEPLOY_SERVER" 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/cleanup-old-contents.js --dry-run'
 *
 * 自动: scheduler.ts 每日 03:30 BJ 触发.
 *
 * 保护规则:
 *   - status='published' → 永久保留 (已发布内容不删)
 *   - pinned=true → 永久保留 (手动钉住)
 *   - created_at < 60天前 + 非 published + 非 pinned → 删除
 *   - 先删 content_publish_log (无 CASCADE), 再删 contents
 */
import { db } from "../models/db.js";
import { contents, contentPublishLog } from "../models/schema.js";
import { and, lt, eq, or, isNull, inArray, ne } from "drizzle-orm";
import { logger } from "../config/logger.js";

const RETENTION_DAYS = 60;

export interface CleanupResult {
  wouldDelete: number;
  deleted: number;
  sample: Array<{ id: string; title: string | null; status: string; createdAt: Date }>;
  dryRun: boolean;
}

export async function cleanupOldContents(opts: { dryRun?: boolean } = {}): Promise<CleanupResult> {
  const dryRun = opts.dryRun ?? false;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  logger.info({ cutoff: cutoff.toISOString(), dryRun }, "[cleanup] 开始查找过期内容");

  // 查删除候选: >60天 + 非 published + 非 pinned
  const candidates = await db
    .select({
      id: contents.id,
      title: contents.title,
      status: contents.status,
      createdAt: contents.createdAt,
    })
    .from(contents)
    .where(
      and(
        lt(contents.createdAt, cutoff),
        ne(contents.status, "published"),
        or(isNull(contents.pinned), eq(contents.pinned, false)),
      ),
    );

  const result: CleanupResult = {
    wouldDelete: candidates.length,
    deleted: 0,
    sample: candidates.slice(0, 5).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      createdAt: c.createdAt,
    })),
    dryRun,
  };

  logger.info({ wouldDelete: candidates.length, dryRun }, "[cleanup] 候选数量");

  if (dryRun || candidates.length === 0) {
    return result;
  }

  const ids = candidates.map((c) => c.id);

  // 先删 content_publish_log (无 FK CASCADE)
  await db.delete(contentPublishLog).where(inArray(contentPublishLog.contentId, ids));

  // 再删 contents
  await db.delete(contents).where(inArray(contents.id, ids));

  result.deleted = ids.length;
  logger.info({ deleted: ids.length }, "[cleanup] 清理完成");

  return result;
}

// CLI 直接跑
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cleanup-old-contents.js")) {
  const dryRun = process.argv.includes("--dry-run");
  cleanupOldContents({ dryRun })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("[cleanup] fatal:", err);
      process.exit(1);
    });
}
