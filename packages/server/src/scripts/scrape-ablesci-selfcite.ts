/**
 * 5-23 PR #226 — 从 ablesci 详情页抓「自引率」(替代旧 OpenAlex 不准值, PR #206 已止血).
 *
 * 背景: 老韩反馈"所有新文章没看见自引率"。PR #206 止血掉 OpenAlex 算的自引率(实测偏差 2-7pt)。
 *   ablesci 详情页 (/journal/detail?id=) 含真实自引率(如"自引率 3.80%"), 是权威源。
 *
 * 流程: 按 ISSN 搜 /journal/index?keywords=<ISSN> → 解析详情 id → 拉 /journal/detail?id=<id>
 *   → regex 抠 "自引率 X.XX%" → 写 selfCitationRate(0-1 ratio) + field_provenance.selfCitationRate=ablesci.
 *
 * 安全: 开跑前先把非 ablesci 来源的 selfCitationRate 清 NULL (旧 OpenAlex 值已知不准)。
 *   清完后任何非 null selfCitationRate 都来自 ablesci, 显示侧可放心渲染。
 *
 * 礼貌: 每本 2 个请求 (搜索 + 详情), 各 800ms 间隔, 总 ~1.6s/本; 5012 本 ≈ 2.2 小时。错误退避 2.5s。
 *
 * 用法 (prod):
 *   清除旧值 + 调试单本:  node dist/scripts/scrape-ablesci-selfcite.js --debug --limit 1
 *   小批 20 本:             node dist/scripts/scrape-ablesci-selfcite.js --limit 20
 *   全量(后台):            nohup node dist/scripts/scrape-ablesci-selfcite.js > /tmp/ablesci-sc.log 2>&1 &
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

async function fetchHtml(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "user-agent": UA,
      "accept-language": "zh-CN,zh;q=0.9",
      referer: `${BASE}/journal`,
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 搜索结果页 → 含 ISSN 那行的详情 id (a[href*="/journal/detail?id="]) */
function parseDetailId(html: string, issn: string): string | null {
  const $ = cheerio.load(html);
  let id: string | null = null;
  $("table tr").each((_i, tr) => {
    if (id) return;
    const rowText = $(tr).text().replace(/\s+/g, " ");
    if (!rowText.includes(issn)) return;
    const href = $(tr).find('a[href*="/journal/detail?id="]').first().attr("href") || "";
    const m = href.match(/[?&]id=([^&"#]+)/);
    if (m) id = m[1];
  });
  return id;
}

/** 详情页 → 自引率 (返回 0-1 ratio, 如 0.038; 缺失返 null) */
function parseSelfCitation(html: string): number | null {
  // 详情页 HTML 含 "自引率 X.XX%" (cell 间可能有空白/tag), 去 tag 后 regex 抠。
  const $ = cheerio.load(html);
  const text = $.text().replace(/\s+/g, " ");
  const m = text.match(/自引率[\s:：]*([0-9]+\.?[0-9]*)\s*%/);
  if (!m) return null;
  const pct = parseFloat(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return pct / 100; // 3.80% → 0.038
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : 0;

  // Step 0: 清掉非 ablesci 来源的旧值 (PR #206 已知 OpenAlex 不准)
  console.log("[ablesci-sc] 清除非 ablesci 来源的旧 selfCitationRate ...");
  const cleared = await db.execute(sql`
    UPDATE journals
    SET self_citation_rate = NULL,
        field_provenance = COALESCE(field_provenance, '{}'::jsonb) - 'selfCitationRate'
    WHERE self_citation_rate IS NOT NULL
      AND (field_provenance->>'selfCitationRate' IS DISTINCT FROM 'ablesci')
  `);
  console.log(`[ablesci-sc] 清除完成: 影响行 ${(cleared as { rowCount?: number }).rowCount ?? "?"}`);

  let targets = await db
    .select({ id: journals.id, name: journals.name, issn: journals.issn })
    .from(journals)
    .where(isNotNull(journals.issn));
  if (limit > 0) targets = targets.slice(0, limit);

  console.log(`[ablesci-sc] 待抓自引率 ${targets.length} 本 (按 ISSN)${DEBUG ? " [DEBUG]" : ""}`);

  let updated = 0;
  let noHit = 0;
  let errors = 0;
  for (let i = 0; i < targets.length; i++) {
    const j = targets[i];
    const issn = (j.issn || "").trim();
    if (!issn) { noHit += 1; continue; }
    try {
      const searchHtml = await fetchHtml(`/journal/index?keywords=${encodeURIComponent(issn)}`);
      const detailId = parseDetailId(searchHtml, issn);
      if (!detailId) {
        if (DEBUG) console.log(`[ablesci-sc][debug] ${issn} ${j.name} → 未命中详情 id`);
        noHit += 1;
        await sleep(800);
        continue;
      }
      await sleep(800); // 搜索 → 详情 之间间隔
      const detailHtml = await fetchHtml(`/journal/detail?id=${detailId}`);
      const ratio = parseSelfCitation(detailHtml);
      if (DEBUG) console.log(`[ablesci-sc][debug] ${issn} ${j.name} → id=${detailId}, 自引率=${ratio != null ? (ratio * 100).toFixed(2) + "%" : "(无)"}`);
      if (ratio == null) { noHit += 1; }
      else {
        await db.update(journals).set({
          selfCitationRate: ratio,
          fieldProvenance: sql`COALESCE(${journals.fieldProvenance}, '{}'::jsonb) || '{"selfCitationRate":"ablesci"}'::jsonb`,
        }).where(sql`${journals.id} = ${j.id}`);
        updated += 1;
      }
    } catch (err) {
      errors += 1;
      logger.warn({ err: String(err), issn, name: j.name }, "[ablesci-sc] 抓取失败");
      await sleep(2500);
    }
    await sleep(800); // 礼貌限速
    if ((i + 1) % 100 === 0) console.log(`[ablesci-sc] 进度 ${i + 1}/${targets.length} (自引率已填 ${updated}, 未命中 ${noHit}, 错 ${errors})`);
  }

  console.log(`\n========== ablesci 自引率报告 ==========`);
  console.log(`处理:        ${targets.length}`);
  console.log(`自引率写入:  ${updated}`);
  console.log(`未命中:      ${noHit}`);
  console.log(`错误:        ${errors}`);
  console.log(`======================================`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[ablesci-sc] 致命错误");
  process.exit(1);
});
