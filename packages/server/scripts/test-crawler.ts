#!/usr/bin/env npx tsx
/**
 * 爬虫手动测试脚本
 *
 * 用法:
 *   # 测试单个平台
 *   npx tsx scripts/test-crawler.ts --platform baidu
 *   npx tsx scripts/test-crawler.ts --platform springer-link
 *
 *   # 测试某条业务线
 *   npx tsx scripts/test-crawler.ts --track domestic
 *   npx tsx scripts/test-crawler.ts --track sci
 *   npx tsx scripts/test-crawler.ts --track social
 *
 *   # 测试全量
 *   npx tsx scripts/test-crawler.ts --all
 *
 *   # 测试 Springer 月度基础库爬取（小范围）
 *   npx tsx scripts/test-crawler.ts --springer-catalog --max-details 3
 *
 *   # 测试热度×期刊交叉匹配
 *   npx tsx scripts/test-crawler.ts --heat-match --tenant-id <your-tenant-id>
 */

import { config } from "dotenv";
import { resolve } from "path";

// 优先加载项目根目录的 .env（packages/server/../../.env）
config({ path: resolve(process.cwd(), "../../.env") });
// 再加载当前目录的 .env（如果有的话，覆盖）
config();

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

async function main() {
  console.log("🧪 BossMate 爬虫测试工具\n");

  if (hasFlag("--platform")) {
    // 测试单个平台
    const platform = getArg("--platform")!;
    console.log(`▶ 测试单平台: ${platform}`);

    const { crawlPlatform } = await import("../src/services/crawler/index.js");
    const result = await crawlPlatform(platform as any);

    console.log(`\n✅ 平台: ${result.platform}`);
    console.log(`   成功: ${result.success}`);
    console.log(`   关键词数: ${result.keywords.length}`);
    console.log(`   期刊数: ${result.journals.length}`);
    console.log(`   热搜数: ${(result as any).items?.length || 0}`);

    if (result.error) console.log(`   ❌ 错误: ${result.error}`);

    // 打印前 5 条关键词
    if (result.keywords.length > 0) {
      console.log("\n   📊 关键词 TOP 5:");
      for (const kw of result.keywords.slice(0, 5)) {
        console.log(`     - [${kw.discipline}] ${kw.keyword} (热度: ${kw.heatScore})`);
      }
    }

    // 打印前 5 条热搜
    const items = (result as any).items || [];
    if (items.length > 0) {
      console.log("\n   🔥 热搜 TOP 5:");
      for (const item of items.slice(0, 5)) {
        console.log(`     - ${item.keyword} (热度: ${item.heatScore})`);
      }
    }

    // 打印前 5 条期刊
    if (result.journals.length > 0) {
      console.log("\n   📚 期刊 TOP 5:");
      for (const j of result.journals.slice(0, 5)) {
        console.log(`     - ${j.name} IF=${j.impactFactor || "N/A"} ${j.partition || ""}`);
      }
    }

  } else if (hasFlag("--track")) {
    // 测试某条业务线
    const track = getArg("--track")!;
    console.log(`▶ 测试业务线: ${track}`);

    const { crawlByTrack } = await import("../src/services/crawler/index.js");
    const results = await crawlByTrack(track as any);

    console.log(`\n✅ 业务线 ${track} 完成:`);
    for (const r of results) {
      const status = r.success ? "✅" : "❌";
      console.log(`   ${status} ${r.platform}: 关键词=${r.keywords.length} 期刊=${r.journals.length} 热搜=${(r as any).items?.length || 0}`);
      if (r.error) console.log(`      错误: ${r.error}`);
    }

  } else if (hasFlag("--all")) {
    // 测试全量
    console.log("▶ 测试全量抓取（三条线并发）");

    const { crawlAll } = await import("../src/services/crawler/index.js");
    const results = await crawlAll();

    console.log(`\n✅ 全量抓取完成: ${results.length} 个平台`);
    const success = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`   成功: ${success}, 失败: ${failed}`);

    for (const r of results) {
      const status = r.success ? "✅" : "❌";
      console.log(`   ${status} ${r.platform} [${r.track || "?"}]: kw=${r.keywords.length} j=${r.journals.length} items=${(r as any).items?.length || 0}`);
    }

  } else if (hasFlag("--springer-catalog")) {
    // 测试 Springer 月度基础库
    const maxDetails = parseInt(getArg("--max-details") || "3", 10);
    const proxy = getArg("--proxy");
    const subject = getArg("--subject");

    console.log(`▶ 测试 Springer 期刊基础库爬取`);
    console.log(`   学科: ${subject || "ALL"}, max-details: ${maxDetails}, proxy: ${proxy || "无"}`);

    const { SpringerLinkCrawler } = await import("../src/services/crawler/springer-link-crawler.js");
    const crawler = new SpringerLinkCrawler();

    const result = await crawler.crawlJournalCatalog({
      subject,
      proxy,
      maxDetails,
    });

    console.log(`\n✅ Springer 基础库爬取完成:`);
    console.log(`   总数: ${result.total}`);
    console.log(`   写入: ${result.upserted}`);
    console.log(`   错误: ${result.errors}`);

  } else if (hasFlag("--heat-match")) {
    // 测试热度×期刊交叉匹配
    const tenantId = getArg("--tenant-id");

    if (!tenantId) {
      // 自动获取第一个活跃租户
      const { db } = await import("../src/models/db.js");
      const { tenants } = await import("../src/models/schema.js");
      const { eq } = await import("drizzle-orm");
      const list = await db.select().from(tenants).where(eq(tenants.status, "active")).limit(1);

      if (list.length === 0) {
        console.log("❌ 没有活跃租户，请传入 --tenant-id");
        process.exit(1);
      }

      console.log(`▶ 测试热度×期刊匹配 (自动选择租户: ${list[0].id})`);

      const { getTodayHeatMatches } = await import("../src/services/content-engine/journal-heat-matcher.js");
      const matches = await getTodayHeatMatches(list[0].id, 10);

      printMatches(matches);
    } else {
      console.log(`▶ 测试热度×期刊匹配 (tenant: ${tenantId})`);

      const { getTodayHeatMatches } = await import("../src/services/content-engine/journal-heat-matcher.js");
      const matches = await getTodayHeatMatches(tenantId, 10);

      printMatches(matches);
    }

  } else {
    console.log("用法:");
    console.log("  npx tsx scripts/test-crawler.ts --platform <name>       # 测试单平台");
    console.log("  npx tsx scripts/test-crawler.ts --track <domestic|sci|social>  # 测试业务线");
    console.log("  npx tsx scripts/test-crawler.ts --all                   # 全量测试");
    console.log("  npx tsx scripts/test-crawler.ts --springer-catalog      # Springer月度库");
    console.log("  npx tsx scripts/test-crawler.ts --heat-match            # 热度×期刊匹配");
    console.log("");
    console.log("可用平台:");
    console.log("  国内线: baidu-academic, wechat-index, policy-monitor");
    console.log("  SCI线: letpub, openalex, pubmed, arxiv, springer-link");
    console.log("  社交线: baidu, weibo, zhihu, toutiao");
  }

  process.exit(0);
}

function printMatches(matches: any[]) {
  console.log(`\n✅ 匹配结果: ${matches.length} 条`);

  for (const m of matches) {
    console.log(`\n  🔥 ${m.keyword} (热度: ${m.heatScore}, 学科: ${m.discipline})`);
    console.log(`     来源: ${m.platform}, 趋势: ${m.trend}`);

    if (m.articleSuggestion) {
      console.log(`     📝 文章建议: ${m.articleSuggestion}`);
    }

    if (m.matchedJournals?.length > 0) {
      console.log(`     📚 匹配期刊 (${m.matchedJournals.length}):`);
      for (const j of m.matchedJournals) {
        console.log(`        - ${j.journalName} (IF=${j.impactFactor || "N/A"}, 分=${j.matchScore}, 原因: ${j.matchReason})`);
      }
    }
  }
}

main().catch((err) => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
