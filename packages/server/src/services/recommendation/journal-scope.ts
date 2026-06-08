/**
 * PR-K: 期刊定位过滤 — 账号绑定 domestic(国内核心)/international(国外期刊)/both。
 * 单一事实来源: "国内核心" = 有中文目录标签(catalogs 非空); "国外期刊" = 有国际指标(IF 或 JCR 分区)。
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
    return sql`(${journals.impactFactor} IS NOT NULL OR ${journals.partition} IS NOT NULL)`;
  }
  return null;
}
