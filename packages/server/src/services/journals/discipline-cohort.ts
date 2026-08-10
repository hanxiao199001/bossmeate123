/**
 * 学科同侪集合（A2 第 4 步，8-10）—— 「学科定位」体裁**唯一**查库的地方。
 *
 * ## 它回答什么
 *
 * sparse 刊（占内容 57.6%）单刊只有三样家当：刊名、目录、学科。写投稿指南必然编造。
 * 换个问法就有话说了 —— 不问「这本刊怎么样」，问「这本刊在目录里处在什么位置」：
 *
 *   《中国教育学刊》是 CSSCI（2023-2024 版）教育学分类下的 43 本之一；
 *   该版 CSSCI 共 660 本，教育学占 6.5%；同分类还有《教育研究》…
 *
 * 每个数字都能拿官方目录逐条数出来。素材来自集合而非单刊，所以**刊越薄越管用**。
 *
 * ## 三条不可退让的纪律
 *
 * 1. **分类名只用目录自带的**，绝不用 `journals.discipline_code`。
 *    实测《武汉体育学院学报》的 discipline_code 是 education，目录自带是体育学 ——
 *    照 code 写就会出现「同为教育学 CSSCI 的还有《武汉体育学院学报》」，读者一眼看穿。
 *
 * 2. **派生量全部由代码算好**（占比、总数）。LLM 一旦被允许自己算 43/660，
 *    下一次它就会"算"一个没有依据的数。它只负责把给定数字串成句子。
 *
 * 3. **无米不做饭**（红线 #14 的正解）。四种情形一律不产稿、记原因，
 *    而不是降级产一篇看起来正常的稿子 —— 见 `cohortEligible`。
 *
 * ## 为什么准入判据是纯函数、而取数是异步
 *
 * `getDisciplineCohort` 只做"取行 + 拼集合"，null 仅代表**期刊行不存在**。
 * 能不能写由 `cohortEligible(cohort)` 判定，它不碰 DB —— 于是四条准入规则可以脱库单测，
 * 也能在样例脚本里对着 200 本刊批量跑准入率（拍板需要的三个数之一）。
 */
import { classifyDataSupply, type DataSupplyLevel, type JournalSupplyInput } from "./journal-data-supply.js";
import { normName } from "./journal-name-normalize.js";
import {
  CATALOG_LABEL,
  DISCIPLINED_CATALOGS,
  catalogDisciplineCounts,
  countInCatalog,
  countInDiscipline,
  lookupByIssn,
  lookupByName,
  siblingsInDiscipline,
  snapshotHealthy,
  type CatalogEntry,
  type CatalogTag,
  type DisciplinedCatalog,
} from "./catalog-snapshot.js";

/**
 * 一个分类要撑起「格局」叙事的最低本数。
 * 低于此数写「共 2 本」既没有信息量、也容易被读成"这个分类很冷门"这种未经验证的评价。
 */
export const MIN_DISCIPLINE_COUNT = 3;
/** 同类刊清单最多列几本（只列刊名，零评价） */
export const MAX_SIBLINGS = 8;
/** 横向盘子最多对比几个分类 */
export const MAX_CROSS_DISCIPLINE = 6;

export interface CohortCatalogSlice {
  catalog: DisciplinedCatalog;
  /** 中文标签，如 "CSSCI" */
  label: string;
  /** 该目录的版本年。⚠️ 逐目录不同（pku-core 是 2023，其余 2023-2024），不许统一 */
  catalogYear: string;
  /** **目录自己的**分类名，如 "教育学" */
  disciplineOfThisJournal: string;
  /** 主叙事用这个：该目录该分类下共几本 */
  countInDiscipline: number;
  countInCatalogTotal: number;
  /** 代码预算好的派生量，LLM 不许自己算 */
  shareOfCatalogPct: number;
  /** 同目录同分类的其他刊名，稳定排序 */
  siblings: string[];
  /** 横向盘子：该目录里各分类刊数（含本刊所属分类） */
  crossDiscipline: Array<{ discipline: string; count: number }>;
}

export interface DisciplineCohort {
  journalId: string;
  name: string;
  nameEn: string | null;
  supplyLevel: DataSupplyLevel;
  /** DB 侧认为它有目录成员资格（catalogs 数组 / cscd_level / pku_core_level） */
  hasCatalogInDb: boolean;
  /** 命中快照的方式。null = 没匹配上，准入判据 2 据此拦截 */
  matchedBy: "name" | "issn" | null;
  /** 带学科分类的目录切片，按分类本数降序 */
  slices: CohortCatalogSlice[];
  /** CSCD 只能当徽章（它没有学科分类），单独放，不参与任何统计 */
  cscdBadge: { level: string | null; catalogYear: string } | null;
  /** 快照版本年集合，落 metadata 用 */
  snapshotYears: string[];
  computedAt: string;
}

