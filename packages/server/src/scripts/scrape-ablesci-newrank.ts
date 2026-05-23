/**
 * 5-22 PR #217 — 从 ablesci 抓「新锐分区」(中科院2025新锐, casPartitionNew), 按 ISSN.
 *
 * 背景: ②运营反馈"新锐分区缺失/错误"。jcarindex 无新锐字段, LetPub 反爬重。ablesci 搜索结果页
 *   (服务端 HTML) 直接带「2025年新锐分区(大类/小类)」, 支持按 ISSN 精确搜:
 *     GET https://www.ablesci.com/journal/index?keywords=<ISSN>
 *   ACS Nano(1936-0851) → 大类 "1区材料科学"。用 cheerio 解析大类写 casPartitionNew。
 *
 * 用法 (prod):
 *   调试单本(看解析对不对): node dist/scripts/scrape-ablesci-newrank.js --debug --limit 1
 *   小批:                    node dist/scripts/scrape-ablesci-newrank.js --limit 20
 *   全量:                    node dist/scripts/scrape-ablesci-newrank.js
 *
 * 礼貌: ablesci 是非营利站, 限速 ≥1000ms/本, 错峰, 不并发。
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, isNotNull } from "drizzle-orm";
import * as cheerio from "cheerio";
import { logger } from "../config/logger.js";

const BASE = "https://www.ablesci.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEBUG = process.argv.includes("--debug");

/**
 * 解析 ablesci 搜索结果页, 取匹配 ISSN 那行的「新锐分区 大类」(如 "1区材料科学")。
 * 返回 null = 未命中 / 无新锐分区。
 */
function parseNewRank(html: string, issn: string): string | null {
  const $ = cheerio.load(html);
  let result: string | null = null;
  $("table tr").each((_i, tr) => {
    if (result) return;
    const tds = $(tr).find("td");
    if (tds.length < 4) return;
    // 找含本 ISSN 的行
    const rowText = $(tr).text().replace(/\s+/g, " ");
    if (!rowText.includes(issn)) return;
    // 逐 td 找「大类」: 形如 "\d区<中文学科>" 且不是 JCR(Q1)/影响因子
    const cellTexts = tds.map((_j, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (DEBUG) console.log(`[ablesci][debug] ${issn} 行单元格:`, JSON.stringify(cellTexts));
    for (const t of cellTexts) {
      // 去所有空白(大类 cell 内 span"1区"与学科文本间有空白) → "1区材料科学"
      const tNo = t.replace(/\s+/g, "");
      // 大类: 单个 "N区学科名"(锚定整串 → 排除 小类多段/JCR Q1/IF 差值)
      const m = tNo.match(/^(\d+)区([一-龥·：]{2,})$/);
      if (m) { result = tNo; break; }
    }
  });
  return result;
}

async function fetchNewRank(issn: string): Promise<string | null> {
  const url = `${BASE}/journal/index?keywords=${encodeURIComponent(issn)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept-language": "zh-CN,zh;q=0.9",
      referer: `${BASE}/journal`,
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return parseNewRank(html, issn.trim());
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : 0;

  let targets = await db
    .select({ id: journals.id, name: journals.name, issn: journals.issn })
    .from(journals)
    .where(isNotNull(journals.issn));
  if (limit > 0) targets = targets.slice(0, limit);

  console.log(`[ablesci] 待抓新锐分区 ${targets.length} 本 (按 ISSN)${DEBUG ? " [DEBUG]" : ""}`);

  let updated = 0;
  let noRank = 0;
  let errors = 0;
  for (let i = 0; i < targets.length; i++) {
    const j = targets[i];
    const issn = (j.issn || "").trim();
    if (!issn) { noRank += 1; continue; }
    try {
      const newRank = await fetchNewRank(issn);
      if (DEBUG) console.log(`[ablesci][debug] ${issn} ${j.name} → 新锐大类: ${newRank ?? "(无)"}`);
      if (newRank) {
        // ablesci 为新锐分区权威源 → 覆盖修正(以 ablesci 为准, 解决"信息错误")
        await db.update(journals).set({
          casPartitionNew: newRank,
          fieldProvenance: sql`COALESCE(${journals.fieldProvenance}, '{}'::jsonb) || '{"casPartitionNew":"ablesci"}'::jsonb`,
        }).where(sql`${journals.id} = ${j.id}`);
        updated += 1;
      } else { noRank += 1; }
    } catch (err) {
      errors += 1;
      logger.warn({ err: String(err), issn, name: j.name }, "[ablesci] 抓取失败");
      await sleep(2500);
    }
    await sleep(1000); // 礼貌限速 ≥1s/本
    if ((i + 1) % 100 === 0) console.log(`[ablesci] 进度 ${i + 1}/${targets.length} (新锐已填 ${updated}, 无 ${noRank}, 错 ${errors})`);
  }

  console.log(`\n========== ablesci 新锐分区报告 ==========`);
  console.log(`处理:          ${targets.length}`);
  console.log(`新锐分区写入:  ${updated}`);
  console.log(`无新锐/未命中: ${noRank}`);
  console.log(`错误:          ${errors}`);
  console.log(`==========================================`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[ablesci] 致命错误");
  process.exit(1);
});
