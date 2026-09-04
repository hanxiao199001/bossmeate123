/**
 * 每日备份 + 每周恢复演练 (8-26)。
 *
 * 【为什么这个文件存在】
 * 8-26 给运营手册盘点配置时发现: 生产**零自动备份**。
 *   · PostgreSQL 与 Redis 都是本机自建, 没有任何云托管的自动快照
 *   · `~/db-backups/` 里只有 `pre-migration-025/026` 两个 dump —— 7-19 / 7-20 手打的,
 *     盘点当天已经 37 天前, 而且和数据库同在 `/dev/vda2` 一块盘上
 *   · 全仓 `pg_dump` 零处、ubuntu 无 crontab、无备份脚本、无 systemd timer
 *   · 与此同时, 每日 03:30 的 `content-retention-cleanup` 照常删 60 天前的内容
 * 一个每天删数据的任务 + 零备份 = 误删不可逆。
 *
 * 【这个文件最该防的不是"备份失败", 是"备份静默失败"】
 * CLAUDE.md 红线 #14 已经用五次事故写明: **可观测体系只能看见「以失败形态存在的失败」**。
 * 备份是这条规律最危险的应用场景 —— 一个坏掉的备份和一个好用的备份,
 * 在你需要它之前**看起来完全一样**。所以这里的每一步都必须能把失败暴露成失败:
 *
 *   ① 存储不是 OSS(即备份会落在同一台机器上) → 直接失败, 不"降级"存本地。
 *      跨云是这次改造的**目的**本身, 退化成本地备份等于什么都没做, 却会显示成功。
 *   ② pg_dump / redis-cli 退出码非 0 → 失败。不接受"文件生成了就算成功"。
 *   ③ 产物过小或 gzip 校验不过 → 失败。0 字节的 .gz 也是一个"成功产出的文件"。
 *   ④ 上传后**回查对象大小**并与本地比对 → 不一致即失败。
 *      `put()` 不抛错不等于对象真在桶里(网络中断/权限/分片残留都可能)。
 *   ⑤ 任一环节失败 → 落 `ops_incidents(kind=backup_failed, severity=error)` **并抛出**,
 *      让 BullMQ 也记一次 failed。告警与任务状态两条路都要有痕迹。
 *
 * 【还有一层: "压根没跑"不会产生任何失败】
 * 上面五条防的都是"跑了但失败"。如果调度器挂了 / cron 没注册 / 进程起不来,
 * 备份**一次都不会执行**, 于是**一条失败 incident 都不会有** —— 监控全绿, 而你没有备份。
 * 所以 `ops_backups` 表记的是**成功**时间戳, 由 `checkBackupFreshness()` 拿它和当前时间比对,
 * 在每日简报里回答"最近一次成功备份是多久以前"。这个问题只有正向记录答得了。
 *
 * 【为什么还要每周恢复演练】
 * 备份文件存在 ≠ 能恢复。演练真的 createdb + 灌进去 + 查行数, 空库/缺表当场失败。
 * 没验证过能恢复的备份不算备份。
 *
 * ============================================================================
 * 🔴 本方案的已知局限 —— 上线时就知道, 写在这里免得下一个人误以为它兜住了全部
 * ============================================================================
 *
 * ## 局限一: OSS 与百炼是**同一个阿里云账号**(9-01 老韩确认)
 *
 * 所以"跨云"这个说法只对了一半:
 *   ✅ 跨**机器**、跨**磁盘** —— 服务器整机没了 / /dev/vda2 坏了, 备份还在
 *   ❌ 不跨**账号**、不跨**服务商** —— 阿里云账户欠费或被停用(UserDisable),
 *      LLM / TTS / 数字人 / **以及这里的备份读写** 会一起失效
 *
 * 这正是 8-31 事故的同一个形态(主备模型共享百炼账户), 只是换了个位置。
 * 8-25 那次账户级 `UserDisable` 同时打死了 TTS 与数字人 —— 如果当时这套备份已经上线,
 * **它很可能也写不进去**, 而且是在最需要它的时候。
 *
 * ⚠️ 因此: **不要**把本模块描述为"跨云备份"。准确的说法是
 *    「异机备份, 单一阿里云账号」。腾讯云 COS 第二副本另有 PR 处理(9-01 老韩已批),
 *    在那个 PR 落地之前, 阿里云账号是这条链路上**唯一的**失败点。
 *
 * ## 局限二: 只验证了数据侧, 整机 RTO 至今未知
 *
 * `runBackupRestoreDrill()` 验的是"备份里的数据能不能灌回一个库", 这一层有效且必要。
 * 它**不能**回答的是"整台机器没了, 多久能重新跑起来" ——
 * 后者需要在一台临时机器上只用备份 + 代码仓库 + .env 副本重建并计时,
 * 而 9-01 盘点时确认: 该演练做不了(云账号不在手上), 记为**未验证风险**。
 *
 * 具体缺口: `.env`(56 条配置 / 12 条密钥性质, 不在 git)与线上 nginx 配置
 * (仓库里那份 `nginx/default.conf` 是通用模板, 与线上差 66 行)**各自只有一份**,
 * 都在那台机器上。**数据的备份救不了配置** —— 配置没了, 备份里的数据无处可放。
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { createGzip } from "zlib";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { sql } from "drizzle-orm";
import { recordIncident } from "./incidents.js";
import { getStorage, getLastUploadSeconds } from "../storage/index.js";

/** 产物过小即视为损坏 —— 240MB 的库压出来不可能只有几 KB */
const MIN_PG_DUMP_BYTES = 64 * 1024;
/** Redis RDB 空库也有几十字节, 但正常业务库远不止; 给一个保守下限 */
const MIN_REDIS_RDB_BYTES = 1024;