/** 准入不通过的原因码。落 metadata + 样例脚本按码计数 */
export type CohortSkipReason =
  | "snapshot_unhealthy"
  | "no_catalog_in_db"
  | "snapshot_mismatch"
  | "cscd_only"
  | "discipline_too_small";

/**
 * 能不能用这本刊写「学科定位」。纯函数，不碰 DB。
 *
 * 🔴 四条全部是**拒绝生成**，不是降级生成。素材不够就不写这篇 ——
 *   降级出一篇「本刊是国内知名学术期刊」式的空稿，与真稿在下游无法区分（红线 #14）。
 */
export function cohortEligible(c: DisciplineCohort): { ok: boolean; reason?: CohortSkipReason } {
  // 0. 快照本身不完整（文件没进 dist / 格式坏了）→ 此刻所有"未收录"结论都不可信
  if (!snapshotHealthy().ok) return { ok: false, reason: "snapshot_unhealthy" };
  // 1. DB 侧连目录成员资格都没有
  if (!c.hasCatalogInDb) return { ok: false, reason: "no_catalog_in_db" };
  // 2. 刊名/ISSN 都没匹配上快照 —— 数字无从谈起
  if (!c.matchedBy) return { ok: false, reason: "snapshot_mismatch" };
  // 3. 只命中 CSCD：它没有学科分类，撑不起「坐标」这个主叙事
  if (c.slices.length === 0) return { ok: false, reason: "cscd_only" };
  // 4. 所有分类都太小，凑不出格局
  if (!c.slices.some((s) => s.countInDiscipline >= MIN_DISCIPLINE_COUNT)) {
    return { ok: false, reason: "discipline_too_small" };
  }
  return { ok: true };
}

/** 只保留够大的切片 —— 模板层与事实清单都只看这个，小分类整章不出现 */
export function usableSlices(c: DisciplineCohort): CohortCatalogSlice[] {
  return c.slices.filter((s) => s.countInDiscipline >= MIN_DISCIPLINE_COUNT);
}

function buildSlice(e: CatalogEntry, selfNorm: string): CohortCatalogSlice | null {
  if (e.catalog === "cscd" || !e.discipline) return null;
  const catalog = e.catalog as DisciplinedCatalog;
  const inDiscipline = countInDiscipline(catalog, e.discipline);
  const total = countInCatalog(catalog);
  return {
    catalog,
    label: CATALOG_LABEL[catalog],
    catalogYear: e.catalogYear,
    disciplineOfThisJournal: e.discipline,
    countInDiscipline: inDiscipline,
    countInCatalogTotal: total,
    // 一位小数。代码算，LLM 不算
    shareOfCatalogPct: total > 0 ? Number(((inDiscipline / total) * 100).toFixed(1)) : 0,
    siblings: siblingsInDiscipline(catalog, e.discipline, selfNorm, MAX_SIBLINGS),
    crossDiscipline: catalogDisciplineCounts(catalog).slice(0, MAX_CROSS_DISCIPLINE),
  };
}

/** 构造 cohort 需要的 DB 列（其余列一律不看） */
export type CohortJournalRow = JournalSupplyInput & {
  id: string;
  name: string;
  nameEn?: string | null;
  issn?: string | null;
};

/**
 * 取一本刊的学科同侪集合。
 * 返回 null **只**代表期刊行不存在；准入与否问 `cohortEligible`。
 *
 * ⚠️ `db` / `schema` 走**函数内动态 import**。`models/db.ts` 在模块加载时就 new Pool()
 *   并校验 env —— 顶层 import 会让本模块的纯函数（buildCohortFromRow / cohortEligible /
 *   cohortPromptFacts）在单测里连不上库就跑不起来，而它们恰恰是判据所在，必须脱库可测。
 */
export async function getDisciplineCohort(opts: { journalId: string }): Promise<DisciplineCohort | null> {
  const [{ db }, { journals }, { eq }] = await Promise.all([
    import("../../models/db.js"),
    import("../../models/schema.js"),
    import("drizzle-orm"),
  ]);
  const [row] = await db.select().from(journals).where(eq(journals.id, opts.journalId)).limit(1);
  if (!row) return null;
  return buildCohortFromRow(row);
}

