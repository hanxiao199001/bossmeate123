/**
 * PR-K: 期刊定位过滤 — 账号绑定 domestic(国内核心)/international(国外期刊)/both。
 *
 * 7-28: 判定口径已收口到生成列 `journals.journal_kind`(单一真相源见
 * `services/journals/journal-kind.ts`)。本文件只保留兼容转出, 别再在这里写新的启发式 ——
 * 原来的两条互斥启发式("catalogs 非空 = 国内" / "catalogs 空且有 IF = 国外")中间夹着一条
 * **定义裂缝**: 只写了 cscd_level/pku_core_level 而 catalogs 为空的刊两边都不算,
 * 对任何 scope 都不可见, 选刊器永远选不到它。
 */
export { journalScopeCondition, type JournalScope } from "../journals/journal-sql.js";