export type BackupKind = "postgres" | "redis";

export interface BackupArtifact {
  kind: BackupKind;
  remotePath: string;
  localBytes: number;
  verifiedBytes: number;
  sha256: string;
  /** 9-04: 这一次上传花了多久。贴近 ali-oss 的 60 秒单次超时线时要能提前看见 */
  uploadSeconds: number;
}

export interface BackupResult {
  date: string;
  artifacts: BackupArtifact[];
  prunedCount: number;
  prunedPaths: string[];
  durationMs: number;
}

// ============ 小工具 ============

/** 跑一个外部命令, 非 0 退出码即抛。stdout 可选重定向到文件 */
function run(
  cmd: string,
  args: string[],
  opts: { toFile?: string; gzip?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", opts.toFile ? "pipe" : "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d).slice(0, 2000); });

    let streamDone: Promise<void> | null = null;
    if (opts.toFile) {
      const out = createWriteStream(opts.toFile);
      streamDone = opts.gzip
        ? pipeline(child.stdout!, createGzip({ level: 6 }), out)
        : pipeline(child.stdout!, out);
      // 🔴 流的错误必须自己 catch, 否则它变成 unhandledRejection 把进程带走,
      //    而 close 回调那边还在等 —— 表现为"备份任务卡住", 比失败更难查。
      streamDone.catch(() => { /* 下面 close 回调统一处理 */ });
    }

    child.on("error", (err) => reject(new Error(`${cmd} 起不来: ${err.message}`)));
    child.on("close", (code) => {
      void (async () => {
        // 🔴 顺序要紧: 先等流写完再判退出码。反过来会在 pg_dump 已退出但 gzip 还没
        //    flush 完时就宣布成功, 留下一个被截断的 .gz —— 又一个"看起来成功"的产物。
        if (streamDone) {
          try { await streamDone; } catch (err) {
            reject(new Error(`${cmd} 输出写盘失败: ${(err as Error).message}`));
            return;
          }
        }
        if (code !== 0) {
          reject(new Error(`${cmd} 退出码 ${code}${stderr ? ` — ${stderr.slice(0, 400)}` : ""}`));
          return;
        }
        resolve();
      })();
    });
  });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** gzip 完整性校验 —— 能解开才算是个 gz, 不然就是一坨"看起来像备份的字节" */
async function assertGzipIntact(path: string): Promise<void> {
  await run("gzip", ["-t", path]);
}

function beijingDateStr(now: Date): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

