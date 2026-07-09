/**
 * task#104 阶段1: 对"带核心标记 + 当前未核实(conf<70)"的期刊, 把已 ingest 的 CSCD/北大核心信号
 * 接进 confidence + data_source(复用 computeTrust)。零爬取, 只读 DB 现有字段重算。
 *
 * DB 护栏: 默认 dry-run(只报告不写)。加 --apply 才写。幂等。
 *   用法: set -a && . .env && set +a && npx tsx src/scripts/rescore-cn-core.ts [--apply]
 *
 * intl 源 flag 从 metadata.fieldProvenance + if_history 反推, 保证已有国际源的刊不被误降级。
 */
import { and, or, isNotNull, ne, lt, isNull, eq, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { computeTrust } from "../services/journal-enricher/trust-score.js";

const APPLY = process.argv.includes("--apply");

function deriveFlags(j: typeof journals.$inferSelect) {
  const prov = ((j.metadata as { fieldProvenance?: Record<string, string> } | null)?.fieldProvenance) ?? {};
  return {
    crossref: prov.publisher === "crossref" || prov.issn === "crossref",
    doaj: prov.apc === "doaj" || prov.openAccess === "doaj",
    scimago: false,
    // letpub 从 provenance/if_history 反推; 再兜底: 现 data_source 已是 letpub_only/multi_source_verified 的刊必然曾命中 letpub
    letpub: prov.if_history === "letpub" || prov.cas_partition === "letpub" || j.ifHistory != null
      || j.dataSource === "letpub_only" || j.dataSource === "multi_source_verified",
    pkuCore: j.pkuCoreLevel === "北大核心",
    cscdCore: j.cscdLevel === "核心库",
    cscdExtended: j.cscdLevel === "扩展库",
  };
}

// 目标: 带核心标记 且 conf<70(含 null) —— 未核实的核心刊(要升级的洼地)
const rows = await db.select().from(journals).where(and(
  or(
    and(isNotNull(journals.cscdLevel), ne(journals.cscdLevel, "")),
    and(isNotNull(journals.pkuCoreLevel), ne(journals.pkuCoreLevel, "")),
  ),
  or(lt(journals.confidence, 70), isNull(journals.confidence)),
  ne(journals.dataSource, "ai_fabricated"), // 别碰编造刊
));

let crossed = 0, unchanged = 0;
const dsBefore: Record<string, number> = {}, dsAfter: Record<string, number> = {};
const updates: Array<{ id: string; conf: number; ds: string; prov: Record<string, string> }> = [];

for (const j of rows) {
  const flags = deriveFlags(j);
  const t = computeTrust(flags);
  if (!t.dataSource) continue; // 理论上核心刊必有 dataSource
  const oldConf = j.confidence ?? 50;
  const oldDs = j.dataSource ?? "(null)";
  // 护栏: 绝不降级已有 multi_source_verified 标签(国际交叉语义比 cn_core 强, 即便本次没读到其 provenance)——
  //   只借核心信号把它的 confidence 顶过 70。其余(legacy/letpub_only/null)用 computeTrust 结果。
  const newDs = oldDs === "multi_source_verified" ? "multi_source_verified" : t.dataSource;
  dsBefore[oldDs] = (dsBefore[oldDs] ?? 0) + 1;
  dsAfter[newDs] = (dsAfter[newDs] ?? 0) + 1;
  if (oldConf < 70 && t.confidence >= 70) crossed++; else unchanged++;
  const existingProv = ((j.metadata as { fieldProvenance?: Record<string, string> } | null)?.fieldProvenance) ?? {};
  updates.push({ id: j.id, conf: t.confidence, ds: newDs, prov: { ...existingProv, ...t.fieldProvenance } });
}

// 当前国内 verified 池(conf>=70 且 catalogs 非空) 作对照基线
const domPool = await db.select({ pool: sql<number>`count(*)::int` }).from(journals).where(and(
  eq(journals.status, "active"),
  sql`${journals.confidence} >= 70`,
  sql`${journals.catalogs} IS NOT NULL AND jsonb_array_length(${journals.catalogs}) > 0`,
));
const verifiedDomBefore = Number(domPool[0]?.pool ?? 0);

console.log(`\n=== task#104 CN 核心目录重评分 ${APPLY ? "【APPLY 写库】" : "【DRY-RUN 只读】"} ===`);
console.log(`范围(带核心标记 + conf<70): ${rows.length} 条`);
console.log(`  → 会从 <70 升到 ≥70(越 verified 门槛): ${crossed} 条`);
console.log(`  → 保持 <70(仅 CSCD扩展库+10 到 60 等): ${unchanged} 条`);
console.log(`data_source 变化(前 → 后):`);
console.log(`  before:`, dsBefore);
console.log(`  after :`, dsAfter);
console.log(`国内 verified 池(conf≥70+catalogs): 当前 ${verifiedDomBefore} → 预计 +${crossed}(命中核心的国内刊) ≈ ${verifiedDomBefore + crossed}`);

if (!APPLY) {
  console.log(`\n[dry-run] 未写库。确认无误后加 --apply 执行。`);
  process.exit(0);
}

console.log(`\n[apply] 写库中(幂等)...`);
let done = 0;
for (const u of updates) {
  await db.update(journals).set({
    confidence: u.conf,
    dataSource: u.ds,
    lastVerifiedAt: new Date(),
    metadata: sql`COALESCE(${journals.metadata}, '{}'::jsonb) || ${JSON.stringify({ fieldProvenance: u.prov })}::jsonb`,
  }).where(eq(journals.id, u.id));
  done++;
  if (done % 200 === 0) console.log(`  ...${done}/${updates.length}`);
}
console.log(`[apply] ✅ 更新 ${done} 条。`);
process.exit(0);
