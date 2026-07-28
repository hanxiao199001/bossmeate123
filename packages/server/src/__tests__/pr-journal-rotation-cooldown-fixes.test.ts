/**
 * 7-28 (#4/#5) — 期刊轮转两处修复的结构守卫。
 *
 * #4 roundup 锁死 48 本: `ORDER BY acceptance_rate DESC NULLS LAST` 让有精确录用率的 LetPub 48 本
 *    永远霸榜, 冷却一轮完又是同一批; 且 `discipline ILIKE` 旧口径匹配不上国内刊中文学科名。
 * #5 冷却被误清空: daily-cron 占位 usage 行不带 contentId, batch-worker 失败回滚删
 *    `contentId IS NULL` 的**全部**行 → 一次失败清光该刊全部历史冷却, 15 天承诺归零。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ROUNDUP = "../services/content-engine/roundup-generator.ts";
const WORKER = "../services/batch/batch-worker.ts";
const CRON = "../services/recommendation/daily-cron.ts";

describe("#4 roundup 选刊: 去录用率排序偏置 + discipline_code 口径", () => {
  it("orderBy 不再有 acceptance_rate DESC(48 本霸榜偏置), 改随机轮转", async () => {
    const src = await readSrc(ROUNDUP);
    expect(src).not.toMatch(/acceptanceRate\}\s*DESC NULLS LAST/);
    // 对口刊优先 + random(): 池内随机, 15天冷却(NOT EXISTS)保证不重复
    expect(src).toMatch(/\.orderBy\(sql`\(\$\{journals\.disciplineCode\}\s*=\s*\$\{opts\.discipline \?\? ""\}\) DESC, random\(\)`\)/);
  });

  it("学科过滤打 discipline_code(migration 026 口径), generic 综合刊可补位, 保留 ILIKE 兼容中文名", async () => {
    const src = await readSrc(ROUNDUP);
    expect(src).toMatch(/journals\.disciplineCode\}\s*=\s*\$\{opts\.discipline\}/);
    expect(src).toMatch(/GENERIC_DISCIPLINE_CODE/);
    expect(src).toMatch(/import \{ GENERIC_DISCIPLINE_CODE \} from "\.\.\/recommendation\/discipline-mapping\.js"/);
    // ILIKE 兜底仍在(管理端手填中文学科名的调用不破坏)
    expect(src).toMatch(/journals\.discipline\} ILIKE/);
  });

  it("15 天冷却 NOT EXISTS 仍在(轮转的根本保障, 不许被顺手删掉)", async () => {
    const src = await readSrc(ROUNDUP);
    expect(src).toMatch(/NOT EXISTS[\s\S]*?journal_usage[\s\S]*?JOURNAL_REUSE_COOLDOWN_DAYS/);
  });
});

describe("#5 冷却不被误清空: 占位回填 + 回滚加时间窗", () => {
  it("失败回滚只删 2 天窗口内的 NULL 占位行, 不再整锅删光历史冷却", async () => {
    const src = await readSrc(WORKER);
    // delete 块里必须同时有 isNull(contentId) 和时间窗
    const delStart = src.indexOf("db.delete(journalUsage)");
    expect(delStart).toBeGreaterThan(-1);
    const delBlock = src.slice(delStart, delStart + 400);
    expect(delBlock).toMatch(/isNull\(journalUsage\.contentId\)/);
    expect(delBlock).toMatch(/usedAt\} > NOW\(\) - interval '2 days'/);
  });

  it("生成产出内容(generated/needs_review)后回填占位行 contentId, 使其脱离回滚误伤面", async () => {
    const src = await readSrc(WORKER);
    const updStart = src.indexOf("db.update(journalUsage)");
    expect(updStart).toBeGreaterThan(-1);
    const updBlock = src.slice(updStart, updStart + 500);
    expect(updBlock).toMatch(/\.set\(\{ contentId: content\.id \}\)/);
    expect(updBlock).toMatch(/isNull\(journalUsage\.contentId\)/);
    expect(updBlock).toMatch(/interval '2 days'/);
    // 回填必须在最终失败回滚之前的成功路径上(源码顺序: update 在 delete 之前)
    expect(updStart).toBeLessThan(src.indexOf("db.delete(journalUsage)"));
  });

  it("daily-cron 占位写入处有 #5 说明注释(占位语义 + 回填/窗口约定), 防后人当 bug 改掉", async () => {
    const src = await readSrc(CRON);
    expect(src).toMatch(/占位冷却[\s\S]*?await db\.insert\(journalUsage\)\.values\(\{ tenantId: SYS, journalId \}\)/);
  });

  it("roundup/成功内容的冷却行带 contentId(历史行为不回归)", async () => {
    const src = await readSrc(CRON);
    expect(src).toMatch(/journalIds\.map\(\(jid\) => \(\{ tenantId: SYS, journalId: jid, contentId: row\.id \}\)\)/);
  });
});
