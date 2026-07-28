/**
 * 期刊可信度判定（单一事实源，客服播报护栏 + daily-cron 选刊器 + batch-worker needs_review 共用）。
 *
 * 7-28 分体系门槛（③c，解冻国内刊）:
 *   - **国际体系刊(intl/both/unknown)**: 维持 `confidence >= 70 且非 legacy_unknown`。
 *     其 IF/分区/预警/录用率靠 crossref+doaj+letpub 多源交叉验证，未过线 = 不当权威播报。
 *   - **国内刊(cn)**: 改判**目录成员资格 + 刊号实体确认**。
 *     病根: trust-score 的加分项全是国际源(crossref+20/doaj+10/letpub+20)，国内刊可信度
 *     天花板是"进北大核心或 CSCD 核心库 = 恰好 70"，只在 CSCD 扩展库 = 60，两个目录都不在 = 50
 *     → 拿国际刊的尺子量国内刊，88% 国内刊(生产实测 verified 427/3707)永远过不了线，
 *     综合性人文社科 0/122、中国政治 0/43 —— 整个学科一本都推不出来。
 *     国内刊本来就不用 SCI 那套指标体系衡量，"这本刊在不在北大核心/CSCD/CSSCI 目录里"
 *     是个**确定性事实**，比多源交叉更硬。
 *
 * ⚠️ `ai_fabricated`(LLM 编的影子刊, conf=30) 在两个体系里都判未核实 —— 它的"CN 刊号+主办方"
 *    也是编的，不能因为字段填满了就发权威背书。
 */
import { isCnVerified, toJournalKind, type JournalKindFields } from "./journal-kind.js";

export type VerifiableJournal = JournalKindFields & {
  confidence?: number | null;
  dataSource?: string | null;
  publisher?: string | null;
};

/** 国际体系门槛（现状不变） */
export function isIntlVerified(j: VerifiableJournal): boolean {
  return (j.confidence ?? 0) >= 70 && j.dataSource !== "legacy_unknown";
}

/**
 * 分体系"已核实"判定 —— 与 `journal-sql.ts#verifiedJournalCondition()` 的 SQL 是同一份规则。
 *
 * ⚠️ 国内刊那一支是 `目录成员资格 **OR** 老门槛`，不是"换一条"。**只加不减**是刻意的：
 *    下游有调用点（batch-worker 判 needs_review 时只投影了 confidence/dataSource 等几列）
 *    拿不到 catalogs/cscd_level —— 若国内刊改成"只认目录"，这些点会把原本 conf>=70 的国内刊
 *    反判成未核实，把解冻做成**倒退**。并成 OR 后，原先算已核实的刊一本都不会掉下来。
 */
export function isVerifiedJournal(j: VerifiableJournal): boolean {
  if (j.dataSource === "ai_fabricated") return false;
  return toJournalKind(j) === "cn" ? isCnVerified(j) || isIntlVerified(j) : isIntlVerified(j);
}

/**
 * 未核实 = 已核实的反面。未核实刊的数据不当权威播报给客户，也不该无人复核就自动生成对外内容
 * （batch-worker 会把它生成的内容标 needs_review）。
 *
 * ⚠️ 入参最好是**完整的 journals 行**：只传 {confidence,dataSource} 的调用点会因为拿不到
 *    目录字段而把国内刊判成未核实（= 退回 7-28 前的老行为，安全但不解冻）。
 */
export function isUnverifiedJournal(j: VerifiableJournal): boolean {
  return !isVerifiedJournal(j);
}
