/**
 * 5-20 PR #184 — 期刊封面 backfill (运营反馈: 部分期刊无封面, 文章只剩纯背景).
 *
 * 用法 (prod):
 *   ssh "$BOSSMATE_DEPLOY_SERVER" 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/backfill-covers.js'
 *
 * 行为:
 *   1. SELECT 所有 cover_url_hd IS NULL 的 journal (高清封面缺失)
 *   2. 顺序调 getJournalCover — 内部走 Springer CDN / ISSN 探测 / LetPub fallback,
 *      命中会自动 cacheHdCover 写回 cover_url_hd + springer_journal_id
 *   3. 每次间隔 1.5s 避免被 ban
 *   4. 跑完 print 报告: 总数 / 成功(拿到 HD) / 仅 LetPub / 全失败
 *
 * 注意: 渲染层 (shunshi-style-template renderHeroBlock) 已加无封面占位卡兜底,
 *       此脚本是"尽力补真封面", 补不到的期刊也不会再显示空白纯背景.
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { isNull, eq } from "drizzle-orm";
import { getJournalCover } from "../services/crawler/cover-fetcher.js";
import { logger } from "../config/logger.js";

const THROTTLE_MS = 1500;

async function main() {
  const targets = await db
    .select({
      id: journals.id,
      name: journals.name,
      nameEn: journals.nameEn,
      issn: journals.issn,
      publisher: journals.publisher,
      coverUrl: journals.coverImageUrl,
      coverUrlHd: journals.coverUrlHd,
      springerJournalId: journals.springerJournalId,
    })
    .from(journals)
    .where(isNull(journals.coverUrlHd));

  console.log(`[backfill-covers] ${targets.length} journal 无高清封面, 开始 (预计 ${Math.ceil(targets.length * (THROTTLE_MS + 1500) / 60000)} 分钟)`);

  let gotHd = 0;
  let onlyLetpub = 0;
  let failed = 0;
  const failedNames: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const j = targets[i];
    try {
      const res = await getJournalCover({
        id: j.id,
        coverUrl: j.coverUrl,
        coverUrlHd: j.coverUrlHd,
        springerJournalId: j.springerJournalId,
        issn: j.issn,
        publisher: j.publisher,
      });
      if (res.isHd && res.url) {
        gotHd += 1;
      } else if (res.url) {
        onlyLetpub += 1;
        // 仅 LetPub 100px — 也写回 cover_image_url 兜底 (若原本为空)
        if (!j.coverUrl) {
          await db.update(journals).set({ coverImageUrl: res.url }).where(eq(journals.id, j.id));
        }
      } else {
        failed += 1;
        failedNames.push(j.nameEn || j.name);
      }
    } catch (err) {
      failed += 1;
      failedNames.push(j.nameEn || j.name);
      logger.warn({ err, journal: j.name }, "[backfill-covers] 单期刊抓取失败");
    }
    if ((i + 1) % 50 === 0) {
      console.log(`[backfill-covers] 进度 ${i + 1}/${targets.length} — HD ${gotHd} / LetPub ${onlyLetpub} / 失败 ${failed}`);
    }
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  console.log("\n========== backfill-covers 报告 ==========");
  console.log(`总处理:     ${targets.length}`);
  console.log(`拿到高清:   ${gotHd}`);
  console.log(`仅 LetPub:  ${onlyLetpub}`);
  console.log(`全失败:     ${failed}`);
  if (failedNames.length > 0) {
    console.log(`失败期刊 (前 30): ${failedNames.slice(0, 30).join(", ")}`);
  }
  console.log("==========================================");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[backfill-covers] 致命错误");
  process.exit(1);
});
