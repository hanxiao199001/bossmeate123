/**
 * PR #107 期刊治理 PR 3：confidence + data_source + field_provenance 计算。
 *
 * Spec 第 3 段公式：
 *   base = 50
 *   + crossref 命中  +20
 *   + doaj 命中     +10
 *   + scimago 命中  +15
 *   + letpub 命中   +20
 *   → 最高 95
 *
 * ai-fallback only → 30 fixed（不进 multi-source，由 article-skill.persistAIJournal 直接写）
 *
 * data_source 逻辑：
 *   - 任一非 letpub 命中 + letpub 命中 → 'multi_source_verified'
 *   - 仅 letpub 命中 → 'legacy_match'（保守，因 letpub 已是历史强信号）
 *   - 全 4 源都没命中 → 不写（保留原 data_source）
 */

export interface TrustSourceFlags {
  crossref: boolean;
  doaj: boolean;
  scimago: boolean;
  letpub: boolean;
}

export interface TrustComputeResult {
  confidence: number;
  dataSource: "multi_source_verified" | "legacy_match" | null;
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
  if (flags.scimago) confidence += 15;
  if (flags.letpub) confidence += 20;

  // base 50 = 0 命中（无源）→ 保留原状态，不强写
  const totalHits = Number(flags.crossref) + Number(flags.doaj) + Number(flags.scimago) + Number(flags.letpub);
  if (totalHits === 0) {
    return { confidence: 50, dataSource: null, fieldProvenance: {} };
  }

  // 多源命中（≥2 源中至少一非 letpub）= multi_source_verified；单源 letpub = legacy_match
  const dataSource: "multi_source_verified" | "legacy_match" =
    totalHits >= 2 || (totalHits === 1 && !flags.letpub) ? "multi_source_verified" : "legacy_match";

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
  if (flags.scimago) {
    fieldProvenance.sjr = "scimago";
    fieldProvenance.qPartition = "scimago";
  }
  if (flags.letpub) {
    fieldProvenance.if_history = "letpub";
    fieldProvenance.cas_partition = "letpub";
    fieldProvenance.jcr_full = "letpub";
  }
  // caller 显式覆盖（如 publisher 由 letpub 提供时优先 letpub）
  for (const [field, source] of Object.entries(fieldHints)) {
    if (typeof source === "string") fieldProvenance[field] = source;
  }

  return { confidence: Math.min(confidence, 95), dataSource, fieldProvenance };
}
