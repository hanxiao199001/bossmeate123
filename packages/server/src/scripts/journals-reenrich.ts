/**
 * 线A-2 批量再富化 — 挑最脏的期刊直接串行跑 enrichJournal (不走 BullMQ, 便于 SSH 前台观察).
 *
 * 断点续跑: enrichJournal 非 dryRun 每次都写 last_verified_at (orchestrator trustUpdate),
 *   跑过的自然从 --never-verified / 时效筛选里排除, 中断重跑不重复。
 * 反爬护栏: 复用 enrich-throttle 的 LetPubFailStreakTracker — 连续 5 条 LetPub 没数据即 abort,
 *   剩余记 skipped (与 journal-enrich-worker B.3 策略一致)。
 *
 * 用法 (packages/server 下):
 *   npx tsx src/scripts/journals-reenrich.ts --dry-run                  # 只列将处理哪些
 *   npx tsx src/scripts/journals-reenrich.ts --limit 20                 # 默认 confidence<60 或 NULL, 最脏优先
 *   npx tsx src/scripts/journals-reenrich.ts --min-confidence 40 --max-confidence 60
 *   npx tsx src/scripts/journals-reenrich.ts --never-verified --limit 50
 *   npx tsx src/scripts/journals-reenrich.ts --ids <uuid1>,<uuid2>
 *   选填 --throttle-ms 8000 (默认 8000±3000, 对齐 LetPub 反爬节奏)
 * 留痕: 控制台逐条 diff + 追加写 ./journals-reenrich-log.jsonl
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, gte, inArray, isNull, lte, lt, or, sql, type SQL } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { journals } from "../models/schema.js";
import { enrichJournal } from "../services/journal-enricher/orchestrator.js";
import { LetPubFailStreakTracker, MAX_LETPUB_FAIL_STREAK, nextDelayMs } from "../services/task/enrich-throttle.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function flag(n: string): boolean { return process.argv.includes(`--${n}`); }

/** enrich 前后对比的关键字段快照 */
interface Snapshot {
  impactFactor: number | null;
  partition: string | null;
  casPartition: string | null;
  isWarningList: boolean;
  acceptanceRate: number | null;
  reviewCycle: string | null;
  confidence: number | null;
  dataSource: string | null;
}

async function snapshot(id: string): Promise<Snapshot | null> {
  const [r] = await db.select({
    impactFactor: journals.impactFactor, partition: journals.partition, casPartition: journals.casPartition,
    isWarningList: journals.isWarningList, acceptanceRate: journals.acceptanceRate, reviewCycle: journals.reviewCycle,
    confidence: journals.confidence, dataSource: journals.dataSource,
  }).from(journals).where(eq(journals.id, id)).limit(1);
  return r ?? null;
}

function diff(before: Snapshot, after: Snapshot): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(before) as Array<keyof Snapshot>) {
    if (before[k] !== after[k]) out[k] = { before: before[k], after: after[k] };
  }
  return out;
}

