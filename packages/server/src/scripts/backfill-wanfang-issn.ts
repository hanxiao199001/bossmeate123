/**
 * 给中文核心刊补 ISSN（万方按刊名搜）。
 *
 * 候选: catalogs 非空(中文核心) + issn 为空 + status=active。
 * 对每本调 scrapeWanfangJournal(刊名) 拿 ISSN 写回。
 *
 * 反爬护栏:
 *   - 每次请求间隔 delayMs(默认 4s)+ 随机抖动
 *   - 连续 15 次无结果 → 疑似被限/封, 自动停止
 *   - 熔断开关 env BACKFILL_SKIP_WANFANG=true 立即停
 * 安全:
 *   - 只补"当前无 ISSN"的刊(不覆盖已有)
 *   - 默认预览(不写库, 限 20 本); 加 --apply 才写库
 * 用法: node dist/scripts/backfill-wanfang-issn.js [--apply] [--limit=N] [--delay=4000]
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { scrapeWanfangJournal } from "../services/crawler/cnki-journal-scraper.js";
import { logger } from "../config/logger.js";

function argVal(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.split("=")[1] : undefined;
}
const ISSN_RE = /^\d{4}-\d{3}[\dXx]$/;

async function main() {
  const apply = process.argv.includes("--apply");
  const limit = parseInt(argVal("--limit") ?? (apply ? "100000" : "20"), 10);
  const delayMs = parseInt(argVal("--delay") ?? "4000", 10);

  const candidates = await db
    .select({ id: journals.id, name: journals.name })
    .from(journals)
    .where(and(
      isNull(journals.issn),
      eq(journals.status, "active"),
      sql`${journals.catalogs} IS NOT NULL AND jsonb_array_length(${journals.catalogs}) > 0`,
    ))
    .limit(limit);

  console.log(`[wanfang-issn] 候选(中文核心无ISSN): ${candidates.length} | apply=${apply} | delay=${delayMs}ms`);

  let found = 0, updated = 0, miss = 0, consecFail = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (process.env.BACKFILL_SKIP_WANFANG === "true") { console.log("[wanfang-issn] 熔断 BACKFILL_SKIP_WANFANG, 停止"); break; }
    const j = candidates[i];
    if (!j.name || j.name.length < 3) { miss++; continue; }

    let issn: string | null = null;
    try {
      const r = await scrapeWanfangJournal(j.name);
      if (r?.issn && ISSN_RE.test(r.issn)) issn = r.issn.toUpperCase();
    } catch (err) {
      logger.warn({ err: String(err), name: j.name }, "[wanfang-issn] 抓取异常");
    }

    if (issn) {
      found++; consecFail = 0;
      if (apply) {
        await db.update(journals).set({ issn }).where(and(eq(journals.id, j.id), isNull(journals.issn)));
        updated++;
      }
      if (i < 15 || !apply) console.log(`  ✓ ${j.name} → ${issn}${apply ? " (写库)" : ""}`);
    } else {
      miss++; consecFail++;
      if (consecFail >= 15) { console.log(`[wanfang-issn] 连续 ${consecFail} 次无结果, 疑似被限/封, 停止`); break; }
    }

    if ((i + 1) % 50 === 0) console.log(`[wanfang-issn] 进度 ${i + 1}/${candidates.length} | 找到 ${found} | 写 ${updated}`);
    await new Promise((r) => setTimeout(r, delayMs + Math.floor(Math.random() * 2000)));
  }

  logger.info({ candidates: candidates.length, found, updated, miss }, "[wanfang-issn] 完成");
  console.log(`[wanfang-issn] 完成: 候选 ${candidates.length} | 找到 ISSN ${found} | 写库 ${updated} | 无果 ${miss}`);
  if (!apply) console.log("[wanfang-issn] 预览(未写库)。确认 ISSN 准确后加 --apply 全量跑。");
  process.exit(0);
}

main().catch((err) => { logger.error({ err }, "[wanfang-issn] 失败"); process.exit(1); });
