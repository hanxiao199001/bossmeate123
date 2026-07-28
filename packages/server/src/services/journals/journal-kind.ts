/**
 * journal_kind —— "这本刊归哪套评价体系" 的**单一真相源** (7-28 国内刊解冻)。
 *
 * ## 为什么要这一列
 * 项目里长期同时活着 4 套"国内刊 / 国外刊"判定, 各写各的启发式:
 *   ① `recommendation/journal-scope.ts`      domestic = catalogs 非空; international = catalogs 空且有 IF/分区
 *   ② `journal-enricher/fetchers/wanfang-perioid-resolver.ts` isDomestic = catalogs 非空 || cscd || pku
 *   ③ `publisher/smart-assign.ts` classifyScope  同①+刊名中文兜底
 *   ④ `skills/article-skill.ts` buildDomesticJournalGuidance  catalogs 非空 && 无 IF
 * 四套口径两两不等价, 于是出现**"定义裂缝刊"**: enricher(orchestrator:280-289)只写
 * `cscd_level`/`pku_core_level` 而**不回写 catalogs** → 这本刊 catalogs 空、无 IF →
 * ① 判它"不是国内刊"(catalogs 空), 也判它"不是国外刊"(无 IF/分区) → **对任何 scope 都不可见**,
 * 选刊器永远选不到它, 日志还只打一句"对口刊枯竭"(看着完全正常)。
 *
 * ## 四分类
 *   - `intl`    有国际指标(IF / JCR 分区 / 中科院分区), 无任何国内目录信号 → 纯国外刊
 *   - `both`    国际指标与国内目录信号**同时**有 → **骑墙刊**(CLAUDE.md backlog-C 的主角:
 *               带 sci-core 标签又进中文目录, 既不能按纯国内刊禁写分区, 也不该按纯国外刊套 WoS 全套)
 *   - `cn`      只有国内信号(目录 / CSCD / 北大核心 / CN 刊号 / 复合IF) → 国内刊。**裂缝刊落这里**
 *   - `unknown` 什么信号都没有(只有刊名的 openalex 裸行) → 与改造前一样对任何 scope 不可见
 *
 * ## scope 映射(见 journal-sql.ts)
 *   domestic → kind IN ('cn','both')   国内槽位吃骑墙刊(它确实在中文目录里)
 *   international → kind = 'intl'      **骑墙刊不进国外槽位** —— 保留改造前的铁律:
 *                                      中华医学杂志/CSSCI/科技核心不许被当成国外刊
 *
 * ## ⚠️ 生成列纪律(与 discipline_code 同款)
 * `journals.journal_kind` 是 Postgres 生成列, 表达式由本文件 `buildJournalKindSql()` 生成、
 * 在 migration `029_journals_journal_kind` 建列时**固化进 DDL**。改了本文件的信号定义,
 * **数据库那一列纹丝不动** → TS 与 DB 两边规则不一致, 失败是静默的。
 * 改法: 新加一条 migration 走 DROP COLUMN + 重建 ADD COLUMN GENERATED, 并更新
 * `__tests__/journal-kind-generated-column-drift.test.ts` 的冻结快照。守卫测试会逼你做。
 *
 * 本文件**保持纯净**: migrations.ts 要 import 它, 不能被 drizzle/db 连带拉起来。
 * 7-29 起允许 import **同样零依赖**的 `./intl-signal.js`(国际指标信号的单一真相源) ——
 * 判据是"不许拉进任何带副作用/连 DB 的模块", 不是"一个 import 都不许有"。
 * 需要 drizzle SQL 条件的去 `journal-sql.ts`。
 */

import { hasIntlSignal, buildIntlSignalSql } from "./intl-signal.js";

export type JournalKind = "intl" | "both" | "cn" | "unknown";

/**
 * 国内核心目录标签。同时用于 `catalogs`(jsonb 数组元素) 与 `catalog_type`(单值列) —— 库里两处用同一套字面量。
 * 注意 `sci` / `sci-core` **不在**此列表: 它们是国际目录标签(骑墙刊靠它们与中文目录并存)。
 */
export const CN_CATALOG_TAGS = ["pku-core", "cssci", "cssci-ext", "cscd", "cstpcd"] as const;

