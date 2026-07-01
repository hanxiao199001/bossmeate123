/**
 * 线A-3 每周增量保鲜 — 挑 confidence<60 或 30 天未验证的刊, 限量入 journal-enrich 队列 (BullMQ).
 *
 * 与现有调度的关系 (先 grep 过, 不重复造轮子):
 *   - scheduler.ts 已有每日 03:00 `journal-trust-reverify` cron: 按 lastVerifiedAt ASC 滚全库, 每日 ≤100 本,
 *     直跑 enrichJournal (in-process, 不走 journal-enrich 队列)。
 *   - 本脚本是它的"补刀"版: 专挑 confidence<60 的脏刊 + 走队列 (由 index.ts 已启动的
 *     journal-enrich worker 消费, concurrency=1 + delayMs 节流), 幂等可 cron。
 *   若主线认为 daily reverify 已够, 本脚本可只作手动应急工具, 不挂 cron。
 *
 * 幂等: jobId = weekly-reenrich-<ISO周>-<journalId>, 同一周重复执行不会重复入队 (BullMQ 按 jobId 去重);
 *   且 enrich 完成即写 last_verified_at, 下周自然换一批。可安全 cron:
 *     30 4 * * 1  cd /home/projects/bossmate/packages/server && set -a && . ../../.env && set +a && node dist/scripts/journals-schedule-refresh.js >> /var/log/bossmate/journals-weekly.log 2>&1
 *
 * 用法 (packages/server 下):
 *   npx tsx src/scripts/journals-schedule-refresh.ts --dry-run     # 只列将入队哪些
 *   npx tsx src/scripts/journals-schedule-refresh.ts               # 默认 50 本/次
 *   选填 --limit 50 --delay-ms 8000 --jitter-ms 3000
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { journals } from "../models/schema.js";
import { journalEnrichQueue, closeQueues } from "../services/task/queue.js";
import { shuffleFisherYates } from "../services/task/enrich-throttle.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function flag(n: string): boolean { return process.argv.includes(`--${n}`); }

/** ISO 周标签 (如 2026-W27), 做 jobId 的周级幂等键 */
function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // 周四所在年 = ISO 年
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function main() {
  const limit = Number(arg("limit") ?? 50);
  const delayMs = Number(arg("delay-ms") ?? 8000);
  const jitterMs = Number(arg("jitter-ms") ?? 3000);
  const dryRun = flag("dry-run");
  const week = isoWeek();

  // 选刊: confidence<60/未评分 或 30 天未验证/从未验证, 最脏优先
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const candidates = await db.select({
    id: journals.id, name: journals.name, nameEn: journals.nameEn,
    confidence: journals.confidence, lastVerifiedAt: journals.lastVerifiedAt,
  }).from(journals)
    .where(and(
      eq(journals.status, "active"),
      or(
        isNull(journals.confidence),
        lt(journals.confidence, 60),
        isNull(journals.lastVerifiedAt),
        lt(journals.lastVerifiedAt, cutoff),
      ),
    ))
    .orderBy(sql`${journals.confidence} ASC NULLS FIRST`, sql`${journals.lastVerifiedAt} ASC NULLS FIRST`)
    .limit(limit);

  console.log(`\n📅 每周增量保鲜 (${week}): 命中 ${candidates.length} 本 (limit=${limit}, 队列节流 ${delayMs}±${jitterMs}ms)\n`);

  if (dryRun) {
    candidates.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.nameEn || c.name}  confidence=${c.confidence ?? "NULL"}  lastVerified=${c.lastVerifiedAt?.toISOString() ?? "从未"}`);
    });
    console.log(`\n(dry-run) 未入队。`);
    return;
  }

  // B.3.1 同款: 打散顺序, 避免同学科中文刊连续 5 条无 LetPub 数据触发 worker streak 假阳性 abort
  const shuffled = shuffleFisherYates(candidates);
  let queued = 0, deduped = 0;
  for (const c of shuffled) {
    const job = await journalEnrichQueue.add(
      "enrich-single",
      { journalId: c.id, delayMs, jitterMs },
      { jobId: `weekly-reenrich-${week}-${c.id}` }, // 周级幂等: 同周重跑不重复入队
    );
    // BullMQ 同 jobId 已存在时返回旧 job — 用入队时间判断是否本次新增
    if (job.timestamp >= Date.now() - 60_000) queued++; else deduped++;
  }

  const estMin = Math.ceil((shuffled.length * (delayMs + 5000)) / 60000);
  console.log(`✅ 入队 ${queued} 本 (同周去重 ${deduped}), worker 串行消费, 预计 ~${estMin} 分钟。`);
  console.log(`   完成后 enrichJournal 会写 last_verified_at, 下次执行自动换下一批。`);
}

main().then(async () => { await closeQueues(); await closePool(); process.exit(0); })
  .catch(async (e) => {
    console.error("调度脚本异常:", e instanceof Error ? e.message : e);
    try { await closeQueues(); } catch { /* redis 不在也不阻塞退出 */ }
    await closePool();
    process.exit(1);
  });