async function main() {
  const limit = Number(arg("limit") ?? 20);
  const minConf = arg("min-confidence") !== undefined ? Number(arg("min-confidence")) : undefined;
  const maxConf = arg("max-confidence") !== undefined ? Number(arg("max-confidence")) : undefined;
  const neverVerified = flag("never-verified");
  const idsRaw = arg("ids");
  const dryRun = flag("dry-run");
  const throttleMs = Number(arg("throttle-ms") ?? 8000);
  const jitterMs = Math.floor(throttleMs * 0.375); // 8000 → ±3000, 避免固定节奏被识别
  const logPath = arg("log") ?? path.resolve(process.cwd(), "journals-reenrich-log.jsonl");

  // —— 选刊: --ids 精确指定优先; 否则按 confidence 筛 + 最脏优先 ——
  let where: SQL | undefined;
  if (idsRaw) {
    const ids = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    where = inArray(journals.id, ids);
  } else {
    const conds: SQL[] = [eq(journals.status, "active")];
    if (minConf !== undefined || maxConf !== undefined) {
      if (minConf !== undefined) conds.push(gte(journals.confidence, minConf));
      // 只给上限时 NULL(未评分)也算"最脏"纳入
      if (maxConf !== undefined) conds.push(or(isNull(journals.confidence), lte(journals.confidence, maxConf))!);
    } else {
      // 默认: confidence < 60 或未评分
      conds.push(or(isNull(journals.confidence), lt(journals.confidence, 60))!);
    }
    if (neverVerified) conds.push(isNull(journals.lastVerifiedAt));
    where = and(...conds);
  }

  const targets = await db.select({
    id: journals.id, name: journals.name, nameEn: journals.nameEn,
    confidence: journals.confidence, lastVerifiedAt: journals.lastVerifiedAt,
  }).from(journals)
    .where(where)
    .orderBy(sql`${journals.confidence} ASC NULLS FIRST`, sql`${journals.lastVerifiedAt} ASC NULLS FIRST`)
    .limit(idsRaw ? 10000 : limit);

  console.log(`\n🔧 批量再富化: 命中 ${targets.length} 本 (limit=${limit}${idsRaw ? ", ids 模式" : ""}${neverVerified ? ", 仅从未验证" : ""})`);
  console.log(`   节流 ${throttleMs}±${jitterMs}ms | 日志 ${logPath}\n`);

  if (dryRun) {
    // dry-run 只列清单, 一次 enrichJournal 都不调
    targets.forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.nameEn || t.name}  confidence=${t.confidence ?? "NULL"}  lastVerified=${t.lastVerifiedAt?.toISOString() ?? "从未"}  (${t.id})`);
    });
    console.log(`\n(dry-run) 去掉 --dry-run 开始处理。`);
    return;
  }

  const tracker = new LetPubFailStreakTracker();
  let success = 0, failed = 0, skipped = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const label = t.nameEn || t.name;
    console.log(`[${i + 1}/${targets.length}] ${label} (confidence=${t.confidence ?? "NULL"})`);

    const before = await snapshot(t.id);
    const t0 = Date.now();
    let record: Record<string, unknown>;
    try {
      const result = await enrichJournal(t.id);
      tracker.observe(result.successFields);
      const after = await snapshot(t.id);
      const changes = before && after ? diff(before, after) : {};
      const changedKeys = Object.keys(changes);
      if (changedKeys.length > 0) {
        for (const k of changedKeys) {
          console.log(`    ~ ${k}: ${JSON.stringify(changes[k].before)} → ${JSON.stringify(changes[k].after)}`);
        }
      } else {
        console.log(`    (关键字段无变化)`);
      }
      success++;
      record = {
        ts: new Date().toISOString(), journalId: t.id, name: label, status: "success",
        durationMs: Date.now() - t0, successFields: result.successFields, failedFields: result.failedFields,
        before, after, diff: changes,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ✗ 失败: ${msg} (单条失败不中断)`);
      failed++;
      record = { ts: new Date().toISOString(), journalId: t.id, name: label, status: "failed", durationMs: Date.now() - t0, error: msg };
    }
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n", "utf-8");

    // B.3 同款反爬护栏: 连续 5 条 LetPub 没数据 → 疑似被封, 停批保护 IP
    if (tracker.shouldAbort()) {
      skipped = targets.length - i - 1;
      const msg = `LetPub 连续 ${MAX_LETPUB_FAIL_STREAK} 条未拿到数据(疑似反爬), abort 剩余 ${skipped} 本`;
      console.error(`\n⛔ ${msg}`);
      fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), status: "aborted", reason: msg, skipped }) + "\n", "utf-8");
      break;
    }

    if (i < targets.length - 1) {
      await new Promise((r) => setTimeout(r, nextDelayMs(throttleMs, jitterMs)));
    }
  }

  console.log(`\n=== 汇总 === 成功 ${success} / 失败 ${failed} / 跳过 ${skipped} (共 ${targets.length})`);
  console.log(`断点续跑: 成功的已更新 last_verified_at, 直接重跑同命令即从剩余最脏的继续。`);
}

main().then(async () => { await closePool(); process.exit(0); })
  .catch(async (e) => { console.error("再富化异常:", e instanceof Error ? e.message : e); await closePool(); process.exit(1); });
