/**
 * OpenAlex extractors (B.2.1.B.2)
 *
 * 从 OpenAlex source / institutions 聚合数据中提取我们的 4 个字段：
 *  - topInstitutions（global / country-filtered，与 publication_stats 合）
 *  - scope_details.subjectDistribution（按 topic_share field 维度 rollup）
 *  - scope_details.categories（去 noise，按 field 维度 group 取前 N）
 *  - publication_costs (apc_usd / openAccess / DOAJ flag)
 *  - publisher (host_organization_name)
 *
 * 不做 LLM 调用 / 网络抓取 — 全部 sync 纯函数。
 */

import type {
  OpenAlexSource,
  OpenAlexInstitutionRow,
} from "../fetchers/openalex-fetcher.js";
import type {
  TopInstitutionRow,
  ScopeDetailsShape,
  ScopeCategory,
  PublicationCostsShape,
} from "../types.js";

const MAX_INSTITUTIONS = 5;
const MAX_CATEGORIES = 8;
const MAX_SUBJECT_ROWS = 8;

/** institutions group_by 转 TopInstitutionRow（country 可选）。 */
export function extractTopInstitutionsFromOpenAlex(
  rows: OpenAlexInstitutionRow[] | null,
  country?: string,
): TopInstitutionRow[] | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cleaned = rows
    .filter((r) => r && typeof r.key_display_name === "string" && r.key_display_name.trim())
    .slice(0, MAX_INSTITUTIONS)
    .map((r) => ({
      name: r.key_display_name.trim(),
      paperCount: typeof r.count === "number" ? r.count : undefined,
      country: country ? country.toUpperCase() : undefined,
    }));
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 从 source.topics + topic_share 抽 scope_details。
 *
 * Rollup 策略（解决 raw topics 噪声问题）：
 *  - subjectDistribution: 把 topic_share[] 按 field.display_name 累加 → 取 top N
 *  - categories: 把 topics[] 按 field.display_name dedup → 取前 N 作 categories
 *
 * 综合性大刊（Lancet/Nature 等）raw topics 经常 mis-classify（"Human auditory perception"
 * 跑前面），但 field 维度 rollup 后聚到 "Medicine / Health Professions" 等大类，更稳。
 */
export function extractScopeDetailsFromOpenAlex(source: OpenAlexSource | null): ScopeDetailsShape | null {
  if (!source) return null;
  const topicShare = Array.isArray(source.topic_share) ? source.topic_share : [];
  const topics = Array.isArray(source.topics) ? source.topics : [];

  // subjectDistribution: 按 field 维度累加 topic_share 百分比
  const fieldWeights = new Map<string, number>();
  for (const t of topicShare) {
    const fieldName = t.field?.display_name;
    if (!fieldName || typeof t.value !== "number" || !Number.isFinite(t.value)) continue;
    fieldWeights.set(fieldName, (fieldWeights.get(fieldName) ?? 0) + t.value);
  }
  const sortedFields = [...fieldWeights.entries()].sort((a, b) => b[1] - a[1]);
  const subjectDistribution = sortedFields
    .map(([subject, weight]) => ({ subject, percent: Math.round(weight * 100) }))
    .filter((r) => r.percent > 0)
    .slice(0, MAX_SUBJECT_ROWS);

  // categories: 用 topic_share 的 field 排序（与 subjectDistribution 一致），
  // 然后从 topics[] 找出每个 field 第一个 subfield 作 description。
  // 这样综合性大刊（Lancet）不会被 raw topic count noise 主导。
  const subfieldByField = new Map<string, string | undefined>();
  for (const t of topics) {
    const fieldName = t.field?.display_name;
    if (!fieldName || subfieldByField.has(fieldName)) continue;
    subfieldByField.set(fieldName, t.subfield?.display_name);
  }
  const categories: ScopeCategory[] = sortedFields
    .slice(0, MAX_CATEGORIES)
    .map(([fieldName]) => ({
      title: fieldName,
      description: subfieldByField.get(fieldName)
        ? `Including ${subfieldByField.get(fieldName)}`
        : undefined,
    }));

  if (subjectDistribution.length === 0 && categories.length === 0) return null;
  return {
    categories: categories.length > 0 ? categories : undefined,
    subjectDistribution: subjectDistribution.length > 0 ? subjectDistribution : undefined,
    source: "openalex",
    lastUpdatedAt: new Date().toISOString(),
  };
}

/**
 * publication_costs from OpenAlex.
 *
 * 触发条件：source.apc_usd 是数字 + > 0（订阅刊 hybrid OA option 也常有 apc_usd）。
 * openAccess 用 source.is_oa；DOAJ 状态用 source.is_in_doaj 也作 hint（OpenAlex
 * 数据偶尔比 DOAJ API 新或旧，按 OpenAlex 字面取）。
 */
export function extractPublicationCostsFromOpenAlex(
  source: OpenAlexSource | null,
): PublicationCostsShape | null {
  if (!source) return null;
  const apc = source.apc_usd;
  if (typeof apc !== "number" || !Number.isFinite(apc) || apc <= 0) return null;
  // currency: prefer apc_prices[0].currency；否则 USD（apc_usd 字段语义 USD）
  const currency =
    Array.isArray(source.apc_prices) && source.apc_prices[0]?.currency
      ? String(source.apc_prices[0].currency).toUpperCase()
      : "USD";
  return {
    apc,
    currency,
    openAccess: typeof source.is_oa === "boolean" ? source.is_oa : undefined,
    fastTrack: false,
    source: "openalex",
    lastUpdatedAt: new Date().toISOString(),
  };
}

/** Publisher 名（如 "Elsevier BV"）→ journals.publisher 字段回填用。 */
export function extractPublisherFromOpenAlex(source: OpenAlexSource | null): string | null {
  if (!source) return null;
  const name = source.host_organization_name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}
