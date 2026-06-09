/**
 * PR-K: 期刊定位过滤 — 账号绑定 domestic(国内核心)/international(国外期刊)/both。
 * 单一事实来源: "国内核心" = 有中文目录标签(catalogs 非空); "国外期刊" = 有 JCR 分区 或 (有IF且无中文核心标签); 排除有复合IF的中文核心刊。
 * 供 roundup 选刊 + /journals 列表 + 未来单篇流复用。
 */
import { sql, type SQL } from "drizzle-orm";
import { journals } from "../../models/schema.js";

export type JournalScope = "domestic" | "international" | "both";

/** 返回 drizzle SQL 条件; both/未知 → null (不过滤)。 */
export function journalScopeCondition(scope?: string | null): SQL | null {
  if (scope === "domestic") {
    return sql`(${journals.catalogs} IS NOT NULL AND jsonb_array_length(${journals.catalogs}) > 0)`;
  }
  if (scope === "international") {
    // 真·国外刊: 有 JCR 分区(Q1-Q4), 或 有 IF 且不带任何中文核心标签。
    // (中文核心刊在库里也常有"复合影响因子", 不能只看 IF, 否则中华医学杂志/北大学报会被误判为国外刊)
    return sql`(
      ${journals.partition} IS NOT NULL
      OR (${journals.impactFactor} IS NOT NULL AND (${journals.catalogs} IS NULL OR jsonb_array_length(${journals.catalogs}) = 0))
    )`;
  }
  return null;
}
