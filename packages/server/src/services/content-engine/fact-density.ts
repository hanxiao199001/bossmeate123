/**
 * 事实密度 —— 「这篇正文到底用上了几条 DB 事实」（8-07，P1-A 影子模式）。
 *
 * ## 为什么要这个指标
 *
 * 老板 Golden Set 标注里「数据太少/空洞」是 poor 组最大硬伤（24 次抱怨）。
 * 但六维的 `dataAccuracy` 是 **LLM 自评**——8-02 归因实测：人抱怨数据太少时，
 * 系统该维平均给 4.9~6.6 分，方向对但分不开好坏（和排版那一维同样的病）。
 *
 * 这个指标不问 LLM，**从生成过程算**：
 *   · `factsAvailable` = 这本刊在 DB 里到底有几条可写的事实（供给侧）
 *   · `factsCited`     = 正文里实际出现了几条（使用侧）
 * 两个数都是确定性的，可解释、可回溯，且天然把「无米之炊」和「有米不做」分开：
 *   available 低 → 是数据供给问题（该换体裁，见 journal-data-supply）
 *   available 高但 cited 低 → 是写作问题（有素材没用上）
 *
 * ## 判据全部复用，一条新的都不造
 *
 * 「正文里出现了某类事实断言」的探测正则与「DB 有没有这个字段」的判空口径，
 * 都直接取自 `compliance/fabrication-criteria.ts`：
 *   · TITLE_IF_CLAIM / TITLE_PARTITION_CLAIM / TITLE_DATA_CLAIM —— 探测正文断言
 *   · IF_FACT_KEYS / PARTITION_FACT_KEYS + hasAnyFact —— DB 有无
 *
 * 这是 `findBodyFabrication` 的**正面**：它问「正文写了但 DB 没有」（编造），
 * 本模块问「DB 有且正文写了」（引用）。同一批正则的一体两面，所以必须同源 ——
 * 两套正则会立刻产生「编造检测说有、密度统计说无」的自相矛盾。
 *
 * ## 🔴 这是【测量与验收工具】，不是闸 —— 不要给它加拦截线
 *
 * 8-07 实测 250 篇（存量），按数据供给分级：
 *
 *   | 分级   |   n | available 均值 | cited 均值 | 引用率 |
 *   |--------|-----|---------------|-----------|--------|
 *   | rich   |  60 | 4.88          | 3.37      | 69%    |
 *   | medium |  25 | 3.76          | 2.52      | 67%    |
 *   | sparse | 165 | **2.27**      | 1.87      | **82%**|
 *
 * **sparse 的引用率(82%)反而高于 rich(69%)** —— 它们不是"不会写"，是"没得写"：
 * 手上 2.27 条事实用掉了 1.87 条，无可指摘。
 * 而 sparse 的 available 中位数是 **2**，任何"低于 N 条就拦"的线都等于**拦掉整个 sparse 层**
 * （占样本 66%），而那一层恰恰是最努力在用手上素材的。
 *
 * → 所以本指标的用途是：
 *   ① 分离「无米之炊」(available 低) 与「有米不做」(available 高但 cited 低)
 *   ② 给 A2/A3 (sparse 体裁) 做 **before/after 验收**
 * **不做拦截。** 后人若想加闸，先回来看这张表。
 *
 * ## ⚠️ 匹配器已冻结（8-07，接线上那一刻起）
 *
 * `discipline` / `publisher` 的 cited 判定是**字面包含匹配**（正文里有没有出现该字符串），
 * 比 IF/分区那三类的复用正则弱：「教育学」可能以「教育领域」出现而漏计。
 * **这是已知偏差，先不修** —— before/after 必须用同一把尺子量，A2 上线前改匹配器基线就脏了。
 * 两边同样低估，趋势仍然可信。想修同义词匹配，等 A2 验收完、拿到一个完整对比周期之后。
 *
 * （实测那 250 篇里，`discipline` 有数据却判为未引用的有 93 篇 —— 其中一部分是这个假阴性。）
 */
import {
  TITLE_IF_CLAIM,
  TITLE_PARTITION_CLAIM,
  TITLE_DATA_CLAIM,
  IF_FACT_KEYS,
  PARTITION_FACT_KEYS,
  hasAnyFact,
  hasDbFact,
} from "../compliance/fabrication-criteria.js";

/** 一条"事实"的类别。刻意粗粒度：细分到字段会让 cited 端无法可靠归属 */
export type FactKind = "impactFactor" | "partition" | "submissionFlow" | "catalog" | "discipline" | "publisher";

