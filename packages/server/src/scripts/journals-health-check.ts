/**
 * 线A-1 期刊库只读体检 — 不写库, 全量扫一遍 journals, 把脏数据照出来:
 *   ① 总量/confidence 分布/data_source 分布/ai_fabricated/验证时效
 *   ② 关键字段缺失率 (impact_factor / cas_partition / partition / acceptance_rate / review_cycle / if_history)
 *   ③ 冲突检测: IF vs if_history 最新年偏差>20% | cas_partition 无"区"字 | 复合IF误入 impact_factor 嫌疑
 *   ④ top 50 最脏期刊清单 → journals-health-report.md 供人工核对
 *
 * 用法 (packages/server 下):
 *   npx tsx src/scripts/journals-health-check.ts            # 控制台摘要 + 写 md 报告
 *   npx tsx src/scripts/journals-health-check.ts --json     # stdout 输出机器可读 JSON (md 仍写)
 *   选填 --out <path>  报告输出路径 (默认 ./journals-health-report.md)
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { journals } from "../models/schema.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function flag(n: string): boolean { return process.argv.includes(`--${n}`); }

/** 从 if_history jsonb 取最新年 IF. 兼容 {data:[{year,if}]} / [{year,value}] 两种结构 (同 backfill-if-from-history.ts 的 latestIF, 该处未导出故本地复刻). */
function latestIF(ifHistory: unknown): number | null {
  if (!ifHistory) return null;
  const raw = ifHistory as { data?: unknown } | unknown[];
  const data = Array.isArray(raw) ? raw : (Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : null);
  if (!Array.isArray(data) || data.length === 0) return null;
  let best: { year: number; if: number } | null = null;
  for (const row of data as Array<{ year?: number; if?: number; value?: number }>) {
    const yr = row.year;
    const v = row.if ?? row.value;
    if (typeof yr === "number" && typeof v === "number" && v > 0) {
      if (!best || yr > best.year) best = { year: yr, if: v };
    }
  }
  return best ? best.if : null;
}

interface JRow {
  id: string; name: string; nameEn: string | null; issn: string | null; status: string;
  confidence: number | null; dataSource: string | null; lastVerifiedAt: Date | null;
  impactFactor: number | null; compositeImpactFactor: number | null;
  casPartition: string | null; partition: string | null;
  acceptanceRate: number | null; reviewCycle: string | null; isWarningList: boolean;
  ifHistory: unknown; catalogType: string | null; catalogs: unknown; hasJcrFull: boolean;
}

function pct(n: number, total: number): string { return total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "-"; }

