/**
 * 5-22 PR #201/#208 — 用 OpenAlex 回填 journals.website + publisher (纯 OpenAlex, 不碰 LetPub).
 *
 * 背景: 部分期刊文章只显示 ISSN, 无官网/无出版社 (website/publisher 字段 NULL)。
 *   OpenAlex 返回的 homepage_url / host_organization_name 是事实型数据 (非算出来的近似 IF),
 *   拿来回填准确、免费、不耗代理。一次 API 调用同时补 website + publisher。
 *   待 LetPub「官方投稿网址」(PR #199) 到位后再用更权威的提交页升级 website。
 *
 * 安全: 只调 OpenAlex API (按 ISSN), 绝不戳 LetPub —— 避免触发封 IP (见 letpub-anti-scrape).
 *   仅回填为 NULL 的字段, 不覆盖手维/已有真值。
 *
 * 用法 (prod):
 *   ssh "$BOSSMATE_DEPLOY_SERVER" 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && node dist/scripts/backfill-website-from-openalex.js'
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, isNull, isNotNull, and, or } from "drizzle-orm";
import { fetchOpenAlexJournal } from "../services/journal-enricher/fetchers/openalex-fetcher.js";
import {
  extractWebsiteFromOpenAlex,
  extractPublisherFromOpenAlex,
} from "../services/journal-enricher/extractors/openalex-extractor.js";
import { logger } from "../config/logger.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 缺 website 或缺 publisher, 且有 ISSN (ISSN 是 OpenAlex 查询键) 的期刊
  const targets = await db
    .select({ id: journals.id, name: journals.name, issn: journals.issn, website: journals.website, publisher: journals.publisher })
    .from(journals)
    .where(and(isNotNull(journals.issn), or(isNull(journals.website), isNull(journals.publisher))));

  console.log(`[backfill-oa] ${targets.length} 本缺官网或出版社且有 ISSN, 走 OpenAlex 回填`);

  let siteFilled = 0;
  let pubFilled = 0;
  let apiMiss = 0;
  for (let i = 0; i < targets.length; i++) {
    const j = targets[i];
    try {
      const source = await fetchOpenAlexJournal(j.issn);
      if (!source) { apiMiss += 1; await sleep(200); continue; }
      const patch: { website?: string; publisher?: string } = {};
      if (!j.website) {
        const site = extractWebsiteFromOpenAlex(source);
        if (site) { patch.website = site; }
      }
      if (!j.publisher) {
        const pub = extractPublisherFromOpenAlex(source);
        if (pub) { patch.publisher = pub; }
      }
      if (Object.keys(patch).length > 0) {
        await db.update(journals).set(patch).where(sql`${journals.id} = ${j.id}`);
        if (patch.website) siteFilled += 1;
        if (patch.publisher) pubFilled += 1;
      }
    } catch (err) {
      logger.warn({ err: String(err), name: j.name }, "[backfill-oa] 处理失败");
    }
    // OpenAlex 免费 API 有日额度 + 礼貌限速; 每本间隔 200ms, 每 200 本打点
    await sleep(200);
    if ((i + 1) % 200 === 0) console.log(`[backfill-oa] 进度 ${i + 1}/${targets.length} (官网 ${siteFilled} / 出版社 ${pubFilled})`);
  }

  // 报告: 当前 website / publisher 覆盖 (conf>=60 可推池)
  const cov = await db.execute(sql`
    SELECT COUNT(*) AS total, COUNT(website) AS has_site, COUNT(publisher) AS has_pub
    FROM journals WHERE confidence >= 60
  `);
  const row = (cov as unknown as { rows: Array<{ total: string; has_site: string; has_pub: string }> }).rows[0];

  console.log(`\n========== backfill-oa 报告 ==========`);
  console.log(`处理:              ${targets.length}`);
  console.log(`新填官网:          ${siteFilled}`);
  console.log(`新填出版社:        ${pubFilled}`);
  console.log(`OpenAlex 查无此刊: ${apiMiss}`);
  console.log(`website 覆盖 (conf>=60):   ${row?.has_site}/${row?.total}`);
  console.log(`publisher 覆盖 (conf>=60): ${row?.has_pub}/${row?.total}`);
  console.log(`======================================`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[backfill-oa] 致命错误");
  process.exit(1);
});