export interface FactDensity {
  /** DB 里可供书写的事实类别数 */
  factsAvailable: number;
  /** 正文里实际用上的类别数（只统计 available 的那些，绝不把编造算成引用） */
  factsCited: number;
  /** cited / available；available 为 0 时是 null（无米之炊，比值没意义） */
  citeRatio: number | null;
  /** 逐类明细，排查时能一眼看出"哪条有数据却没写" */
  detail: Record<FactKind, { available: boolean; cited: boolean }>;
}

/** DB 侧字段（与 journals 表列名对齐） */
export interface FactSource {
  impactFactor?: unknown;
  compositeImpactFactor?: unknown;
  partition?: unknown;
  casPartition?: unknown;
  casPartitionNew?: unknown;
  jcrFull?: unknown;
  reviewCycle?: unknown;
  acceptanceRate?: unknown;
  catalogs?: unknown;
  cscdLevel?: unknown;
  pkuCoreLevel?: unknown;
  discipline?: unknown;
  disciplineCode?: unknown;
  publisher?: unknown;
}

/** 剥标签取纯文本。与 findBodyFabrication 同款处理（先剥 SVG，避免图表里的数字被算成正文引用） */
function toPlain(body: string): string {
  return body.replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ");
}

/** 正则带 g 标志，跨次调用有 lastIndex 残留 —— 每次新建，别共用实例 */
function matches(plain: string, re: RegExp): boolean {
  return new RegExp(re.source, re.flags).test(plain);
}

/**
 * 纯函数：算这篇正文的事实密度。无 IO，直接单测。
 *
 * ⚠️ `cited` 的判定刻意**只在 available 为真时才算数** —— 正文里出现 IF 数字但 DB 没有，
 *   那是编造（`findBodyFabrication` 管），绝不能计入"引用了事实"，否则编得越多密度越高。
 */
export function computeFactDensity(body: string | null | undefined, src: FactSource | null | undefined): FactDensity {
  const plain = body ? toPlain(body) : "";
  const s = src ?? {};

  const available: Record<FactKind, boolean> = {
    impactFactor: hasAnyFact(s, IF_FACT_KEYS),
    partition: hasAnyFact(s, PARTITION_FACT_KEYS),
    submissionFlow: hasDbFact(s.reviewCycle) || hasDbFact(s.acceptanceRate),
    catalog:
      (Array.isArray(s.catalogs) && s.catalogs.length > 0) || hasDbFact(s.cscdLevel) || hasDbFact(s.pkuCoreLevel),
    discipline: hasDbFact(s.discipline) || hasDbFact(s.disciplineCode),
    publisher: hasDbFact(s.publisher),
  };

  const citedRaw: Record<FactKind, boolean> = {
    impactFactor: matches(plain, TITLE_IF_CLAIM),
    partition: matches(plain, TITLE_PARTITION_CLAIM),
    // 审稿周期/录用率共用 TITLE_DATA_CLAIM（它覆盖 审稿/外审/见刊/接收/录用率/命中率 + 数字）
    submissionFlow: matches(plain, TITLE_DATA_CLAIM),
    // 目录/学科/出版社没有专属正则 —— 用字面出现判定（这三类是名词，不涉及数字编造风险）
    catalog: /北大核心|CSSCI|CSCD|中文核心|核心期刊|来源期刊/.test(plain),
    discipline: typeof s.discipline === "string" && s.discipline.length > 0 ? plain.includes(s.discipline) : false,
    publisher: typeof s.publisher === "string" && s.publisher.length > 0 ? plain.includes(s.publisher) : false,
  };

  const detail = {} as FactDensity["detail"];
  let av = 0;
  let ci = 0;
  for (const k of Object.keys(available) as FactKind[]) {
    const a = available[k];
    const c = a && citedRaw[k]; // ← 只有"DB 有"才算引用，编造不计入
    detail[k] = { available: a, cited: c };
    if (a) av++;
    if (c) ci++;
  }

  return {
    factsAvailable: av,
    factsCited: ci,
    citeRatio: av > 0 ? Number((ci / av).toFixed(2)) : null,
    detail,
  };
}

/** 落 metadata 的精简形态（影子模式下只写这些，不参与任何判定） */
export function factDensityMetadata(d: FactDensity): Record<string, unknown> {
  return {
    factsAvailable: d.factsAvailable,
    factsCited: d.factsCited,
    factsCiteRatio: d.citeRatio,
    factsDetail: d.detail,
  };
}
