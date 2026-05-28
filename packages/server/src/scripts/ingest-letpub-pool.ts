/**
 * 5-20 PR #187 — LetPub 主渠道扩池: 按学科翻页爬全站期刊列表入库.
 *
 * 用法 (prod):
 *   # 1. 先 ingest (列表爬, 请求少, 快):
 *   ssh ubuntu@122.152.234.155 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && node dist/scripts/ingest-letpub-pool.js'
 *
 *   # 2. 再 enrich (交叉验证升 confidence, 慢 + 限速):
 *   ... node dist/scripts/ingest-letpub-pool.js --enrich
 *
 *   # 可选: 只爬指定学科 / 调限速 / 隐身模式
 *   ... node dist/scripts/ingest-letpub-pool.js --only=medicine,computer --throttle=5 --stealthy
 *
 * 行为:
 *   1. 遍历学科 (默认全部 14 个), 每个调 crawlLetpubCategory 翻页爬列表
 *   2. dedup: 按 ISSN (空则按 name) 查重, 已存在的跳过 → 断点续爬 (重跑只补新的)
 *   3. insert 新期刊: confidence=60, source='letpub-list', tenantId=null (全局共享)
 *   4. --enrich: 对新入库期刊跑 enrichJournal (6 源交叉验证, letpub 命中 +20 → 80 进推荐)
 *   5. 报告: 每学科 +N / 总入库 / 总 enrich
 *
 * 注: LetPub 反爬 — 默认 throttle=4s/页 + 随机抖动. 激进可调小, 但封 IP 风险升高.
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { eq, sql } from "drizzle-orm";
import { crawlLetpubCategory, type LetpubListItem } from "../services/crawler/scrapling-bridge.js";
import { enrichJournal } from "../services/journal-enricher/orchestrator.js";
import { logger } from "../config/logger.js";

// 学科 code → 中文 label (与 letpub-crawler / journal_scraper 同步)
const DISCIPLINES: Array<{ code: string; label: string }> = [
  { code: "medicine", label: "医学" },
  { code: "biology", label: "生物学" },
  { code: "chemistry", label: "化学" },
  { code: "physics", label: "物理" },
  { code: "materials", label: "材料科学" },
  { code: "engineering", label: "工程技术" },
  { code: "computer", label: "计算机" },
  { code: "energy", label: "能源" },
  { code: "environment", label: "环境科学" },
  { code: "economics", label: "经济管理" },
  { code: "agriculture", label: "农林科学" },
  { code: "psychology", label: "心理学" },
  { code: "education", label: "教育学" },
  { code: "math", label: "数学" },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
  const throttleArg = args.find((a) => a.startsWith("--throttle="))?.split("=")[1];
  const maxPagesArg = args.find((a) => a.startsWith("--max-pages="))?.split("=")[1];
  return {
    enrich: args.includes("--enrich"),
    stealthy: args.includes("--stealthy"),
    only: only && only.length > 0 ? only : null,
    throttle: throttleArg ? parseFloat(throttleArg) : 4,
    maxPages: maxPagesArg ? parseInt(maxPagesArg, 10) : 50,
  };
}

/** 查重: ISSN 优先 (空则 name). 返回已存在的 journal id 或 null */
async function findExisting(item: LetpubListItem): Promise<string | null> {
  if (item.issn) {
    const r = await db.select({ id: journals.id }).from(journals).where(eq(journals.issn, item.issn)).limit(1);
    if (r[0]) return r[0].id;
  }
  // ISSN 空 → 按 name 精确查重 (避免重复入库同名刊)
  const r2 = await db
    .select({ id: journals.id })
    .from(journals)
    .where(sql`LOWER(${journals.name}) = LOWER(${item.name})`)
    .limit(1);
  return r2[0]?.id ?? null;
}

