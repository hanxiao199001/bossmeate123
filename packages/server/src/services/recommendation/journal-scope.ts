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
    // 真·国外刊 = 不带任何中文核心标签, 且有国际指标(IF 或分区)。与"国内核心"互斥。
    // (中文核心刊库里也常有复合IF和分区值, 所以必须先排除"带中文核心标签"的, 才不会把
    //  中华医学杂志/CSSCI/科技核心这些误判成国外刊)
    return sql`(
      (${journals.catalogs} IS NULL OR jsonb_array_length(${journals.catalogs}) = 0)
      AND (${journals.impactFactor} IS NOT NULL OR ${journals.partition} IS NOT NULL)
    )`;
  }
  return null;
}
