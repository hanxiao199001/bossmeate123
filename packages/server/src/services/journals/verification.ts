/**
 * 期刊可信度判定（单一事实源，客服播报护栏 + daily-cron 未核实源护栏共用）。
 * conf<70 或 legacy_unknown = 未核实：其 IF/分区/预警/录用率是未多源核实的历史数据，
 * 不当权威播报给客户，也不该无人复核就自动生成对外内容。
 */
export function isUnverifiedJournal(j: { confidence?: number | null; dataSource?: string | null }): boolean {
  return (j.confidence ?? 0) < 70 || j.dataSource === "legacy_unknown";
}
