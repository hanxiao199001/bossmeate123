/**
 * journal-enricher 模块入口（B.2.1.A）
 *
 * 公开 API：
 *  - enrichJournal(journalId, options?): Promise<EnrichmentResult>
 *  - 类型 EnrichmentResult / EnrichOptions
 */

export { enrichJournal } from "./orchestrator.js";
export type { EnrichmentResult, EnrichOptions } from "./types.js";