async function main() {
  const opts = parseArgs();
  const disciplines = opts.only
    ? DISCIPLINES.filter((d) => opts.only!.includes(d.code))
    : DISCIPLINES;

  console.log(`[ingest-letpub] 学科 ${disciplines.map((d) => d.code).join(",")} | throttle=${opts.throttle}s | maxPages=${opts.maxPages} | stealthy=${opts.stealthy} | enrich=${opts.enrich}`);

  let totalCrawled = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  const insertedIds: string[] = [];

  for (const disc of disciplines) {
    console.log(`\n[ingest-letpub] === 学科 ${disc.code} (${disc.label}) 开始爬取 ===`);
    const items = await crawlLetpubCategory({
      category: disc.code,
      maxPages: opts.maxPages,
      throttle: opts.throttle,
      stealthy: opts.stealthy,
      timeoutMs: 30 * 60 * 1000, // 30 min/学科 (翻页 + 限速)
    });
    totalCrawled += items.length;
    console.log(`[ingest-letpub] ${disc.code} 爬到 ${items.length} 本, 开始 dedup + 入库`);

    let discInserted = 0;
    for (const item of items) {
      if (!item.name || item.name.length < 2) continue;
      const existing = await findExisting(item);
      if (existing) {
        totalSkipped += 1;
        continue;
      }
      try {
        const [row] = await db
          .insert(journals)
          .values({
            tenantId: null, // 全局共享 reference data
            name: item.name,
            nameEn: item.name,
            issn: item.issn,
            impactFactor: item.impactFactor,
            partition: item.partition,
            isWarningList: item.isWarningList,
            discipline: disc.label,
            source: "letpub-list",
            confidence: 60, // 与 OpenAlex ingest 一致; enrich 后 letpub 命中 +20 → 80
          })
          .returning({ id: journals.id });
        if (row) {
          insertedIds.push(row.id);
          discInserted += 1;
          totalInserted += 1;
        }
      } catch (err) {
        logger.warn({ err: String(err), name: item.name }, "[ingest-letpub] insert 失败");
      }
    }
    console.log(`[ingest-letpub] ${disc.code} 入库 +${discInserted} (跳过已存在累计 ${totalSkipped})`);
  }

  console.log(`\n========== ingest 报告 ==========`);
  console.log(`总爬取:   ${totalCrawled}`);
  console.log(`新入库:   ${totalInserted}`);
  console.log(`跳过已有: ${totalSkipped}`);
  console.log(`==================================`);

  // --enrich: 对新入库期刊跑交叉验证 (慢 + 限速防反爬)
  // PR #260: 强制 skipLetpub — 列表爬刚猛打过 LetPub, enrich 阶段绝不再打 LetPub (反爬铁律: 列表爬与 LetPub-enrich 绝不同进程). 改走 OpenAlex/DOAJ/万方等其他源升分.
  if (opts.enrich && insertedIds.length > 0) {
    console.log(`\n[ingest-letpub] 开始 enrich ${insertedIds.length} 本 (预计 ${Math.ceil(insertedIds.length * 5 / 60)} 分钟)`);
    let enriched = 0;
    let enrichFailed = 0;
    for (let i = 0; i < insertedIds.length; i++) {
      try {
        await enrichJournal(insertedIds[i], { skipLetpub: true });
        enriched += 1;
      } catch (err) {
        enrichFailed += 1;
        logger.warn({ err: String(err), id: insertedIds[i] }, "[ingest-letpub] enrich 失败");
      }
      if ((i + 1) % 50 === 0) console.log(`[ingest-letpub] enrich 进度 ${i + 1}/${insertedIds.length} (成功 ${enriched})`);
      await new Promise((r) => setTimeout(r, 3000)); // 3s 限速防反爬
    }
    console.log(`\n[ingest-letpub] enrich 完成: 成功 ${enriched} / 失败 ${enrichFailed}`);
  } else if (insertedIds.length > 0) {
    console.log(`\n[ingest-letpub] 提示: 新入库 confidence=60 (未达推荐门槛 70). 跑 --enrich 做交叉验证升分.`);
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[ingest-letpub] 致命错误");
  process.exit(1);
});
