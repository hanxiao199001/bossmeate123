/**
 * journals 表的 SQL 条件**单一真相源** (7-28)。
 *
 * 三类条件都放这里, 谁也别再在调用点手写:
 *   ① 定位过滤   `journalScopeCondition(scope)`  —— 读生成列 journal_kind(见 journal-kind.ts)
 *   ② 分体系可信 `verifiedJournalCondition()`    —— 国内刊按目录成员资格, 国际刊按 conf>=70
 *   ③ 租户口径   `journalVisibleTo` / `journalOwnedBy`
 *
 * ## ③ 为什么单独抽 helper(同一个病已经犯了 13 次)
 * 线上 8743 本期刊的 `tenant_id` 是 **NULL** —— 它们是全局共享参考数据, 只有租户自建刊才带
 * tenant_id。SQL 里 `NULL = 'uuid'` 求值为 NULL(既不真也不假), 所以 `eq(journals.tenantId, x)`
 * 会把**整个共享池排除**, 端点/服务对任何租户都静默返回 0 条 —— 不报错、不告警, 只是"什么都没有"。
 * 7-25 修了 routes/journals.ts 的 4 处, 但同一个病在另外 9 处读路径还活着(选题工坊恒 404、
 * 视频 skill 静默不产、热点匹配恒空、封面预取恒空 …)。
 *
 * **铁律: 读放宽(共享池 + 自有刊), 写严格(只认自己的刊)。**
 * 回归锁: `__tests__/journals-tenant-scope-scan.test.ts` 全量扫 src/**\/*.ts, 白名单外出现裸
 * `eq(journals.tenantId, …)` 即红。
 */
import { eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { journals } from "../../models/schema.js";
import {
  DOMESTIC_KINDS,
  INTERNATIONAL_KINDS,
  buildVerifiedJournalSql,
  type JournalKind,
} from "./journal-kind.js";

/** join 查询里 journals 的列必须带表名消歧(journal_usage 也有 tenant_id 等同名列) */
const P = "journals.";

export type JournalScope = "domestic" | "international" | "both";

/**
 * 定位过滤条件; both/未知 → null(不过滤)。
 *
 * 7-28 改读生成列 `journal_kind`(原先是"catalogs 非空 / catalogs 空且有 IF"两条互斥启发式,
 * 中间夹着一条**定义裂缝**: 只有 cscd_level/pku_core_level 的刊两边都不算, 对任何 scope 不可见)。
 * 语义变化只有一处、且只是加法: 裂缝刊(kind='cn')现在国内槽位能看见了。
 * 骑墙刊(kind='both')仍**只**进国内槽位, 不进国外槽位 —— 中华医学杂志不许被当成国外刊。
 */
export function journalScopeCondition(scope?: string | null): SQL | null {
  if (scope === "domestic") return inArray(journals.journalKind, DOMESTIC_KINDS as JournalKind[]);
  if (scope === "international") return inArray(journals.journalKind, INTERNATIONAL_KINDS as JournalKind[]);
  return null;
}

/**
 * 分体系可信门槛(与 `services/journals/verification.ts` 的 `isVerifiedJournal()` 同一份规则):
 *   - `cn` 刊:      目录成员资格(北大核心/CSCD/CSSCI/CSTPCD) 或 (CN刊号 + 主办方), 排除 ai_fabricated
 *   - 其余(intl/both/unknown): confidence >= 70 且非 legacy_unknown(现状不变)
 */
export function verifiedJournalCondition(): SQL {
  return sql.raw(buildVerifiedJournalSql(P));
}

/** 读口径: 共享池(tenant_id IS NULL) + 本租户自建刊。tenantId 缺失时只给共享池。 */
export function journalVisibleTo(tenantId: string | null | undefined): SQL {
  if (!tenantId) return isNull(journals.tenantId);
  return or(isNull(journals.tenantId), eq(journals.tenantId, tenantId))!;
}

/**
 * 写口径: **只认本租户自建刊**。共享池的富化/修改走 `pnpm journals:reenrich` 脚本或
 * PATCH /journals/:id(owner/admin 角色闸在前的显式授权例外), 不许从别的写路径放宽。
 */
export function journalOwnedBy(tenantId: string): SQL {
  return eq(journals.tenantId, tenantId);
}
