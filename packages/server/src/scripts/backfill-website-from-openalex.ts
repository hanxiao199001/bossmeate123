/**
 * 5-22 PR #201 — 用 OpenAlex homepage_url 回填 journals.website (纯 OpenAlex, 不碰 LetPub).
 *
 * 背景: 新扩的 5000 本 LetPub 池 website 字段多为 NULL, 导致 shunshi 模板"官网"行被藏掉,
 *   文章里看不到官网链接。OpenAlex 返回的 homepage_url 是事实型 URL (非算出来的近似 IF),
 *   拿来回填准确、免费、不耗代理。待 LetPub「官方投稿网址」(PR #199) 到位后再升级。
 *
 * 安全: 只调 OpenAlex API (按 ISSN), 绝不戳 LetPub —— 避免触发封 IP (见 letpub-anti-scrape).
 *   仅回填 website 为 NULL 的期刊, 不覆盖手维/已有真值。
 *
 * 用法 (prod):
 *   ssh ubuntu@122.152.234.155 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && node dist/scripts/backfill-website-from-openalex.js'
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, isNull, isNotNull, and } from "drizzle-orm";
import { fetchOpenAlexJournal } from "../services/journal-enricher/fetchers/openalex-fetcher.js";
import { extractWebsiteFromOpenAlex } from "../services/journal-enricher/extractors/openalex-extractor.js";
import { logger } from "../config/logger.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 只补 website 为 NULL 且有 ISSN 的 (ISSN 是 OpenAlex 查询键)
  const targets = await db
    .select({ id: journals.id, name: journals.name, issn: journals.issn })
    .from(journals)
    .where(and(isNull(journals.website), isNotNull(journals.issn)));

  console.log(`[backfill-website] ${targets.length} 本缺官网且有 ISSN, 走 OpenAlex homepage_url 回填`);

  let updated = 0;
  let noHomepage = 0;
  let apiMiss = 0;
  for (let i = 0; i < targets.length; i++) {
    const j = targets[i];
    try {
      const source = await fetchOpenAlexJournal(j.issn);
      if (!source) { apiMiss += 1; continue; }
      const site = extractWebsiteFromOpenAlex(source);
      if (!site) { noHomepage += 1; continue; }
      await db.update(journals).set({ website: site }).where(sql`${journals.id} = ${j.id}`);
      updated += 1;
    } catch (err) {
      logger.warn({ err: String(err), name: j.name }, "[backfill-website] 处理失败");
    }
    // OpenAlex 免费 API 有日额度 + 礼貌限速; 每本间隔 200ms, 每 200 本打点
    await sleep(200);
    if ((i + 1) % 200 === 0) console.log(`[backfill-website] 进度 ${i + 1}/${targets.length} (已填 ${updated})`);
  }

  // 报告: 当前 website 覆盖 (SCI 可推池)
  const cov = await db.execute(sql`
    SELECT COUNT(*) AS total, COUNT(website) AS has_site
    FROM journals WHERE confidence >= 60
  `);
  const row = (cov as unknown as { rows: Array<{ total: string; has_site: string }> }).rows[0];

  console.log(`\n========== backfill-website 报告 ==========`);
  console.log(`处理:            ${targets.length}`);
  console.log(`成功填官网:      ${updated}`);
  console.log(`OpenAlex 无 homepage: ${noHomepage}`);
  console.log(`OpenAlex 查无此刊:  ${apiMiss}`);
  console.log(`当前 website 覆盖 (conf>=60): ${row?.has_site}/${row?.total}`);
  console.log(`==========================================`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[backfill-website] 致命错误");
  process.exit(1);
});