async function recordBackupRow(row: {
  kind: string; status: "success" | "failed";
  remotePath?: string | null; localBytes?: number | null; verifiedBytes?: number | null;
  sha256?: string | null; durationMs?: number | null; uploadSeconds?: number | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO ops_backups (kind, status, remote_path, local_bytes, verified_bytes, sha256, duration_ms, upload_seconds, detail)
      VALUES (${row.kind}, ${row.status}, ${row.remotePath ?? null}, ${row.localBytes ?? null},
              ${row.verifiedBytes ?? null}, ${row.sha256 ?? null}, ${row.durationMs ?? null},
              ${row.uploadSeconds ?? null},
              ${JSON.stringify(row.detail ?? {})}::jsonb)
    `);
  } catch (err) {
    // 台账写不进去不该让备份本身失败(备份可能已经传成功了), 但必须喊出来 ——
    // 台账是"最近一次成功"的唯一真相源, 它哑了 checkBackupFreshness 就会误报。
    logger.error({ err, row: row.kind }, "ops_backups 台账写入失败");
    void recordIncident({
      kind: "backup_ledger_write_failed",
      severity: "error",
      message: `备份台账写入失败(${row.kind}/${row.status}) —— 备份新鲜度检查会因此误报, 需人工核对 OSS 上的实际对象`,
      detail: { err: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ============ 每日备份 ============

export async function runDailyBackup(now: Date = new Date()): Promise<BackupResult> {
  const startedAt = Date.now();
  const date = beijingDateStr(now);
  const workDir = join(tmpdir(), `bossmate-backup-${date}-${startedAt}`);

  try {
    // ① 存储必须是 OSS —— 详见文件头 ①
    const isOss = Boolean(env.OSS_ENDPOINT && env.OSS_BUCKET && env.OSS_ACCESS_KEY && env.OSS_SECRET_KEY);
    if (!isOss) {
      throw new Error(
        "存储未配置为 OSS(缺 OSS_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY) —— " +
        "备份会落在与数据库同一台机器上, 等于没有备份。**刻意不降级存本地**: " +
        "跨云存放是本次改造的目的本身, 存本地会显示成功却毫无保护。",
      );
    }

    mkdirSync(workDir, { recursive: true });
    const prefix = `${env.BACKUP_OSS_PREFIX}/${date}`;
    const artifacts: BackupArtifact[] = [];

    // ② PostgreSQL 全库
    const pgFile = join(workDir, `postgres-${date}.sql.gz`);
    await run(
      "pg_dump",
      // --clean --if-exists: 恢复时先清干净, 免得往非空库里灌产生一半新一半旧的杂交状态。
      // --no-owner --no-privileges: 演练库/新机的角色名和生产不一定一样, 带上会整批报错。
      ["--clean", "--if-exists", "--no-owner", "--no-privileges", env.DATABASE_URL],
      { toFile: pgFile, gzip: true },
    );
    artifacts.push(await sealAndUpload("postgres", pgFile, `${prefix}/postgres-${date}.sql.gz`, MIN_PG_DUMP_BYTES));

    // ③ Redis RDB
    //    🔴 必须走 `redis-cli --rdb`(让服务端把 RDB 推过来), 不能直接拷 /var/lib/redis/dump.rdb ——
    //    实测那个文件是 redis:redis 660, 应用进程(ubuntu)**读不到**。直接拷会在生产上恒失败。
    const rdbRaw = join(workDir, `redis-${date}.rdb`);
    await run("redis-cli", ["-u", env.REDIS_URL, "--rdb", rdbRaw]);
    const rdbGz = `${rdbRaw}.gz`;
    await pipeline(
      (await import("fs")).createReadStream(rdbRaw),
      createGzip({ level: 6 }),
      createWriteStream(rdbGz),
    );
    artifacts.push(await sealAndUpload("redis", rdbGz, `${prefix}/redis-${date}.rdb.gz`, MIN_REDIS_RDB_BYTES));

    // ④ 保留期清理
    const { prunedCount, prunedPaths } = await pruneOldBackups(now);

    const durationMs = Date.now() - startedAt;
    for (const a of artifacts) {
      await recordBackupRow({
        kind: a.kind, status: "success", remotePath: a.remotePath,
        localBytes: a.localBytes, verifiedBytes: a.verifiedBytes, sha256: a.sha256,
        durationMs, uploadSeconds: a.uploadSeconds, detail: { date },
      });
    }
    logger.info({ date, artifacts: artifacts.length, prunedCount, durationMs }, "✅ 每日备份完成");
    return { date, artifacts, prunedCount, prunedPaths, durationMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordBackupRow({ kind: "daily", status: "failed", durationMs: Date.now() - startedAt, detail: { date, err: msg } });
    await recordIncident({
      kind: "backup_failed",
      severity: "error",
      message: `每日备份失败(${date}) —— 当前**没有**今天的可用备份, 而 03:30 的 60 天保留期清理照常会跑。原因: ${msg.slice(0, 260)}`,
      detail: { date, err: msg.slice(0, 1000) },
    });
    // 🔴 抛出去, 让 BullMQ 也记一次 failed。只落 incident 不抛 = 任务状态显示成功。
    throw err;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  }
}

/** 校验产物 → 上传 → **回查对象大小** → 三者对不上就失败 */
async function sealAndUpload(
  kind: BackupKind, localPath: string, remotePath: string, minBytes: number,
): Promise<BackupArtifact> {
  if (!existsSync(localPath)) throw new Error(`${kind}: 备份文件没生成 (${localPath})`);
  const localBytes = statSync(localPath).size;
  if (localBytes < minBytes) {
    throw new Error(`${kind}: 备份产物只有 ${localBytes} 字节(下限 ${minBytes}) —— 判定为损坏/截断, 不上传`);
  }
  await assertGzipIntact(localPath);
  const sha = sha256File(localPath);

  const storage = getStorage();
  // 🔴 private: bossmate-media 是**公共读**桶(平台要直接拉媒体 URL)。
  //   备份是全库 dump —— 不加对象级 ACL 就等于把整个客户数据库挂在公网可枚举的地址上。
  await storage.upload(readFileSync(localPath), remotePath, "application/gzip", { private: true });

  // 🔴 回查 —— put() 不抛错不等于对象真在桶里
  const head = await storage.head(remotePath);
  if (!head) throw new Error(`${kind}: 上传后回查不到对象 (${remotePath}) —— 判定为未上传成功`);
  if (head.size !== localBytes) {
    throw new Error(`${kind}: 上传后大小对不上 —— 本地 ${localBytes} vs OSS ${head.size} (${remotePath})`);
  }
  const uploadSeconds = getLastUploadSeconds();
  logger.info({ kind, remotePath, bytes: localBytes, uploadSeconds }, "备份已上传并回查通过");
  return { kind, remotePath, localBytes, verifiedBytes: head.size, sha256: sha, uploadSeconds };
}

/**
 * 清理超过保留期的备份。
 *
 * 按**路径里的日期**判定, 不按对象 mtime —— mtime 会被重传/迁移刷新,
 * 按它算会把该删的留下来(或把该留的删掉)。路径日期是备份自己声明的归属日, 稳定。
 */
export async function pruneOldBackups(now: Date = new Date()): Promise<{ prunedCount: number; prunedPaths: string[] }> {
  const storage = getStorage();
  const cutoff = new Date(now.getTime() - env.BACKUP_RETENTION_DAYS * 86400_000);
  const cutoffStr = beijingDateStr(cutoff);
  const all = await storage.list(`${env.BACKUP_OSS_PREFIX}/`, 5000);
  const prunedPaths: string[] = [];
  for (const obj of all) {
    const m = obj.path.match(/(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;              // 认不出日期的不动 —— 宁可留着也不误删
    if (m[1] >= cutoffStr) continue;
    await storage.delete(obj.path);
    prunedPaths.push(obj.path);
  }
  if (prunedPaths.length) logger.info({ count: prunedPaths.length, cutoffStr }, "备份保留期清理完成");
  return { prunedCount: prunedPaths.length, prunedPaths };
}

// ============ 每周恢复演练 ============

export interface DrillResult {
  remotePath: string;
  drillDb: string;
  tableCount: number;
  checkedTables: Array<{ table: string; restored: number; live: number }>;
  durationMs: number;
}

/**
 * 演练必须真到能证伪的程度。
 *
 * 只判断"pg_restore 退出码为 0"是不够的 —— 一个空 dump 也能被成功地灌进空库,
 * 退出码 0, 全程无异常, 而你什么都没恢复出来。这正是红线 #14 的形态:
 * **失败以成功的形态出现**。所以演练结束前要回答的是"库里到底有没有东西":
 *   · 表数量 > 0
 *   · 几张核心表的行数与生产同量级(允许演练期间的自然增量, 但不许是 0 或断崖式缺失)
 */
const DRILL_CHECK_TABLES = ["contents", "journals", "tenants", "ops_incidents"];
/** 恢复行数低于生产的这个比例即判失败 —— 留出演练与备份之间的时间差 */
const DRILL_MIN_ROW_RATIO = 0.5;

export async function runBackupRestoreDrill(now: Date = new Date()): Promise<DrillResult> {
  const startedAt = Date.now();
  const stamp = `${beijingDateStr(now).replace(/-/g, "")}_${startedAt}`;
  const drillDb = `bossmate_drill_${stamp}`;
  const workDir = join(tmpdir(), `bossmate-drill-${stamp}`);
  const adminUrl = env.DATABASE_URL;
  let created = false;

  try {
    // ① 找最近一次成功的 postgres 备份
    const latest = await db.execute(sql`
      SELECT remote_path, local_bytes, sha256, created_at
      FROM ops_backups
      WHERE kind = 'postgres' AND status = 'success' AND remote_path IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `);
    const row = (latest as unknown as { rows: Array<{ remote_path: string; local_bytes: string; sha256: string; created_at: Date }> }).rows?.[0];
    if (!row) throw new Error("台账里没有任何成功的 postgres 备份 —— 无从演练(这本身就是个红灯)");

    // ② 拉回来
    mkdirSync(workDir, { recursive: true });
    const localFile = join(workDir, "restore.sql.gz");
    const buf = await getStorage().download(row.remote_path);
    (await import("fs")).writeFileSync(localFile, buf);

    // ③ 校验完整性 + 指纹。指纹对不上说明桶里的对象和备份时的不是同一个东西
    await assertGzipIntact(localFile);
    const sha = sha256File(localFile);
    if (row.sha256 && sha !== row.sha256) {
      throw new Error(`备份指纹对不上 —— 台账 ${row.sha256.slice(0, 12)}… vs 实际 ${sha.slice(0, 12)}… (${row.remote_path})`);
    }

    // ④ 建临时库并恢复
    //    🔴 必须走 psql + DATABASE_URL, 不能用裸 `createdb drillDb`:
    //    createdb 不带连接参数时按 PGHOST/PGUSER/系统当前用户去连, 而生产的库凭据只在
    //    DATABASE_URL 里 —— 那样写演练**首跑就必然失败**, 而且失败原因看着像"权限问题"。
    await psqlExec(adminUrl, `CREATE DATABASE "${drillDb}" TEMPLATE template0`);
    created = true;
    const drillUrl = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${drillDb}$1`);
    if (!drillUrl.includes(drillDb)) throw new Error("拼不出演练库连接串 —— DATABASE_URL 形态异常, 中止(不拿生产库当演练库)");
    await restoreGzInto(localFile, drillUrl);

    // ⑤ 证伪式校验 —— 见上方注释
    const { tableCount, checked } = await inspectRestored(drillUrl);
    if (tableCount === 0) throw new Error("恢复后库里一张表都没有 —— 备份是空的");
    for (const c of checked) {
      if (c.live > 0 && c.restored < Math.floor(c.live * DRILL_MIN_ROW_RATIO)) {
        throw new Error(
          `恢复后 ${c.table} 只有 ${c.restored} 行, 生产 ${c.live} 行(低于 ${DRILL_MIN_ROW_RATIO * 100}% 阈值) —— 备份内容缺失`,
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    await recordBackupRow({
      kind: "drill", status: "success", remotePath: row.remote_path,
      localBytes: buf.length, verifiedBytes: buf.length, sha256: sha, durationMs,
      detail: { drillDb, tableCount, checked },
    });
    logger.info({ drillDb, tableCount, durationMs }, "✅ 恢复演练通过");
    return { remotePath: row.remote_path, drillDb, tableCount, checkedTables: checked, durationMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordBackupRow({ kind: "drill", status: "failed", durationMs: Date.now() - startedAt, detail: { drillDb, err: msg } });
    await recordIncident({
      kind: "backup_drill_failed",
      severity: "error",
      message: `恢复演练失败 —— 备份文件在, 但**没能证明它能恢复**。没验证过能恢复的备份不算备份。原因: ${msg.slice(0, 260)}`,
      detail: { drillDb, err: msg.slice(0, 1000) },
    });
    throw err;
  } finally {
    // 演练库必须回收, 否则每周攒一个 240MB 的库, 半年把 49G 磁盘吃光 ——
    // 那会变成"备份机制自己制造了一次生产事故"。
    if (created) {
      try { await psqlExec(adminUrl, `DROP DATABASE IF EXISTS "${drillDb}"`); }
      catch (e) {
        logger.error({ drillDb, e }, "演练库删除失败");
        void recordIncident({
          kind: "backup_drill_cleanup_failed", severity: "warn",
          message: `演练库 ${drillDb} 没删掉 —— 需人工 dropdb, 否则每周积累一个全量库会吃满磁盘`,
          detail: { drillDb },
        });
      }
    }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 用 DATABASE_URL 的凭据执行一条管理语句(建库/删库)。
 *
 * drillDb 由本文件用时间戳拼出(`bossmate_drill_<数字>`), 不含外部输入; 仍加双引号包裹,
 * 免得将来有人把它改成可配置的就成了注入面。
 */
async function psqlExec(url: string, statement: string): Promise<void> {
  await run("psql", ["--quiet", "-v", "ON_ERROR_STOP=1", url, "-c", statement]);
}

/** zcat file | psql <url> —— 用 node 解压再喂给 psql, 免得依赖 shell 的 pipefail */
async function restoreGzInto(gzPath: string, url: string): Promise<void> {
  const { createReadStream } = await import("fs");
  const { createGunzip } = await import("zlib");
  await new Promise<void>((resolve, reject) => {
    // ON_ERROR_STOP=1: 没有它 psql 会把报错当日志继续往下跑, 最后退出码 0 ——
    //   又一个"失败被洗成成功"。演练的全部意义就在这个开关上。
    const child = spawn("psql", ["--quiet", "-v", "ON_ERROR_STOP=1", url], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d).slice(0, 4000); });
    child.on("error", (e) => reject(new Error(`psql 起不来: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql 恢复失败(退出码 ${code}): ${stderr.slice(0, 500)}`));
    });
    pipeline(createReadStream(gzPath), createGunzip(), child.stdin).catch((e) =>
      reject(new Error(`解压喂给 psql 失败: ${(e as Error).message}`)),
    );
  });
}

/** 连演练库数表和行数, 并取生产同表行数做对比 */
async function inspectRestored(drillUrl: string): Promise<{
  tableCount: number; checked: Array<{ table: string; restored: number; live: number }>;
}> {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: drillUrl });
  await client.connect();
  try {
    const t = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema='public'",
    );
    const tableCount = Number(t.rows[0]?.n ?? 0);
    const checked: Array<{ table: string; restored: number; live: number }> = [];
    for (const table of DRILL_CHECK_TABLES) {
      // 表名来自本文件的常量白名单, 不接受外部输入 —— 不存在注入面
      let restored = 0;
      try {
        const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
        restored = Number(r.rows[0]?.n ?? 0);
      } catch { restored = -1; }   // 表不存在 → -1, 下游按"缺失"处理
      const liveRes = await db.execute(sql.raw(`SELECT count(*)::text AS n FROM ${table}`));
      const live = Number((liveRes as unknown as { rows: Array<{ n: string }> }).rows?.[0]?.n ?? 0);
      if (restored < 0) throw new Error(`恢复后缺表: ${table}`);
      checked.push({ table, restored, live });
    }
    return { tableCount, checked };
  } finally {
    await client.end();
  }
}

