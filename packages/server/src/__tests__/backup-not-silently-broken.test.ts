/**
 * 备份体系 (8-26)。
 *
 * 【背景】盘点发现生产**零自动备份**: pg/redis 都是本机自建, `~/db-backups/` 里只有
 * 7-19/7-20 两个手打的 pre-migration dump(与数据库同盘), 全仓无 pg_dump、无 crontab、
 * 无备份脚本; 而每日 03:30 的保留期清理照常删 60 天前内容。
 *
 * 【这组用例锁的不是"备份能跑通", 是"备份坏掉时必须看得出来"】
 * 一个坏掉的备份和一个好用的备份, 在你需要它之前看起来完全一样 ——
 * 这正是 CLAUDE.md 红线 #14 那五次事故的形态, 备份是它最危险的应用场景。
 * 所以每条用例都在问同一个问题: **这条失败路径走过之后, 有没有任何东西变得和成功不一样?**
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const ENV: Record<string, unknown> = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/bossmate",
  REDIS_URL: "redis://localhost:6379",
  BACKUP_ENABLED: true,
  BACKUP_RETENTION_DAYS: 30,
  BACKUP_OSS_PREFIX: "_backups",
  BACKUP_DRILL_ENABLED: true,
  BACKUP_STALE_HOURS: 30,
  BACKUP_DRILL_STALE_DAYS: 8,
  OSS_ENDPOINT: "oss-cn-beijing.aliyuncs.com",
  OSS_BUCKET: "bossmate-media",
  OSS_ACCESS_KEY: "ak",
  OSS_SECRET_KEY: "sk",
};
vi.mock("../config/env.js", () => ({ env: new Proxy({}, { get: (_t, k) => ENV[k as string] }) }));

vi.mock("drizzle-orm", () => {
  const tag = (..._a: unknown[]) => ({ __sql: true });
  return { sql: Object.assign(tag, { raw: tag, join: tag }) };
});

/** db.execute 的返回由每个用例摆 */
let dbRows: Array<Record<string, unknown>> = [];
let dbThrows: Error | null = null;
vi.mock("../models/db.js", () => ({
  db: {
    execute: vi.fn(async () => {
      if (dbThrows) throw dbThrows;
      return { rows: dbRows };
    }),
  },
}));

const recordIncidentSpy = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../services/ops/incidents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ops/incidents.js")>()),
  recordIncident: (...a: unknown[]) => recordIncidentSpy(...a),
}));

