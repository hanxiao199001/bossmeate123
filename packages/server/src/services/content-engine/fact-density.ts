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
 * ## ⚠️ 本轮是影子模式：只统计、只落 metadata，不做任何拦截
 *
 * 阈值必须用实测分布定，不能拍脑袋 —— 8-06 排版规则分就是先写码后验证，
 * 结果判别力为 0、过 80 线内容腰斩，白做一轮。这次先量两天再定线。
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
