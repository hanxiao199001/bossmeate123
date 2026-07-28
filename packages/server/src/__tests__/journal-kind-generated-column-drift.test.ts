/**
 * journal_kind 生成列「漂移守卫」—— 交接护栏 (7-28)。照搬 discipline_code 那一套, 原因也一样。
 *
 * ## 守什么
 * `journals.journal_kind` 是 Postgres **生成列**(`GENERATED ALWAYS AS (...) STORED`),
 * 表达式由 `services/journals/journal-kind.ts` 的 `buildJournalKindSql()` 从信号定义生成,
 * 并在 migration `029_journals_journal_kind` 建列时**固化进了 DDL**。
 *
 * 生成列建好后就不再回看 TS 代码。于是有这么个静默陷阱:
 *   改了信号定义(加一个国内目录标签 / 把 cas_partition 挪出国际信号) → TS 的 `toJournalKind()`
 *   立刻生效, 但**数据库里那一列纹丝不动** → 两边规则不一致。
 *
 * 后果同样是纯静默的: 选刊器按 `journal_kind` 过滤 scope、可信门槛按 `journal_kind` 分体系,
 *   规则一漂就是"某个 scope 的刊突然少了一批"或"国内刊又开始过不了门槛", 日志一句都不会报错。
 *
 * ## 红了怎么办 —— 不要直接改快照让它变绿
 * 见下方 DRIFT_HOWTO。
 */
import { describe, it, expect } from "vitest";
import { buildJournalKindSql } from "../services/journals/journal-kind.js";
import { MIGRATIONS } from "../models/migrations.js";

/** 快照来源 migration。新加重建列的 migration 后, 这里要一起改成新版本号。 */
const SNAPSHOT_SOURCE_MIGRATION = "030_journals_journal_kind_rebuild";

/**
 * 🧊 冻结快照 —— migration 029 固化进生产库的 journal_kind 生成列表达式。
 *
 * ⚠️ 这不是"期望值", 是"生产库现状"。**不要为了让测试变绿而重新生成它**。
 */
const FROZEN_JOURNAL_KIND_SQL = `CASE
    WHEN coalesce((impact_factor IS NOT NULL OR btrim(coalesce("partition", '')) <> '' OR btrim(coalesce(cas_partition, '')) <> '' OR btrim(coalesce(cas_partition_new, '')) <> '' OR (btrim(coalesce(jcr_full->>'wosLevel', '')) <> '' OR (jsonb_typeof(jcr_full->'jifSubjects') = 'array' AND jsonb_array_length(jcr_full->'jifSubjects') > 0) OR (jsonb_typeof(jcr_full->'jciSubjects') = 'array' AND jsonb_array_length(jcr_full->'jciSubjects') > 0))), false) AND NOT coalesce(((jsonb_typeof(catalogs) = 'array' AND jsonb_array_length(catalogs) > 0) OR btrim(coalesce(cscd_level, '')) <> '' OR btrim(coalesce(pku_core_level, '')) <> '' OR btrim(coalesce(catalog_type, '')) IN ('pku-core', 'cssci', 'cssci-ext', 'cscd', 'cstpcd') OR btrim(coalesce(cn_number, '')) <> '' OR composite_impact_factor IS NOT NULL), false) THEN 'intl'
    WHEN coalesce((impact_factor IS NOT NULL OR btrim(coalesce("partition", '')) <> '' OR btrim(coalesce(cas_partition, '')) <> '' OR btrim(coalesce(cas_partition_new, '')) <> '' OR (btrim(coalesce(jcr_full->>'wosLevel', '')) <> '' OR (jsonb_typeof(jcr_full->'jifSubjects') = 'array' AND jsonb_array_length(jcr_full->'jifSubjects') > 0) OR (jsonb_typeof(jcr_full->'jciSubjects') = 'array' AND jsonb_array_length(jcr_full->'jciSubjects') > 0))), false) AND coalesce(((jsonb_typeof(catalogs) = 'array' AND jsonb_array_length(catalogs) > 0) OR btrim(coalesce(cscd_level, '')) <> '' OR btrim(coalesce(pku_core_level, '')) <> '' OR btrim(coalesce(catalog_type, '')) IN ('pku-core', 'cssci', 'cssci-ext', 'cscd', 'cstpcd') OR btrim(coalesce(cn_number, '')) <> '' OR composite_impact_factor IS NOT NULL), false) THEN 'both'
    WHEN coalesce(((jsonb_typeof(catalogs) = 'array' AND jsonb_array_length(catalogs) > 0) OR btrim(coalesce(cscd_level, '')) <> '' OR btrim(coalesce(pku_core_level, '')) <> '' OR btrim(coalesce(catalog_type, '')) IN ('pku-core', 'cssci', 'cssci-ext', 'cscd', 'cstpcd') OR btrim(coalesce(cn_number, '')) <> '' OR composite_impact_factor IS NOT NULL), false) THEN 'cn'
    ELSE 'unknown'
  END`;