// ============ 新鲜度看门狗(答"压根没跑"这个问题) ============

/**
 * 9-04: 近 7 天最长上传耗时 —— 周报用。
 *
 * 🔴 这一项不是告警, 是**趋势**。
 *
 * ⚠️ 9-04 更正: 这段原本写着"超过 20MB 走分片, 不再受 60 秒那条线约束" —— **是错的**。
 * ali-oss 的 60 秒是**每次 HTTP 响应**的超时, 分片只是把一个大请求拆成多个,
 * 每一片仍受同一条限制。真正解掉它的是客户端的 `timeout: 600000`(见 OssStorage 类注释)。
 * 当日实测: postgres 备份 45MB 上传 **67.3 秒** —— 旧的 60 秒配置下这次必失败。
 *
 * 所以这个数仍要报, 而且比原来更重要: 它同时反映网络与库增长,
 * 是"什么时候该动手"的唯一先行指标。判据见下方 renderUploadTrend 的文案。
 *
 * 报法上刻意**只报数不催** —— 与 8-24 那条「一个不需要行动的指标必须明说不需要行动」同源:
 * 逐周看趋势, 涨了才需要人管。
 */
export interface UploadTrend { maxSeconds: number | null; samples: number; error: string | null }

export async function collectUploadTrend(days = 7): Promise<UploadTrend> {
  try {
    const res = await db.execute(sql`
      SELECT MAX(upload_seconds)::float8 AS max_s, COUNT(upload_seconds)::int AS n
      FROM ops_backups
      WHERE status = 'success' AND upload_seconds IS NOT NULL
        AND created_at > NOW() - (${days} || ' days')::interval
    `);
    const r = (res as unknown as { rows?: Array<{ max_s: number | null; n: number }> }).rows?.[0];
    return { maxSeconds: r?.max_s ?? null, samples: Number(r?.n ?? 0), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "upload_trend.collect_failed");
    return { maxSeconds: null, samples: 0, error: msg.slice(0, 160) };
  }
}

