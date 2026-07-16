/**
 * 万方国内刊批量富化（task#104 阶段2）。
 *
 * 目标：把万方富化从"手动预填 perioId"升级为"自动解析 perioId + 规模化补国内刊数据"。
 * 流程（每本）：
 *   1. 选池：国内刊（catalogs 非空 或 cscd/pku 有标记）且 metadata.wanfang.perioId 为空
 *   2. resolveWanfangPerioId(ISSN 优先 / 刊名兜底) 自动解析 perioId
 *   3. --apply 时：写回 metadata.wanfang.perioId（幂等，下次不用重解析）→ enrichJournal(id)
 *      （orchestrator 已有万方分支：写 cscd/pku 动态标 + composite_impact_factor + metadata.wanfang）
 *
 * 合规护栏（严守 task 约束）：
 *   - 只万方，不知网（不引用任何 CNKI 抓取）
 *   - 节流 concurrency=1，每本间隔 10s±3s（复用 verify-wanfang-trial 节奏，别加速）
 *   - 熔断：连续 N 次解析不到 perioId → 疑似被限/封，自动停（参考 LetPub 断路器）
 *   - 熔断开关 env ENRICH_SKIP_WANFANG=true / BACKFILL_SKIP_WANFANG=true 立即停
 *   - 断点续跑：已有 perioId 的自动跳过（选池即排除）
 *   - DB 护栏：默认 dry-run（只解析 + 报告，不写库不富化）；加 --apply 才落库
 *
 * 用法（dry-run 先给老韩过目）：
 *   ssh ... 'cd /home/projects/bossmate/packages/server && set -a && source ../../.env && set +a && \
 *     node dist/scripts/enrich-wanfang-batch.js --limit=30'
 * 拍板后全量 apply：
 *   node dist/scripts/enrich-wanfang-batch.js --apply
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import {
  resolveWanfangPerioId,
  selectWanfangCandidates,
  type WanfangCandidateRow,
} from "../services/journal-enricher/fetchers/wanfang-perioid-resolver.js";
import { enrichJournal } from "../services/journal-enricher/orchestrator.js";
import { logger } from "../config/logger.js";

function argVal(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.split("=")[1] : undefined;
}

const SKIP = () =>
  process.env.ENRICH_SKIP_WANFANG === "true" || process.env.BACKFILL_SKIP_WANFANG === "true";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limit = parseInt(argVal("--limit") ?? (apply ? "100000" : "30"), 10);
  const baseDelay = parseInt(argVal("--delay") ?? "10000", 10); // 10s 基准（合规）
  const jitter = parseInt(argVal("--jitter") ?? "3000", 10); // ±3s 抖动
  const breakerN = parseInt(argVal("--breaker") ?? "15", 10); // 连续 N 次无果熔断

  // 宽松 SQL 预筛（国内刊信号），细过滤交给 pure selectWanfangCandidates
  const rows = (await db
    .select({
      id: journals.id,
      name: journals.name,
      nameEn: journals.nameEn,
      issn: journals.issn,
      catalogs: journals.catalogs,
      cscdLevel: journals.cscdLevel,
      pkuCoreLevel: journals.pkuCoreLevel,
      metadata: journals.metadata,
    })
    .from(journals)
    .where(
      and(
        eq(journals.status, "active"),
        sql`(
          (${journals.catalogs} IS NOT NULL AND jsonb_array_length(${journals.catalogs}) > 0)
          OR ${journals.cscdLevel} IS NOT NULL
          OR ${journals.pkuCoreLevel} IS NOT NULL
        )`,
      ),
    )) as WanfangCandidateRow[];

  const candidates = selectWanfangCandidates(rows).slice(0, limit);
  console.log(
    `[wanfang-batch] 国内刊预筛 ${rows.length} → 待解析候选(无 perioId) ${candidates.length} | apply=${apply} | 节流 ${baseDelay}±${jitter}ms`,
  );
  if (!apply) console.log("[wanfang-batch] ⚠️ dry-run：只解析 perioId + 统计，不写库不富化。确认后加 --apply。");

  let resolved = 0;
  let enriched = 0;
  let miss = 0;
  let consecMiss = 0;
  const byMatch: Record<string, number> = { issn: 0, name_exact: 0, name_fuzzy: 0 };
  const sampleResolved: Array<{ name: string; perioId: string; matchType: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    if (SKIP()) {
      console.log("[wanfang-batch] 熔断开关触发（ENRICH_SKIP_WANFANG），停止");
      break;
    }
    const j = candidates[i];
    let match: Awaited<ReturnType<typeof resolveWanfangPerioId>> = null;
    try {
      match = await resolveWanfangPerioId({ issn: j.issn, nameZh: j.name });
    } catch (err) {
      logger.warn({ err: String(err), name: j.name }, "[wanfang-batch] perioId 解析异常");
    }

    if (match) {
      resolved++;
      consecMiss = 0;
      byMatch[match.matchType] = (byMatch[match.matchType] ?? 0) + 1;
      if (sampleResolved.length < 20) sampleResolved.push({ name: j.name!, perioId: match.perioId, matchType: match.matchType });

      if (apply) {
        // 幂等写回 perioId（merge metadata，不破坏其他键）
        const meta = (j.metadata as Record<string, any> | null) ?? {};
        const wf = (meta.wanfang as Record<string, any> | null) ?? {};
        const newMeta = {
          ...meta,
          wanfang: { ...wf, perioId: match.perioId, perioIdMatchType: match.matchType, perioIdResolvedAt: new Date().toISOString() },
        };
        await db.update(journals).set({ metadata: newMeta, updatedAt: new Date() }).where(eq(journals.id, j.id));
        // 富化（orchestrator 重新 load journal → 读到刚写的 perioId → 抓万方 → 写 cscd/pku/composite_if）
        try {
          const r = await enrichJournal(j.id);
          if (r.successFields.some((f) => f.startsWith("wanfang") || f.includes("composite_impact") || f.includes("cscd") || f.includes("pku"))) enriched++;
          console.log(`  ✓ ${j.name} → ${match.perioId} (${match.matchType}) 富化字段: ${r.successFields.filter((f) => f.includes("wanfang") || f.includes("composite") || f.includes("cscd") || f.includes("pku")).join(", ") || "无新增"}`);
        } catch (err) {
          logger.warn({ err: String(err), id: j.id }, "[wanfang-batch] enrichJournal 失败(不阻塞)");
        }
      } else {
        console.log(`  ○ [dry] ${j.name} → ${match.perioId} (${match.matchType})`);
      }
    } else {
      miss++;
      consecMiss++;
      if (consecMiss >= breakerN) {
        console.log(`[wanfang-batch] 连续 ${consecMiss} 次解析不到 perioId，疑似被限/封或搜索入口失效，熔断停止`);
        break;
      }
    }

    if ((i + 1) % 20 === 0) console.log(`[wanfang-batch] 进度 ${i + 1}/${candidates.length} | 解析 ${resolved} | 富化 ${enriched} | 无果 ${miss}`);
    if (i < candidates.length - 1) await sleep(baseDelay + Math.floor(Math.random() * jitter));
  }

  console.log("\n📊 [wanfang-batch] 总览：");
  console.log(`  候选 ${candidates.length} | 解析到 perioId ${resolved} | 富化 ${enriched} | 无果 ${miss}`);
  console.log(`  匹配方式：ISSN ${byMatch.issn} | 刊名精确 ${byMatch.name_exact} | 刊名模糊 ${byMatch.name_fuzzy}（模糊需人工复核）`);
  if (sampleResolved.length) {
    console.log("  样例：");
    sampleResolved.forEach((s) => console.log(`    ${s.name} → ${s.perioId} (${s.matchType})`));
  }
  if (!apply) {
    console.log("\n[wanfang-batch] dry-run 结束。预计可补字段：cscd_level/pku_core_level 动态校验、composite_impact_factor(万方中信所IF)、编辑部信息(metadata.wanfang)。");
    console.log("[wanfang-batch] 确认解析准确率后，加 --apply 落库富化。");
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, "[wanfang-batch] 失败");
    process.exit(1);
  });
}