const DRIFT_HOWTO = [
  "",
  "════════════════════════════════════════════════════════════════════════",
  " journal_kind 生成列漂移 —— 你改了 journal-kind.ts 的信号定义,",
  " 但数据库里的 journals.journal_kind 生成列**不会自动重算**。",
  "════════════════════════════════════════════════════════════════════════",
  "",
  " 正确改法(三步都要做, 缺一不可):",
  "   1) packages/server/src/models/migrations.ts 数组**末尾追加**一条新 migration:",
  "        {",
  "          version: \"0NN_journals_journal_kind_rebuild\",",
  "          description: \"信号定义变更后重建 journal_kind 生成列(说明改了什么)\",",
  "          sql: `",
  "            ALTER TABLE journals DROP COLUMN IF EXISTS journal_kind;",
  "            ALTER TABLE journals ADD COLUMN journal_kind varchar(12)",
  "              GENERATED ALWAYS AS (${buildJournalKindSql()}) STORED;",
  "            CREATE INDEX IF NOT EXISTS idx_journals_kind_pick ON journals (journal_kind, discipline_code, status);",
  "          `,",
  "        }",
  "      (8744 行全表重写是毫秒级; 别改已发布的 029, 改了也不会重跑)",
  "   2) 回到本文件, 把 FROZEN_JOURNAL_KIND_SQL 更新为新表达式, SNAPSHOT_SOURCE_MIGRATION 改成新 version。",
  "   3) 部署后跑 `pnpm db:migrate`, 确认新 migration 真的应用到生产库。",
  "════════════════════════════════════════════════════════════════════════",
].join("\n");

describe("journal_kind 生成列漂移守卫", () => {
  it("buildJournalKindSql() 当前输出 == migration 固化进生产库的表达式", () => {
    expect(buildJournalKindSql(), DRIFT_HOWTO).toBe(FROZEN_JOURNAL_KIND_SQL);
  });

  it("快照来源 migration 仍是最后一条重建 journal_kind 生成列的迁移", () => {
    const rebuilds = MIGRATIONS.filter(
      (m) => /journal_kind/.test(m.sql) && /GENERATED ALWAYS AS/.test(m.sql),
    );
    expect(rebuilds.length, "找不到任何重建 journal_kind 生成列的 migration —— 029 被删了?").toBeGreaterThan(0);
    expect(
      rebuilds[rebuilds.length - 1].version,
      "新加了重建 journal_kind 的 migration, 但本文件的快照没跟着更新。" + DRIFT_HOWTO,
    ).toBe(SNAPSHOT_SOURCE_MIGRATION);
  });

  it("该 migration 里写进 DDL 的确实是这份表达式(防有人手改 migration 文本)", () => {
    const m = MIGRATIONS.find((x) => x.version === SNAPSHOT_SOURCE_MIGRATION);
    expect(m, `migrations.ts 里找不到 ${SNAPSHOT_SOURCE_MIGRATION}`).toBeDefined();
    expect(m!.sql).toContain(FROZEN_JOURNAL_KIND_SQL);
    expect(m!.sql).toMatch(/GENERATED ALWAYS AS \(/);
    // 索引也得在: 选刊热路径按 (journal_kind, discipline_code, status) 过滤
    expect(m!.sql).toMatch(/idx_journals_kind_pick/);
  });

  it("三值逻辑护栏: 每个信号表达式都 coalesce 成真布尔(NULL 会让整行掉进 unknown)", () => {
    const s = buildJournalKindSql();
    // NOT 前面必须是 coalesce(...) 而不是裸表达式 —— `NOT NULL` 求值仍是 NULL, CASE 不匹配
    expect(s).toMatch(/AND NOT coalesce\(/);
    expect(s.match(/coalesce\(\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("生成列表达式只引用同一行的列(不含子查询/函数调用外的表引用)", () => {
    const s = buildJournalKindSql();
    expect(s).not.toMatch(/SELECT/i);
    expect(s).not.toMatch(/journals\./); // DDL 里不能带表名限定
  });
});
