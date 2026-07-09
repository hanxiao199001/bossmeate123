/**
 * PR #107 期刊治理 PR 3：confidence + data_source + field_provenance 计算。
 *
 * Spec 第 3 段公式：
 *   base = 50
 *   + crossref 命中  +20
 *   + doaj 命中     +10
 *   + letpub 命中   +20
 *   → 3 源全命中 = 100, cap 95 (PR #166: scimago +15 已砍 — Cloudflare 拉黑 0% 命中, cap 不动保兼容)
 *
 * ai-fallback only → 30 fixed（不进 multi-source，由 article-skill.persistAIJournal 直接写）
 *
 * data_source 逻辑：
 *   - 任一非 letpub 命中 + letpub 命中 → 'multi_source_verified'
 *   - 仅 letpub 命中 → 'letpub_only'（保守，因 letpub 已是历史强信号）
 *   - 全 4 源都没命中 → 不写（保留原 data_source）
 */

export interface TrustSourceFlags {
  crossref: boolean;
  doaj: boolean;
  scimago: boolean; // PR #166: 保签名兼容老 caller, 但 computeTrust 内部忽略 (永远当 false 处理)
  letpub: boolean;
  // task#104 阶段1: 国内核心目录信号(已 ingest 的 cscd_level/pku_core_level 派生, 老韩已认数据政策)。
  //   北大核心 +20 / CSCD核心库 +20 / CSCD扩展库 +10。仅身份信号, 不带 IF/分区/预警数值。
  pkuCore?: boolean;      // 北大核心
  cscdCore?: boolean;     // CSCD 核心库
  cscdExtended?: boolean; // CSCD 扩展库(与核心库互斥, 弱一档)
}

export type TrustDataSource = "multi_source_verified" | "letpub_only" | "cn_core_verified";

export interface TrustComputeResult {
  confidence: number;
  dataSource: TrustDataSource | null;
  fieldProvenance: Record<string, string>;
}

/**
 * 计算 trust score + data_source + field_provenance。
 * 0 命中时 dataSource = null（caller 不该改原 data_source）。
 */
export function computeTrust(
  flags: TrustSourceFlags,
  fieldHints: Partial<Record<string, string>> = {},
): TrustComputeResult {
  let confidence = 50;
  if (flags.crossref) confidence += 20;
  if (flags.doaj) confidence += 10;
  // PR #166: scimago +15 已砍 (Cloudflare 拉黑 0% 命中) — flag 仍接收兼容老 caller
  if (flags.letpub) confidence += 20;
  // task#104 阶段1: 国内核心目录 +分。北大核心 +20 / CSCD核心库 +20 / CSCD扩展库 +10。
  //   核心库与扩展库互斥, 取核心库(不叠加)。单一 +20 目录 → 50+20=70 恰越 verified 门槛。
  if (flags.pkuCore) confidence += 20;
  if (flags.cscdCore) confidence += 20;
  else if (flags.cscdExtended) confidence += 10;

  const intlHits = Number(flags.crossref) + Number(flags.doaj) + Number(flags.letpub);
  const coreHit = !!(flags.pkuCore || flags.cscdCore || flags.cscdExtended);
  // 0 命中（国际源 + 核心目录都无）→ 保留原状态，不强写
  if (intlHits === 0 && !coreHit) {
    return { confidence: 50, dataSource: null, fieldProvenance: {} };
  }

  // data_source 语义区分:
  //   有国际源(≥2 或 单一非letpub) 或 (核心目录 + 任一国际源) → multi_source_verified(国际多源交叉)
  //   仅 letpub → letpub_only
  //   仅国内核心目录、无国际源 → cn_core_verified(国内核心目录核验, 语义不同于国际多源)
  let dataSource: TrustDataSource;
  if (intlHits >= 1) {
    dataSource = coreHit || intlHits >= 2 || (intlHits === 1 && !flags.letpub) ? "multi_source_verified" : "letpub_only";
  } else {
    dataSource = "cn_core_verified";
  }

  const fieldProvenance: Record<string, string> = {};
  // 默认字段 → 来源映射（caller 通过 fieldHints 覆盖）
  if (flags.crossref) {
    fieldProvenance.publisher = "crossref";
    fieldProvenance.issn = "crossref";
  }
  if (flags.doaj) {
    fieldProvenance.apc = "doaj";
    fieldProvenance.openAccess = "doaj";
  }
  // PR #166: scimago provenance 已砍 — sjr/qPartition 不再 default-map
  // (老 jsonb 残留 'scimago' 会被下次 enrichJournal 覆盖)
  if (flags.letpub) {
    fieldProvenance.if_history = "letpub";
    fieldProvenance.cas_partition = "letpub";
    fieldProvenance.jcr_full = "letpub";
  }
  // task#104: 核心身份字段 provenance=cscd/pku（只标"身份"，不碰 IF/分区/预警数值来源）。
  //   核心刊若无 letpub → if_history/cas_partition 不写 provenance → IF 保持 null（客服可播报"北大核心"但不编 IF 数字）。
  if (flags.pkuCore) fieldProvenance.pku_core_level = "pku";
  if (flags.cscdCore || flags.cscdExtended) fieldProvenance.cscd_level = "cscd";
  // caller 显式覆盖（如 publisher 由 letpub 提供时优先 letpub）
  for (const [field, source] of Object.entries(fieldHints)) {
    if (typeof source === "string") fieldProvenance[field] = source;
  }

  return { confidence: Math.min(confidence, 95), dataSource, fieldProvenance };
}