async function main() {
  const asJson = flag("json");
  const outPath = arg("out") ?? path.resolve(process.cwd(), "journals-health-report.md");

  // 一次全量拉需要的列 (jcr_full 只取存在性, 避免拖大 jsonb)
  const rows: JRow[] = await db.select({
    id: journals.id, name: journals.name, nameEn: journals.nameEn, issn: journals.issn, status: journals.status,
    confidence: journals.confidence, dataSource: journals.dataSource, lastVerifiedAt: journals.lastVerifiedAt,
    impactFactor: journals.impactFactor, compositeImpactFactor: journals.compositeImpactFactor,
    casPartition: journals.casPartition, partition: journals.partition,
    acceptanceRate: journals.acceptanceRate, reviewCycle: journals.reviewCycle, isWarningList: journals.isWarningList,
    ifHistory: journals.ifHistory, catalogType: journals.catalogType, catalogs: journals.catalogs,
    hasJcrFull: sql<boolean>`(${journals.jcrFull} is not null)`,
  }).from(journals);

  const total = rows.length;
  // dedup 脚本会把重复副本置 disabled, 缺失率只按 active 算才不失真
  const active = rows.filter((r) => r.status === "active");
  const nActive = active.length;

  // ① confidence 分布 (边界: [0,40) [40,60) [60,80) [80,100])
  const buckets = { "NULL": 0, "0-40": 0, "40-60": 0, "60-80": 0, "80-100": 0 };
  for (const r of active) {
    const c = r.confidence;
    if (c == null) buckets["NULL"]++;
    else if (c < 40) buckets["0-40"]++;
    else if (c < 60) buckets["40-60"]++;
    else if (c < 80) buckets["60-80"]++;
    else buckets["80-100"]++;
  }

  const dataSourceDist: Record<string, number> = {};
  for (const r of active) {
    const k = r.dataSource ?? "(NULL)";
    dataSourceDist[k] = (dataSourceDist[k] ?? 0) + 1;
  }
  const aiFabricated = active.filter((r) => r.dataSource === "ai_fabricated").length;

  const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const neverVerified = active.filter((r) => !r.lastVerifiedAt).length;
  const staleOver30d = active.filter((r) => r.lastVerifiedAt && r.lastVerifiedAt.getTime() < cutoff30d).length;

  // ② 关键字段缺失率
  // 注: is_warning_list 是 NOT NULL default false, 缺失恒 0 — 无法区分"未知"和"否", 改报 true 数量供参考
  // 7-02: 缺失率按国际/国内分栏 — 名字含中文=国内刊(country字段100%空, 用名字CJK判)。国内刊IF/分区缺失是正常(非SCI), 真要补的是国际刊的缺口。
  const isDomestic = (r: { name: string | null }) => /[一-鿿]/.test(r.name ?? "");
  const calcMissing = (rows: typeof active) => ({
    impact_factor: rows.filter((r) => r.impactFactor == null).length,
    cas_partition: rows.filter((r) => !r.casPartition).length,
    partition: rows.filter((r) => !r.partition).length,
    acceptance_rate: rows.filter((r) => r.acceptanceRate == null).length,
    review_cycle: rows.filter((r) => !r.reviewCycle).length,
    if_history: rows.filter((r) => r.ifHistory == null).length,
  });
  const intlRows = active.filter((r) => !isDomestic(r));
  const domesticRows = active.filter(isDomestic);
  const missingRates = calcMissing(active);
  const missingRatesIntl = calcMissing(intlRows);
  const missingRatesDomestic = calcMissing(domesticRows);
  const warningListTrue = active.filter((r) => r.isWarningList).length;

  // ③ 冲突检测 + 每刊问题归集
  type Issue = { id: string; name: string; confidence: number | null; issues: string[] };
  const perJournal: Issue[] = [];
  let cIfDeviation = 0, cCasFormat = 0, cCompositeSuspect = 0;

  for (const r of active) {
    const issues: string[] = [];

    // A. impact_factor vs if_history 最新年值偏差 > 20%
    const hist = latestIF(r.ifHistory);
    if (hist != null && r.impactFactor != null && r.impactFactor > 0) {
      const dev = Math.abs(r.impactFactor - hist) / hist;
      if (dev > 0.20) {
        cIfDeviation++;
        issues.push(`IF冲突: 单值${r.impactFactor} vs if_history最新${hist} (偏差${(dev * 100).toFixed(0)}%)`);
      }
    }

    // B. cas_partition 有值但不含"区"字 → 格式异常 (正常如 "医学2区")
    if (r.casPartition && !r.casPartition.includes("区")) {
      cCasFormat++;
      issues.push(`cas_partition格式异常: "${r.casPartition}"`);
    }

    // C. 复合IF误入 impact_factor 嫌疑 — 对齐 shunshi-style-template.ts hasWosData 判定:
    //    WoS 信号 = jcrFull.jifSubjects / impactFactor>0 / partition Q1-4。
    //    国内刊 (catalog_type 非 sci 或 catalogs 只有中文目录) 本不该有 WoS IF;
    //    若 impactFactor 有值但 issn/partition/jcrFull/if_history 全无 → 大概率是知网复合IF误灌
    //    (schema 6-20 注释: compositeImpactFactor 独立列, 绝不并入 impact_factor)
    const cats: string[] = Array.isArray(r.catalogs) ? (r.catalogs as unknown[]).map(String) : [];
    const domesticSignal =
      (r.catalogType != null && r.catalogType !== "sci") ||
      (cats.length > 0 && !cats.includes("sci") && !cats.includes("sci-core"));
    if (
      domesticSignal &&
      r.impactFactor != null && r.impactFactor > 0 &&
      !r.issn && !r.partition && !r.hasJcrFull && r.ifHistory == null
    ) {
      cCompositeSuspect++;
      issues.push(`疑似复合IF误入impact_factor: 国内刊(${r.catalogType ?? cats.join("/")})无WoS佐证但IF=${r.impactFactor}`);
    }

    // 治理属性也计入脏度 (供 top50 排序)
    if (r.dataSource === "ai_fabricated") issues.push("data_source=ai_fabricated");
    if (!r.lastVerifiedAt) issues.push("从未验证");
    if (r.confidence != null && r.confidence < 40) issues.push(`低可信度(${r.confidence})`);
    if (r.confidence == null) issues.push("confidence未评分");

    if (issues.length > 0) {
      perJournal.push({ id: r.id, name: r.nameEn || r.name, confidence: r.confidence, issues });
    }
  }

  // top 50 最脏: 问题数多优先, 同问题数按 confidence ASC NULLS FIRST
  perJournal.sort((a, b) => {
    if (b.issues.length !== a.issues.length) return b.issues.length - a.issues.length;
    const ca = a.confidence ?? -1, cb = b.confidence ?? -1;
    return ca - cb;
  });
  const top50 = perJournal.slice(0, 50);

  const result = {
    generatedAt: new Date().toISOString(),
    total, active: nActive, disabled: total - nActive,
    confidenceBuckets: buckets,
    dataSourceDist,
    aiFabricated,
    neverVerified,
    staleOver30d,
    needAttention: neverVerified + staleOver30d, // NULL 或 >30 天
    missingCounts: missingRates,
    missingCountsIntl: missingRatesIntl,
    missingCountsDomestic: missingRatesDomestic,
    intlCount: intlRows.length,
    domesticCount: domesticRows.length,
    warningListTrue,
    conflicts: { ifDeviationOver20pct: cIfDeviation, casPartitionFormat: cCasFormat, compositeIfSuspect: cCompositeSuspect },
    journalsWithIssues: perJournal.length,
    top50,
  };

  // —— markdown 报告 (无论 --json 都写, 供人工核对) ——
  const md: string[] = [];
  md.push(`# 期刊库体检报告`);
  md.push(`\n生成时间: ${result.generatedAt}  |  总数 ${total} (active ${nActive} / disabled ${total - nActive})\n`);
  md.push(`## confidence 分布 (active)\n`);
  md.push(`| 区间 | 数量 | 占比 |\n|---|---|---|`);
  for (const [k, v] of Object.entries(buckets)) md.push(`| ${k} | ${v} | ${pct(v, nActive)} |`);
  md.push(`\n## data_source 分布 (active)\n`);
  md.push(`| 来源 | 数量 | 占比 |\n|---|---|---|`);
  for (const [k, v] of Object.entries(dataSourceDist).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} | ${pct(v, nActive)} |`);
  md.push(`\n## 验证时效\n`);
  md.push(`- ai_fabricated: **${aiFabricated}**`);
  md.push(`- last_verified_at 为 NULL: **${neverVerified}** (${pct(neverVerified, nActive)})`);
  md.push(`- last_verified_at > 30 天: **${staleOver30d}** (${pct(staleOver30d, nActive)})`);
  const nIntl = intlRows.length, nDom = domesticRows.length;
  md.push(`\n## 关键字段缺失率 (active, 国际/国内分栏)\n`);
  md.push(`> 国际刊(英文名) ${nIntl} 本 | 国内刊(中文名) ${nDom} 本。国内刊 IF/分区缺失属正常(非 SCI 无此指标); 真要补的是国际刊缺口。\n`);
  md.push(`| 字段 | 国际缺失 | 国际缺失率 | 国内缺失 | 国内缺失率 |\n|---|---|---|---|---|`);
  for (const k of Object.keys(missingRates) as Array<keyof typeof missingRates>) {
    md.push(`| ${k} | ${missingRatesIntl[k]} | ${pct(missingRatesIntl[k], nIntl)} | ${missingRatesDomestic[k]} | ${pct(missingRatesDomestic[k], nDom)} |`);
  }
  md.push(`| is_warning_list | (NOT NULL 列, 缺失恒0; true=${warningListTrue}) | - | - | - |`);
  md.push(`\n## 冲突检测\n`);
  md.push(`- IF 与 if_history 最新年偏差 >20%: **${cIfDeviation}**`);
  md.push(`- cas_partition 格式异常 (不含"区"): **${cCasFormat}**`);
  md.push(`- 疑似复合IF误入 impact_factor (国内刊无WoS佐证): **${cCompositeSuspect}**`);
  md.push(`\n## Top 50 最脏期刊 (共 ${perJournal.length} 本有问题)\n`);
  md.push(`| # | id | 名称 | confidence | 问题 |\n|---|---|---|---|---|`);
  top50.forEach((j, i) => {
    md.push(`| ${i + 1} | \`${j.id}\` | ${j.name.replace(/\|/g, "\\|")} | ${j.confidence ?? "NULL"} | ${j.issues.join("; ").replace(/\|/g, "\\|")} |`);
  });
  md.push(`\n---\n处理建议: \`npx tsx src/scripts/journals-reenrich.ts --limit 20\` 从最脏开始 re-enrich。\n`);
  fs.writeFileSync(outPath, md.join("\n"), "utf-8");

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n🩺 期刊库体检 (active ${nActive} / 总 ${total})\n`);
    console.log(`confidence: NULL=${buckets["NULL"]}  0-40=${buckets["0-40"]}  40-60=${buckets["40-60"]}  60-80=${buckets["60-80"]}  80-100=${buckets["80-100"]}`);
    console.log(`data_source:`, Object.entries(dataSourceDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  "));
    console.log(`ai_fabricated=${aiFabricated}  从未验证=${neverVerified}  验证>30天=${staleOver30d}`);
    console.log(`缺失率[国际${nIntl}本]:`, Object.entries(missingRatesIntl).map(([k, v]) => `${k}=${pct(v, nIntl)}`).join("  "));
    console.log(`缺失率[国内${nDom}本]:`, Object.entries(missingRatesDomestic).map(([k, v]) => `${k}=${pct(v, nDom)}`).join("  "));
    console.log(`冲突: IF偏差>20%=${cIfDeviation}  cas格式异常=${cCasFormat}  复合IF嫌疑=${cCompositeSuspect}`);
    console.log(`\n📄 报告已写: ${outPath} (top50 最脏清单在报告里)`);
  }
}

main().then(async () => { await closePool(); process.exit(0); })
  .catch(async (e) => { console.error("体检异常:", e instanceof Error ? e.message : e); await closePool(); process.exit(1); });
