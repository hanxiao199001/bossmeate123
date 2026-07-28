/**
 * 「国际指标信号」列清单 —— 单一真相源(7-29)。
 *
 * ## 为什么单独一个文件
 *
 * 同一个问题("这本刊有没有国际指标证据")在项目里被问过三次, 三处各挑各的列, 于是踩了两次同一个坑:
 *
 *   · 7-20 `compliance/content-check.ts` 判编造时发现: **`cas_partition` 整列为空(0 行)**,
 *     真正有数据的是 `cas_partition_new`(2203) 与 `jcr_full`(4229)。当时写下了警告注释。
 *   · 7-28 `journals/journal-kind.ts` 新写 `hasIntlSignal` 时, **又原样挑了 impact_factor /
 *     partition / cas_partition 这三列** —— 其中 partition 仅 40 行、cas_partition 0 行。
 *     等于三个信号只有一个在真工作。后果实测: 704 本一线国际刊(Elsevier 154 / Wiley 90 /
 *     Springer 46 …, ISSN 覆盖 704/704, 零 ai_fabricated)被判 `journal_kind='unknown'`,
 *     对 international scope 不可见, 选刊器永远选不到, 日志一句不报。
 *
 * 病根不是谁粗心, 是"哪些列承载国际指标证据"这个**事实**没有唯一出处, 每个调用点都得自己回忆一遍。
 * 所以把列清单钉在这里, 谁要用谁 import; 各判据可以取**不同子集**(见下), 但子集必须从这份清单里挑,
 * 并写明为什么少取。
 *
 * ## 三个判据是三个不同的问题, 不要压成一个
 *
 *   ① **身份**: 这是不是国际体系的刊? → `hasIntlSignal`(本文件, 取全集)
 *      给 journal_kind 生成列用。宁可宽: 漏判 = 整本刊对 scope 隐身。
 *   ② **有据**: 标题/正文写的分区有没有 DB 依据? → `compliance/fabrication-criteria.ts`
 *      的 `PARTITION_FACT_KEYS`(取分区那 4 列, 不含 impactFactor —— IF 另有 IF_FACT_KEYS)。
 *   ③ **够渲染**: WoS 版块渲不渲得出来? → `publisher/adapters/shunshi-style-template.ts`
 *      的 `hasWosData`(**刻意只取 jcrFull.jifSubjects / impactFactor>0 / partition=Q1-4**)。
 *      它比 ① 窄是对的: 那几块版面渲的是 JCR 分区/IF 趋势/CAR, 只有一个"3区医学"撑不起来,
 *      放宽只会退回 6-17 修掉的"满屏占位空洞"。**窄是刻意的, 不是漏。**
 *
 * ## 改这里要连带做什么
 *
 * `journal_kind` 是 Postgres 生成列, DDL 里固化的是 `buildIntlSignalSql()` 的输出。
 * 改本文件的信号定义 → TS 立刻生效, 但**数据库那一列纹丝不动**。必须新加 migration 走
 * DROP COLUMN + 重建, 并更新 `__tests__/journal-kind-generated-column-drift.test.ts` 的冻结快照。
 * 那个测试会拦住忘记这步的人。
 */

/** 承载国际指标证据的字段(TS 侧命名, 与 drizzle schema 一致) */
export const INTL_SIGNAL_FIELDS = [
  "impactFactor",
  "partition",
  "casPartition",
  "casPartitionNew",
  "jcrFull",
] as const;

export type IntlSignalField = (typeof INTL_SIGNAL_FIELDS)[number];

/**
 * 对应的 DB 列名 + 生产实测覆盖(2026-07-29, status='active' 全库 8650 行)。
 * 覆盖数写在这里是为了让下一个人一眼看出"哪列是空的、不能只靠它"。
 */
export const INTL_SIGNAL_COLUMNS: Record<IntlSignalField, { column: string; coverage2607: number }> = {
  impactFactor: { column: "impact_factor", coverage2607: 4349 },
  partition: { column: "partition", coverage2607: 40 },       // ← 几乎空
  casPartition: { column: "cas_partition", coverage2607: 0 }, // ← 整列为空, 单独用等于没判
  casPartitionNew: { column: "cas_partition_new", coverage2607: 2203 },
  jcrFull: { column: "jcr_full", coverage2607: 4229 },
};

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/**
 * jcr_full 是否携带**真正的 WoS 收录/分区证据**。
 *
 * 不能简单判"非空": 实测 4229 行非空里有 123 行只有 `isTopJournal` / `isReviewJournal`
 * 这类布尔标记(例: Journal of the American Medical Association 那行), 没有 wosLevel 也没有
 * jifSubjects —— 拿它当分区证据, 等于让"是不是顶刊"这个标签冒充分区。
 */
export function jcrFullHasWosEvidence(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as { wosLevel?: unknown; jifSubjects?: unknown; jciSubjects?: unknown };
  if (nonEmpty(o.wosLevel)) return true;
  if (Array.isArray(o.jifSubjects) && o.jifSubjects.length > 0) return true;
  if (Array.isArray(o.jciSubjects) && o.jciSubjects.length > 0) return true;
  return false;
}

export interface IntlSignalFields {
  impactFactor?: number | null;
  partition?: string | null;
  casPartition?: string | null;
  casPartitionNew?: string | null;
  jcrFull?: unknown;
}

/**
 * 有国际指标信号?(= journal_kind 判 intl/both 的那一支)
 *
 * 口径: IF **IS NOT NULL** 即算(不加 `>0` —— 加了会把 IF=0 的占位行踢出国外池, 属于减法),
 * 四类分区证据任一非空即算。宁可宽: 这里漏判的代价是整本刊对 international scope 隐身。
 */
export function hasIntlSignal(j: IntlSignalFields): boolean {
  return (
    j.impactFactor != null ||
    nonEmpty(j.partition) ||
    nonEmpty(j.casPartition) ||
    nonEmpty(j.casPartitionNew) ||
    jcrFullHasWosEvidence(j.jcrFull)
  );
}

/**
 * `hasIntlSignal` 的 SQL 孪生体 —— 生成列 DDL 由它产出, 两边必须逐条对应。
 *
 * @param p 表别名前缀(join 查询里消歧用); **生成列 DDL 必须传空**(生成列表达式不能带表限定)。
 */
export function buildIntlSignalSql(p = ""): string {
  // "partition" 必须加引号: 它在 Postgres 里是窗口函数关键字, 裸写在生成列表达式里有解析歧义风险。
  // jsonb_array_length 只能作用在 array 上, 先用 jsonb_typeof 守一道, 否则脏数据会让整列建不出来。
  const jcr =
    `(btrim(coalesce(${p}jcr_full->>'wosLevel', '')) <> ''` +
    ` OR (jsonb_typeof(${p}jcr_full->'jifSubjects') = 'array' AND jsonb_array_length(${p}jcr_full->'jifSubjects') > 0)` +
    ` OR (jsonb_typeof(${p}jcr_full->'jciSubjects') = 'array' AND jsonb_array_length(${p}jcr_full->'jciSubjects') > 0))`;
  return `coalesce((${p}impact_factor IS NOT NULL` +
    ` OR btrim(coalesce(${p}"partition", '')) <> ''` +
    ` OR btrim(coalesce(${p}cas_partition, '')) <> ''` +
    ` OR btrim(coalesce(${p}cas_partition_new, '')) <> ''` +
    ` OR ${jcr}), false)`;
}
