/**
 * PR Q.1 CLI：批量抓 10 个公众号近 N 月文章 → embed → 入 LanceDB industry_sample 仓。
 *
 * 用法：
 *   pnpm tsx packages/server/scripts/ingest-industry-samples.ts \
 *     --tenant=80c42d60-83e9-4f32-8596-d96171c4b2a5 \
 *     --accounts="丁香园,医学界,..." \
 *     --max-per-account=20
 *
 * style_tag 自动按内置 mapping 标签（5-6 早班 user 给清单时打的标签）：
 */
import { crawlWechatAccount } from "../src/services/crawler/wechat-batch-crawler.js";
import { createEntry } from "../src/services/knowledge/knowledge-service.js";
import { logger } from "../src/config/logger.js";

const STYLE_MAPPING: Record<string, "popular_science" | "academic_deep" | "marketing" | "vertical"> = {
  "丁香园": "popular_science",
  "医学界": "popular_science",
  "检索词条": "academic_deep",
  "科研圈": "academic_deep",
  "知识分子": "academic_deep",
  "SCI 投稿那些事": "marketing",
  "运营研究社": "marketing",
  "医脉通": "vertical",
  "学术头条": "vertical",
  "生物医学论坛": "vertical",
};

function parseArg(argv: string[], key: string): string | undefined {
  const arg = argv.find((a) => a.startsWith(`--${key}=`));
  return arg ? arg.split("=").slice(1).join("=") : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const tenantId = parseArg(argv, "tenant");
  const accountsRaw = parseArg(argv, "accounts");
  const maxPer = parseInt(parseArg(argv, "max-per-account") ?? "20", 10);

  if (!tenantId || !accountsRaw) {
    console.error("Usage: --tenant=<uuid> --accounts=\"name1,name2,...\" [--max-per-account=20]");
    process.exit(1);
  }
  const accounts = accountsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  logger.info({ tenantId, accountCount: accounts.length, maxPer }, "Q.1 ingest 启动");

  const summary: Record<string, { crawled: number; ingested: number; errors: number }> = {};

  for (const account of accounts) {
    summary[account] = { crawled: 0, ingested: 0, errors: 0 };
    const styleTag = STYLE_MAPPING[account] ?? "vertical";
    logger.info({ account, styleTag }, "Q.1 抓取开始");
    let articles: Awaited<ReturnType<typeof crawlWechatAccount>> = [];
    try {
      articles = await crawlWechatAccount(account, { maxArticles: maxPer });
      summary[account].crawled = articles.length;
    } catch (err) {
      logger.error({ account, err }, "Q.1 抓取失败");
      summary[account].errors += 1;
      continue;
    }
    for (const a of articles) {
      try {
        await createEntry({
          tenantId,
          category: "industry_sample",
          title: a.title,
          content: a.body,
          source: a.url,
          metadata: {
            sourceAccount: a.account,
            styleTag,
            publishedAt: a.publishedAt?.toISOString() ?? null,
            readCount: a.readCount,
          },
        });
        summary[account].ingested += 1;
      } catch (err) {
        logger.warn({ account, title: a.title, err: err instanceof Error ? err.message : err }, "Q.1 入库失败");
        summary[account].errors += 1;
      }
    }
    logger.info({ account, ...summary[account] }, "Q.1 该账号完成");
  }

  console.log("\n=== Q.1 ingest 报告 ===");
  for (const [account, stats] of Object.entries(summary)) {
    console.log(`${account}: crawled=${stats.crawled} ingested=${stats.ingested} errors=${stats.errors}`);
  }
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "Q.1 ingest 顶层异常");
  process.exit(1);
});