/** 渲染成周报一行。判据与渲染分开 */
export function renderUploadTrend(t: UploadTrend, days = 7): string {
  if (t.error) return `  ⚠️ 上传耗时**没查成**(≠ 一切正常): ${t.error}`;
  if (t.samples === 0) return `  近 ${days} 天没有成功的备份上传记录 —— 这本身值得看一眼(备份是否在跑?)`;
  const s = (t.maxSeconds ?? 0).toFixed(1);
  return `  近 ${days} 天备份上传最长 ${s} 秒（${t.samples} 次；仅供参考，无需处理。逐周看：涨 = 库在长或网络在变慢；持续 >300 秒 = 带宽问题，不是超时问题）`;
}

export interface FreshnessIssue { level: "alert" | "warn"; text: string }

/**
 * 拿**成功**时间戳和当前时间比对。
 *
 * 为什么不能只靠 incident: 见文件头。任务没跑 = 没有失败 = 没有 incident = 监控全绿。
 * 这个函数是唯一能发现"备份压根没执行"的地方, 由每日简报调用。
 */
export async function checkBackupFreshness(now: Date = new Date()): Promise<FreshnessIssue[]> {
  const issues: FreshnessIssue[] = [];
  if (!env.BACKUP_ENABLED) {
    issues.push({ level: "alert", text: "备份已被 BACKUP_ENABLED=false 关闭 —— 当前没有任何自动备份在跑" });
    return issues;
  }
  try {
    const res = await db.execute(sql`
      SELECT kind, max(created_at) AS last_ok
      FROM ops_backups WHERE status = 'success' GROUP BY kind
    `);
    const rows = (res as unknown as { rows: Array<{ kind: string; last_ok: Date }> }).rows ?? [];
    const lastOk = new Map(rows.map((r) => [r.kind, new Date(r.last_ok)]));

    for (const kind of ["postgres", "redis"] as const) {
      const at = lastOk.get(kind);
      if (!at) {
        issues.push({ level: "alert", text: `${kind} 备份**从未成功过** —— 台账里一条成功记录都没有` });
        continue;
      }
      const hours = (now.getTime() - at.getTime()) / 3600_000;
      if (hours > env.BACKUP_STALE_HOURS) {
        issues.push({
          level: "alert",
          text: `${kind} 最近一次成功备份是 ${Math.floor(hours)} 小时前(阈值 ${env.BACKUP_STALE_HOURS}h) —— 备份任务可能压根没在跑`,
        });
      }
    }

    if (env.BACKUP_DRILL_ENABLED) {
      const at = lastOk.get("drill");
      if (!at) {
        issues.push({ level: "warn", text: "恢复演练**从未成功过** —— 备份还没被证明能恢复" });
      } else {
        const days = (now.getTime() - at.getTime()) / 86400_000;
        if (days > env.BACKUP_DRILL_STALE_DAYS) {
          issues.push({
            level: "warn",
            text: `最近一次成功的恢复演练是 ${Math.floor(days)} 天前(阈值 ${env.BACKUP_DRILL_STALE_DAYS}d)`,
          });
        }
      }
    }
  } catch (err) {
    // 🔴 查不动也要喊 —— 静默返回空数组 = 简报显示"备份正常", 正是本文件要防的形态
    issues.push({
      level: "alert",
      text: `备份新鲜度检查**没跑成**(≠ 备份正常): ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return issues;
}