/** 可编程的假 OSS */
const ossObjects: Array<{ path: string; size: number; lastModified: Date }> = [];
const deleted: string[] = [];
vi.mock("../services/storage/index.js", () => ({
  getStorage: () => ({
    upload: vi.fn(async () => "https://oss/x"),
    delete: vi.fn(async (p: string) => { deleted.push(p); }),
    head: vi.fn(async (p: string) => ossObjects.find((o) => o.path === p) ?? null),
    list: vi.fn(async (prefix: string) => ossObjects.filter((o) => o.path.startsWith(prefix))),
    download: vi.fn(async () => Buffer.from("x")),
    getSignedUrl: vi.fn(async () => "https://oss/signed"),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  dbRows = []; dbThrows = null; ossObjects.length = 0; deleted.length = 0;
  Object.assign(ENV, {
    BACKUP_ENABLED: true, BACKUP_DRILL_ENABLED: true,
    BACKUP_STALE_HOURS: 30, BACKUP_DRILL_STALE_DAYS: 8, BACKUP_RETENTION_DAYS: 30,
    OSS_ENDPOINT: "oss-cn-beijing.aliyuncs.com", OSS_BUCKET: "bossmate-media",
    OSS_ACCESS_KEY: "ak", OSS_SECRET_KEY: "sk",
  });
});

const NOW = new Date("2026-08-26T18:00:00Z"); // BJ 8-27 02:00

describe("① 存储不是 OSS 时必须失败, 不许降级存本地", () => {
  it("缺 OSS 配置 → 抛错 + 落 backup_failed(而不是悄悄写到本机)", async () => {
    ENV.OSS_ENDPOINT = undefined;
    const { runDailyBackup } = await import("../services/ops/backup.js");
    await expect(runDailyBackup(NOW)).rejects.toThrow(/OSS/);
    const kinds = recordIncidentSpy.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain("backup_failed");
  });

  it("🔴 落在同一台机器上的备份不算备份 —— 报错里要说清这一点, 免得有人「顺手」加个本地兜底", async () => {
    ENV.OSS_BUCKET = undefined;
    const { runDailyBackup } = await import("../services/ops/backup.js");
    await expect(runDailyBackup(NOW)).rejects.toThrow(/同一台机器|跨云/);
  });
});

describe("② 保留期清理按路径日期算, 不按 mtime", () => {
  it("超过 30 天的删, 没超的留", async () => {
    // mtime 全部设成"刚刚"—— 如果实现按 mtime 判, 这条会一个都不删
    const t = new Date("2026-08-26T00:00:00Z");
    ossObjects.push(
      { path: "_backups/2026-08-26/postgres-2026-08-26.sql.gz", size: 1, lastModified: t },
      { path: "_backups/2026-07-28/postgres-2026-07-28.sql.gz", size: 1, lastModified: t }, // 29 天前 → 留
      { path: "_backups/2026-06-01/postgres-2026-06-01.sql.gz", size: 1, lastModified: t }, // 远超 → 删
      { path: "_backups/2026-06-01/redis-2026-06-01.rdb.gz", size: 1, lastModified: t },
    );
    const { pruneOldBackups } = await import("../services/ops/backup.js");
    const r = await pruneOldBackups(NOW);
    expect(r.prunedCount).toBe(2);
    expect(deleted.every((p) => p.includes("2026-06-01"))).toBe(true);
  });

  it("路径里认不出日期的对象不动 —— 宁可留着也不误删", async () => {
    ossObjects.push({ path: "_backups/README.txt", size: 1, lastModified: new Date("2020-01-01") });
    const { pruneOldBackups } = await import("../services/ops/backup.js");
    expect((await pruneOldBackups(NOW)).prunedCount).toBe(0);
  });
});

describe("③ 🔴 看门狗: '压根没跑'不产生任何失败, 只能靠正向时间戳发现", () => {
  it("台账里一条成功记录都没有 → alert(而不是安静地什么都不说)", async () => {
    dbRows = [];
    const { checkBackupFreshness } = await import("../services/ops/backup.js");
    const issues = await checkBackupFreshness(NOW);
    const texts = issues.map((i) => i.text).join(" | ");
    expect(texts).toMatch(/postgres.*从未成功/);
    expect(texts).toMatch(/redis.*从未成功/);
    expect(issues.filter((i) => i.level === "alert").length).toBeGreaterThanOrEqual(2);
  });

  it("最近一次成功超过阈值 → alert", async () => {
    const old = new Date(NOW.getTime() - 40 * 3600_000);
    dbRows = [{ kind: "postgres", last_ok: old }, { kind: "redis", last_ok: old }, { kind: "drill", last_ok: NOW }];
    const { checkBackupFreshness } = await import("../services/ops/backup.js");
    const issues = await checkBackupFreshness(NOW);
    expect(issues.filter((i) => i.level === "alert")).toHaveLength(2);
    expect(issues[0].text).toMatch(/40 小时前/);
  });

  it("都新鲜 → 零问题", async () => {
    dbRows = [{ kind: "postgres", last_ok: NOW }, { kind: "redis", last_ok: NOW }, { kind: "drill", last_ok: NOW }];
    const { checkBackupFreshness } = await import("../services/ops/backup.js");
    expect(await checkBackupFreshness(NOW)).toHaveLength(0);
  });

  it("BACKUP_ENABLED=false → 明确报出来, 不是「没问题」", async () => {
    ENV.BACKUP_ENABLED = false;
    const { checkBackupFreshness } = await import("../services/ops/backup.js");
    const issues = await checkBackupFreshness(NOW);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("alert");
    expect(issues[0].text).toMatch(/关闭/);
  });

  it("🔴 检查本身查不动时报 alert —— 静默返回空数组等于告诉运营「备份正常」", async () => {
    dbThrows = new Error("connection refused");
    const { checkBackupFreshness } = await import("../services/ops/backup.js");
    const issues = await checkBackupFreshness(NOW);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("alert");
    expect(issues[0].text).toMatch(/没跑成/);
  });

  it("演练过期只报 warn(备份还在, 只是没验证过), 与备份本身缺失区分开", async () => {
    dbRows = [
      { kind: "postgres", last_ok: NOW }, { kind: "redis", last_ok: NOW },
      { kind: "drill", last_ok: new Date(NOW.getTime() - 20 * 86400_000) },
    ];
    const { checkBackupFreshness } = await import("../services/ops/backup.js");
    const issues = await checkBackupFreshness(NOW);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warn");
    expect(issues[0].text).toMatch(/演练/);
  });
});

describe("④ 每个新 kind 都要有人话 label(否则简报里念英文标识符)", () => {
  it("backup_* 全部进了 KIND_LABEL", async () => {
    const { KIND_LABEL } = await import("../services/ops/incidents.js");
    for (const k of [
      "backup_failed", "backup_drill_failed", "backup_stale",
      "backup_ledger_write_failed", "backup_drill_cleanup_failed",
    ]) {
      expect(KIND_LABEL[k], `KIND_LABEL 缺 ${k}`).toBeTruthy();
      expect(KIND_LABEL[k]).not.toMatch(/^backup_/);
    }
  });
});
