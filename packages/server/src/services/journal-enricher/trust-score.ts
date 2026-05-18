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
}

export interface TrustComputeResult {
  confidence: number;
  dataSource: "multi_source_verified" | "letpub_only" | null;
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

  // base 50 = 0 命中（无源）→ 保留原状态，不强写
  const totalHits = Number(flags.crossref) + Number(flags.doaj) + Number(flags.letpub);
  if (totalHits === 0) {
    return { confidence: 50, dataSource: null, fieldProvenance: {} };
  }

  // 多源命中（≥2 源中至少一非 letpub）= multi_source_verified；单源 letpub = letpub_only
  const dataSource: "multi_source_verified" | "letpub_only" =
    totalHits >= 2 || (totalHits === 1 && !flags.letpub) ? "multi_source_verified" : "letpub_only";

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
  // caller 显式覆盖（如 publisher 由 letpub 提供时优先 letpub）
  for (const [field, source] of Object.entries(fieldHints)) {
    if (typeof source === "string") fieldProvenance[field] = source;
  }

  return { confidence: Math.min(confidence, 95), dataSource, fieldProvenance };
}