/** DB 行 → cohort。抽出来是为了样例脚本能一次 select 多行后批量构造，不用 N 次查询 */
export function buildCohortFromRow(row: CohortJournalRow): DisciplineCohort {
  const supply = classifyDataSupply(row);
  const selfNorm = normName(row.name);

  // 刊名优先；匹配不上再退 ISSN（只有 CSCD 带 ISSN，兜那 14 条无刊名记录）
  let hits = lookupByName(row.name);
  let matchedBy: DisciplineCohort["matchedBy"] = hits.length > 0 ? "name" : null;
  if (hits.length === 0) {
    hits = lookupByIssn(row.issn ?? null);
    if (hits.length > 0) matchedBy = "issn";
  }

  const slices: CohortCatalogSlice[] = [];
  for (const tag of DISCIPLINED_CATALOGS) {
    const e = hits.find((h) => h.catalog === (tag as CatalogTag));
    if (!e) continue;
    const s = buildSlice(e, selfNorm);
    if (s) slices.push(s);
  }
  // 分类越大的目录越适合当主叙事，排前面
  slices.sort((a, b) => b.countInDiscipline - a.countInDiscipline || a.catalog.localeCompare(b.catalog));

  const cscd = hits.find((h) => h.catalog === "cscd");

  return {
    journalId: row.id,
    name: row.name,
    nameEn: row.nameEn ?? null,
    supplyLevel: supply.level,
    hasCatalogInDb: supply.has.catalog,
    matchedBy,
    slices,
    cscdBadge: cscd ? { level: cscd.cscdLevel ?? null, catalogYear: cscd.catalogYear } : null,
    snapshotYears: [...new Set(hits.map((h) => h.catalogYear))].sort(),
    computedAt: new Date().toISOString(),
  };
}

/**
 * 渲染成事实清单 —— prompt 的 `##本篇唯一可用事实##` 块。
 *
 * 🔴 这是**数字的唯一出口**。校验器 `cohort-fact-check` 直接从本函数的输出抽白名单，
 *   两边同源；正文里出现任何不在这些行里的数字即判编造。
 *   所以：想让 LLM 能写某个数，就把它加进这里；**别在 prompt 别处再塞数字**。
 */
export function cohortPromptFacts(c: DisciplineCohort): string[] {
  const out: string[] = [`刊名：${c.name}`];
  if (c.nameEn) out.push(`英文刊名：${c.nameEn}`);

  for (const s of usableSlices(c)) {
    out.push(
      `本刊被 ${s.label}（${s.catalogYear} 版目录）收录，在该目录中的分类是「${s.disciplineOfThisJournal}」。`,
    );
    out.push(
      `${s.label}（${s.catalogYear} 版）「${s.disciplineOfThisJournal}」分类下共收录 ${s.countInDiscipline} 本期刊；` +
        `该版目录全部共 ${s.countInCatalogTotal} 本，该分类占 ${s.shareOfCatalogPct}%。`,
    );
    if (s.siblings.length >= 3) {
      out.push(
        `同属 ${s.label}「${s.disciplineOfThisJournal}」分类的其他期刊（部分）：` +
          s.siblings.map((n) => `《${n}》`).join("、"),
      );
    }
    if (s.crossDiscipline.length >= 3) {
      out.push(
        `${s.label}（${s.catalogYear} 版）各分类收录本数（前 ${s.crossDiscipline.length}）：` +
          s.crossDiscipline.map((d) => `${d.discipline} ${d.count} 本`).join("、"),
      );
    }
  }

  if (c.cscdBadge) {
    out.push(
      `本刊同时被 CSCD（${c.cscdBadge.catalogYear} 版）收录` +
        (c.cscdBadge.level ? `，层级为${c.cscdBadge.level}` : "") +
        "。（CSCD 目录不划分学科分类，不得就此推断任何学科排名）",
    );
  }
  return out;
}

/** 落 metadata 的精简形态（排查时看得出"这篇当时用的是哪一版目录、哪些数"） */
export function cohortMetadata(c: DisciplineCohort): Record<string, unknown> {
  return {
    cohortMatchedBy: c.matchedBy,
    cohortSnapshotYears: c.snapshotYears,
    cohortComputedAt: c.computedAt,
    cohortSlices: usableSlices(c).map((s) => ({
      catalog: s.catalog,
      catalogYear: s.catalogYear,
      discipline: s.disciplineOfThisJournal,
      countInDiscipline: s.countInDiscipline,
      countInCatalogTotal: s.countInCatalogTotal,
      shareOfCatalogPct: s.shareOfCatalogPct,
      siblingCount: s.siblings.length,
    })),
    cohortCscdBadge: c.cscdBadge,
  };
}