/** 判定所需字段(全 optional: collector 行 / DB 行 / 部分投影都能传) */
export interface JournalKindFields {
  // 国际体系信号
  impactFactor?: number | null;
  partition?: string | null;
  casPartition?: string | null;
  // 国内体系信号
  catalogs?: unknown;
  catalogType?: string | null;
  cscdLevel?: string | null;
  pkuCoreLevel?: string | null;
  cnNumber?: string | null;
  compositeImpactFactor?: number | null;
  /** collector 路径的别名(article-skill 那条链叫 compositeIF) */
  compositeIF?: number | null;
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
const catalogList = (v: unknown): string[] =>
  Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : [];

/**
 * 有国际指标? —— 判据与列清单已收口到 `journals/intl-signal.ts`(单一真相源)。
 *
 * 7-29 修: 原实现挑的三列里 `cas_partition` **整列为空(0 行)**、`partition` 仅 40 行,
 *   真正有数据的 `cas_partition_new`(2203) 和 `jcr_full`(4229) 一个没读 —— 等于三个信号
 *   只有一个在工作, 704 本一线国际刊被判 unknown 对 scope 隐身。这不是"给 unknown 开后门",
 *   是修一个读错列的 bug。为什么会连踩两次、以及三个判据为何取不同子集, 见 intl-signal.ts 文件头。
 */
export { hasIntlSignal };

/**
 * 有国内信号? catalogs 非空 / CSCD / 北大核心 / 国内目录类型 / CN 刊号 / 复合影响因子。
 * **裂缝刊靠 cscd_level|pku_core_level 这两条被捞回来**(它们 catalogs 是空的)。
 */
export function hasCnSignal(j: JournalKindFields): boolean {
  if (catalogList(j.catalogs).length > 0) return true;
  if (nonEmpty(j.cscdLevel) || nonEmpty(j.pkuCoreLevel)) return true;
  if (nonEmpty(j.catalogType) && (CN_CATALOG_TAGS as readonly string[]).includes(String(j.catalogType))) return true;
  if (nonEmpty(j.cnNumber)) return true;
  if (j.compositeImpactFactor != null || j.compositeIF != null) return true;
  return false;
}

/** TS 侧分类 —— 必须与 `buildJournalKindSql()` 生成的 CASE 等价(有漂移守卫测试盯着)。 */
export function toJournalKind(j: JournalKindFields): JournalKind {
  const intl = hasIntlSignal(j);
  const cn = hasCnSignal(j);
  if (intl && !cn) return "intl";
  if (intl && cn) return "both";
  if (cn) return "cn";
  return "unknown";
}

/** 国内槽位可见的 kind(含骑墙刊) */
export const DOMESTIC_KINDS: readonly JournalKind[] = ["cn", "both"];
/** 国外槽位可见的 kind(**不含**骑墙刊, 见文件头铁律) */
export const INTERNATIONAL_KINDS: readonly JournalKind[] = ["intl"];

export const isDomesticKind = (k: JournalKind): boolean => DOMESTIC_KINDS.includes(k);
export const isInternationalKind = (k: JournalKind): boolean => INTERNATIONAL_KINDS.includes(k);

/**
 * 期刊 → 账号定位 scope(smart-assign 的 classifyScope 的等价实现, 见下方注释)。
 * 保留刊名中文兜底: 三无数据(无目录/无IF/无分区)但刊名是中文的, 按国内刊算 —— 否则它被判"未知"
 * 而绕过定位过滤(6-19 的修复, 不能丢)。
 */
export function classifyJournalScope(
  j: JournalKindFields & { name?: string | null },
): "domestic" | "international" | null {
  const kind = toJournalKind(j);
  if (isDomesticKind(kind)) return "domestic";
  if (isInternationalKind(kind)) return "international";
  if (/[一-鿿]/.test(String(j.name ?? ""))) return "domestic";
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// SQL 侧(与上面的 TS 谓词逐条对应; prefix 用于 join 查询里消歧, 生成列 DDL 必须传空)
// ──────────────────────────────────────────────────────────────────────────

const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");

/**
 * ⚠️ 每个信号表达式都用 `coalesce(…, false)` 收口成**真布尔**。
 * SQL 三值逻辑的坑: `catalog_type IN (…)` 在 catalog_type 为 NULL 时求值为 **NULL 而非 FALSE**,
 * `NULL OR FALSE = NULL`, 再进 `NOT (…)` 还是 NULL, `CASE WHEN NULL` 不匹配 →
 * 一本正常的国外刊会直接掉进 ELSE 'unknown'。这类"整列静默错分类"排查起来极贵, 一律 coalesce。
 */
const boolish = (expr: string) => `coalesce(${expr}, false)`;

/** 国际指标信号 SQL(= hasIntlSignal 的孪生体) —— 同样收口在 intl-signal.ts */
export { buildIntlSignalSql };

/** 国内信号 SQL(= hasCnSignal) */
export function buildCnSignalSql(p = ""): string {
  return boolish(
    `(` +
      `(jsonb_typeof(${p}catalogs) = 'array' AND jsonb_array_length(${p}catalogs) > 0)` +
      ` OR btrim(coalesce(${p}cscd_level, '')) <> ''` +
      ` OR btrim(coalesce(${p}pku_core_level, '')) <> ''` +
      ` OR btrim(coalesce(${p}catalog_type, '')) IN (${sqlList(CN_CATALOG_TAGS)})` +
      ` OR btrim(coalesce(${p}cn_number, '')) <> ''` +
      ` OR ${p}composite_impact_factor IS NOT NULL` +
      `)`,
  );
}

/**
 * 生成列表达式。`jsonb_typeof(catalogs) = 'array'` 是刻意的:
 * 直接 `jsonb_array_length()` 碰到非数组 jsonb 会**整表报错**, 而生成列一旦报错整条 migration 回滚。
 */
export function buildJournalKindSql(p = ""): string {
  const intl = buildIntlSignalSql(p);
  const cn = buildCnSignalSql(p);
  return (
    `CASE\n` +
    `    WHEN ${intl} AND NOT ${cn} THEN 'intl'\n` +
    `    WHEN ${intl} AND ${cn} THEN 'both'\n` +
    `    WHEN ${cn} THEN 'cn'\n` +
    `    ELSE 'unknown'\n` +
    `  END`
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 分体系可信度(③c 的核心 —— 这条解冻 88% 国内刊)
// ──────────────────────────────────────────────────────────────────────────
/**
 * 国内刊的"可信"**不是多源交叉验证, 是目录成员资格 + 刊号实体确认**。
 *
 * 病根: trust-score 的加分项全是国际源(crossref+20 / doaj+10 / letpub+20), 国内刊的可信度
 * 天花板是"进北大核心或 CSCD 核心库 = 恰好 70", 只在 CSCD 扩展库 = 60, 两个目录都不在 = 50。
 * 而选刊器/客服护栏拿 `confidence >= 70` 当硬门槛 → 88% 国内刊在 SQL 层就被挡住
 * (生产实测 verified 427/3707; 综合性人文社科 0/122, 中国政治 0/43 —— 整个学科一本都推不出来)。
 * 拿国际刊的尺子量国内刊, 量不出来不是刊的问题, 是尺子的问题。
 *
 * 排除 `ai_fabricated`: 那是 LLM 编的影子刊(conf=30), 它的"CN 刊号 + 主办方"也是编的,
 * 绝不能因为"字段填满了"就发权威背书。
 */
export function isCnVerified(
  j: JournalKindFields & { publisher?: string | null; dataSource?: string | null },
): boolean {
  if (j.dataSource === "ai_fabricated") return false;
  if (nonEmpty(j.pkuCoreLevel) || nonEmpty(j.cscdLevel)) return true;
  if (nonEmpty(j.catalogType) && (CN_CATALOG_TAGS as readonly string[]).includes(String(j.catalogType))) return true;
  const cats = catalogList(j.catalogs);
  if (cats.some((c) => (CN_CATALOG_TAGS as readonly string[]).includes(c))) return true;
  if (nonEmpty(j.cnNumber) && nonEmpty(j.publisher)) return true; // 刊号 + 主办方 = 实体确认
  return false;
}

/** = isCnVerified 的 SQL 版 */
export function buildCnVerifiedSql(p = ""): string {
  const catContains = CN_CATALOG_TAGS.map((t) => `${p}catalogs @> '["${t}"]'::jsonb`).join(" OR ");
  return boolish(
    `(${p}data_source IS DISTINCT FROM 'ai_fabricated' AND (` +
      `btrim(coalesce(${p}pku_core_level, '')) <> ''` +
      ` OR btrim(coalesce(${p}cscd_level, '')) <> ''` +
      ` OR btrim(coalesce(${p}catalog_type, '')) IN (${sqlList(CN_CATALOG_TAGS)})` +
      ` OR (jsonb_typeof(${p}catalogs) = 'array' AND (${catContains}))` +
      ` OR (btrim(coalesce(${p}cn_number, '')) <> '' AND btrim(coalesce(${p}publisher, '')) <> '')` +
      `))`,
  );
}

/** 国际体系门槛: 维持现状 conf>=70 且非 legacy_unknown(与 batch-worker 的 needs_review 口径一致) */
export function buildIntlVerifiedSql(p = ""): string {
  // confidence 可为 NULL(未评分) → coalesce 成 0, 判未核实(与 TS 侧 `j.confidence ?? 0` 一致)
  return boolish(`(coalesce(${p}confidence, 0) >= 70 AND ${p}data_source IS DISTINCT FROM 'legacy_unknown')`);
}

/**
 * **分体系可信门槛**总表达式(选刊器 / 未核实配额计数共用)。依赖生成列 `journal_kind`(migration 029)。
 *
 * ⚠️ 国内刊那一支是 `目录成员资格 **OR** 老门槛`, 不是"换一条"。这条"只加不减"是刻意的:
 *   下游有调用点(如 batch-worker 的 needs_review 判定)只投影了 confidence/dataSource 这几列,
 *   拿不到 catalogs/cscd_level —— 如果国内刊改成"只认目录", 那些点会把原本 conf>=70 的国内刊
 *   反而判成未核实, 把解冻做成**倒退**(内容平白多转人工复核)。并成 OR 后, 任何一本原先算已核实的
 *   刊都不会变成未核实, 改动在全系统范围内单调放宽。
 */
export function buildVerifiedJournalSql(p = ""): string {
  return boolish(
    `(${p}data_source IS DISTINCT FROM 'ai_fabricated' AND CASE WHEN ${p}journal_kind = 'cn'` +
      ` THEN (${buildCnVerifiedSql(p)} OR ${buildIntlVerifiedSql(p)})` +
      ` ELSE ${buildIntlVerifiedSql(p)} END)`,
  );
}
