/**
 * 一个 batch_row 最多一条 content（8-17）。
 *
 * 8-16 夜实况：百炼欠费致生成全失败，同一 batch_row 被重试 4 次，
 * 每次新插一行空壳（标题=topic、正文 0 字），一晚 32 条落进内容工坊。
 *
 * 这里锁的是**设计选择**，不是实现细节 —— 因为这几条判断错了不会报错，
 * 只会在下一次故障风暴时重演。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../models/migrations.js";

const mig = MIGRATIONS.find((m) => m.version === "035_contents_batch_row_unique");

describe("① 约束本身", () => {
  it("migration 存在且是**部分**唯一索引（历史 NULL 行不受约束）", () => {
    expect(mig).toBeTruthy();
    expect(mig!.sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*batch_row_id[\s\S]*WHERE\s+batch_row_id\s+IS\s+NOT\s+NULL/i);
  });

  /**
   * 🔴 为什么不是 (标题+日期)：会误伤合法内容。
   * 实测 3 组「普通院校教师发核心」是非 batch 链路的真产物、正文 8000+ 字、
   * batchRowId 为 null —— 同一标题配不同刊本来就会撞。
   */
  it("键是 batch_row_id，不是标题+日期", () => {
    expect(mig!.sql).not.toMatch(/UNIQUE INDEX[\s\S]*\(\s*tenant_id\s*,\s*title/i);
  });

  it("退回方式写在 description 里（不可逆操作的老规矩）", () => {
    expect(mig!.description).toContain("退回执行");
  });
});

describe("② 冲突处理必须同时存在", () => {
  /**
   * 🔴 只加约束不加冲突处理 = 约束上线那天重试风暴撞上唯一键，batch 全线崩。
   * 约束防重复，冲突处理保韧性，缺一半都不行。
   */
  /**
   * 🔴 部分索引必须把索引谓词写进 ON CONFLICT，否则 Postgres 推断不出来，
   * 运行期直接抛 42P10「no unique or exclusion constraint matching」——
   * 8-17 部署后自测当场撞到，正是"约束上线那天 batch 全线崩"的另一种死法。
   * 这条比 onConflictDoNothing 本身更容易漏：类型检查过、单测过，只有真连库才炸。
   */
  it("ON CONFLICT 带上索引谓词(where isNotNull) —— 部分索引推断不出来会 42P10", () => {
    const src = readFileSync(new URL("../services/batch/batch-worker.ts", import.meta.url), "utf8");
    const i = src.indexOf(".onConflictDoNothing");
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 200)).toMatch(/where:\s*isNotNull\(/);
  });

  it("插入点带 onConflictDoNothing，且冲突后复用既有行", () => {
    const src = readFileSync(new URL("../services/batch/batch-worker.ts", import.meta.url), "utf8");
    const i = src.indexOf(".insert(contents)");
    expect(i).toBeGreaterThan(0);
    const window = src.slice(i, i + 2600);
    expect(window).toContain("onConflictDoNothing");
    // 冲突后必须去取既有那条, 而不是抛错了事
    expect(window).toMatch(/select[\s\S]*batchRowId/);
  });

  it("batchRowId 同时写进列（被约束的是列，不是 metadata）", () => {
    const src = readFileSync(new URL("../services/batch/batch-worker.ts", import.meta.url), "utf8");
    const i = src.indexOf(".insert(contents)");
    expect(src.slice(i, i + 900)).toMatch(/batchRowId:\s*rowId/);
  });
});
