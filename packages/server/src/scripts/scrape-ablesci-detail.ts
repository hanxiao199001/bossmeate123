/**
 * 5-23 PR #235 — 从 ablesci 详情页一次抓 3 字段: 自引率 + 录用率 + 审稿周期.
 *
 * 背景: 录用率 / 审稿周期 之前覆盖率仅 48/5012 (1.0%, LetPub 老批), 是 5000 池最大短板.
 *   ablesci 详情页 (PR #226 已稳定走) 同时含「平均审稿速度」「平均录用比例」字段.
 *   合并为多字段 scraper, 一次详情页拉 3 字段, 礼貌限速不变(~1.6s/本).
 *
 * 关系: 取代 scrape-ablesci-selfcite.ts (单字段, 保留兼容用法). 探针结果 (PR #235):
 *   - 自引率: 精确数字 ✅
 *   - 审稿周期: 文本如"平均24月" ✅
 *   - 录用率: 模糊词"较易/较难" ⚠️ — 写新列 acceptance_difficulty (varchar 20), 不污染 acceptance_rate (real)
 *
 * 字段写入:
 *   - 自引率: 同 PR #226 parser, 0-1 ratio 写入 (用 field_provenance.selfCitationRate=ablesci)
 *   - 录用率: parse "录用比例/录用率: X%" → 0-1 ratio (acceptance_rate real 列)
 *   - 审稿周期: parse "审稿速度/审稿周期: 平均 X 月/周/天" → 原文文本 (review_cycle varchar)
 *
 * 安全/边界:
 *   - 录用率 > 100 / < 0 / NaN → null
 *   - 审稿周期 文本截 ≤ 50 字符 (varchar 列宽)
 *   - field_provenance 标 ablesci, 不覆盖 manual / letpub 真值 (provenance gate)
 *
 * 探针模式:
 *   --probe --issn=1743-0003  → 拉一本, 打印详情页关键文本片段 + 三字段匹配结果, 不入库.
 *
 * 用法 (prod):
 *   探针 (单本验证字段命中):  node dist/scripts/scrape-ablesci-detail.js --probe --issn=1743-0003
 *   调试 1 本入库:           node dist/scripts/scrape-ablesci-detail.js --debug --limit 1
 *   小批 20 本:               node dist/scripts/scrape-ablesci-detail.js --limit 20
 *   全量(后台):              nohup node dist/scripts/scrape-ablesci-detail.js > /tmp/ablesci-detail.log 2>&1 &
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
const PROBE = process.argv.includes("--probe");

async function fetchHtml(path: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s 超时
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        "user-agent": UA,
        "accept-language": "zh-CN,zh;q=0.9",
        referer: `${BASE}/journal`,
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

/** 搜索结果页 → 含 ISSN 那行的详情 id */
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
  // 兜底: 整页第一个详情 link
  if (!id) {
    const href = $('a[href*="/journal/detail?id="]').first().attr("href") || "";
    const m = href.match(/[?&]id=([^&"#]+)/);
    if (m) id = m[1];
  }
  return id;
}

/** 详情页 → 自引率 (0-1 ratio, 同 PR #226) */
function parseSelfCitation(text: string): number | null {
  const m = text.match(/自引率[\s:：]*([0-9]+\.?[0-9]*)\s*%/);
  if (!m) return null;
  const pct = parseFloat(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return pct / 100;
}

/** 详情页 → 录用率精确百分比 (0-1 ratio). 大多 ablesci 刊给不出, 见 parseAcceptanceDifficulty 兜底. */
function parseAcceptanceRate(text: string): number | null {
  const m = text.match(/(?:录用比例|录用率|接受率|接受比例)[\s:：]*[约也]?[\s]*([0-9]+\.?[0-9]*)\s*%/);
  if (!m) return null;
  const pct = parseFloat(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return pct / 100;
}

/** 详情页 → 投稿难度模糊词 (容易/较易/中等/较难/困难).
 *  PR #235: ablesci 不给精确数, 但给"较易/较难"等定性词, 仍对学者有价值.
 *  返回标准化 5 档之一, 或 null.
 */
function parseAcceptanceDifficulty(text: string): string | null {
  // 抓"录用比例/录用率/投稿难度/录用难度: <词>", 词可能是 容易/较易/中等/较难/困难/极难
  const m = text.match(/(?:录用比例|录用率|接受率|接受比例|投稿难度|录用难度)[\s:：]*([极]?[容较中]?[易难等中容])/);
  if (!m) return null;
  const raw = m[1].trim();
  // 标准化到 5 档 (含极难)
  const map: Record<string, string> = {
    "易": "容易", "容易": "容易",
    "较易": "较易",
    "中": "中等", "中等": "中等",
    "较难": "较难",
    "难": "困难", "困难": "困难", "极难": "极难",
  };
  return map[raw] || raw.slice(0, 20);
}

/** 详情页 → 审稿周期 (原文短文本, 截 ≤ 48 字符).
 *  常见: "平均审稿速度: 平均 3 月" / "审稿周期: 6-8 周" / "审稿速度: 4.0 月".
 *  返回 null = 字段缺失或不可读.
 */
function parseReviewCycle(text: string): string | null {
  // 匹配字段名后到下个字段标志(中文冒号或换行)前的文本
  const m = text.match(/(?:平均审稿速度|审稿速度|审稿周期|审稿时长)[\s:：]+([^\n。;；]+?)(?=\s{2,}|平均录用|录用比例|录用率|接受率|$)/);
  if (!m) return null;
  let v = m[1].trim().replace(/\s+/g, " ");
  // 去前缀冗余: "平均 3 月" 保留; "约 6 周" 保留; 但 ablesci 偶尔带 HTML 标签碎屑
  v = v.replace(/<[^>]+>/g, "").trim();
  if (!v) return null;
  if (v.length > 48) v = v.slice(0, 48);
  // 必须含 月/周/天/年/month/week/day, 否则可能误抓
  if (!/月|周|天|年|month|week|day/i.test(v)) return null;
  return v;
}

async function fetchDetailByIssn(issn: string): Promise<{ id: string; html: string } | null> {
  const searchHtml = await fetchHtml(`/journal/index?keywords=${encodeURIComponent(issn)}`);
  const id = parseDetailId(searchHtml, issn);
  if (!id) return null;
  await sleep(800);
  const detailHtml = await fetchHtml(`/journal/detail?id=${encodeURIComponent(id)}`);
  return { id, html: detailHtml };
}

async function probeOne(issn: string): Promise<void> {
  console.log(`[probe] 拉 ablesci 详情 issn=${issn} ...`);
  const r = await fetchDetailByIssn(issn);
  if (!r) {
    console.log(`[probe] 搜索未命中 ISSN=${issn}`);
    return;
  }
  const $ = cheerio.load(r.html);
  const text = $.text().replace(/\s+/g, " ");
  // 三字段匹配结果
  const sc = parseSelfCitation(text);
  const ar = parseAcceptanceRate(text);
  const ad = parseAcceptanceDifficulty(text);
  const rc = parseReviewCycle(text);
  console.log(`[probe] detailId=${r.id}`);
  console.log(`[probe] 自引率: ${sc != null ? (sc * 100).toFixed(2) + "% (ratio=" + sc + ")" : "(未抓到)"}`);
  console.log(`[probe] 录用率(精确): ${ar != null ? (ar * 100).toFixed(2) + "% (ratio=" + ar + ")" : "(未抓到)"}`);
  console.log(`[probe] 投稿难度(模糊): ${ad != null ? `"${ad}"` : "(未抓到)"}`);
  console.log(`[probe] 审稿周期: ${rc != null ? `"${rc}"` : "(未抓到)"}`);
  // dump 三字段周围上下文 (前后 50 字), 方便我调整 parser
  for (const key of ["自引率", "录用比例", "录用率", "审稿速度", "审稿周期"]) {
    const i = text.indexOf(key);
    if (i >= 0) {
      const snippet = text.slice(Math.max(0, i - 10), Math.min(text.length, i + 80));
      console.log(`[probe] [${key}] 上下文: ${snippet}`);
    } else {
      console.log(`[probe] [${key}] 未出现`);
    }
  }
}

async function main() {
  // 探针模式: 不入库, 验证 parser
  if (PROBE) {
    const issnIdx = process.argv.indexOf("--issn");
    const issn = issnIdx >= 0 ? process.argv[issnIdx + 1] : "1743-0003";
    await probeOne(issn);
    process.exit(0);
  }

  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : 0;

  // Step 0: 清除非 ablesci 来源的 acceptance_rate / review_cycle 旧值 (LetPub 老批 48 本是真值, 跳过).
  //   策略: 只清 field_provenance 中标记为非 ablesci/非 letpub/非 manual 的; 未来如要全清, 增 flag.
  //   为简化, 只清"无 provenance 记录"的(老旧脏数据), letpub/manual 标记的保留.
  console.log("[ablesci-detail] 清除无 provenance 的 acceptance/review (保 letpub/manual 真值) ...");
  await db.execute(sql`
    UPDATE journals SET acceptance_rate = NULL
    WHERE acceptance_rate IS NOT NULL
      AND (field_provenance IS NULL OR field_provenance->>'acceptanceRate' IS NULL);
  `);
  await db.execute(sql`
    UPDATE journals SET review_cycle = NULL
    WHERE review_cycle IS NOT NULL
      AND (field_provenance IS NULL OR field_provenance->>'reviewCycle' IS NULL);
  `);
  // PR #235: acceptance_difficulty 新列, 第一次跑无需清 (列为空); 仅保持 idempotent.
  await db.execute(sql`
    UPDATE journals SET acceptance_difficulty = NULL
    WHERE acceptance_difficulty IS NOT NULL
      AND (field_provenance IS NULL OR field_provenance->>'acceptanceDifficulty' IS NULL);
  `);

  let targets = await db
    .select({
      id: journals.id,
      name: journals.name,
      issn: journals.issn,
      selfCitationRate: journals.selfCitationRate,
      acceptanceRate: journals.acceptanceRate,
      acceptanceDifficulty: journals.acceptanceDifficulty,
      reviewCycle: journals.reviewCycle,
      fieldProvenance: journals.fieldProvenance,
    })
    .from(journals)
    .where(isNotNull(journals.issn));
  if (limit > 0) targets = targets.slice(0, limit);

  console.log(`[ablesci-detail] 待抓 ${targets.length} 本 (按 ISSN), DEBUG=${DEBUG}`);

  let updated = 0;
  let scFilled = 0;
  let arFilled = 0;
  let adFilled = 0;
  let rcFilled = 0;
  let noHit = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i++) {
    const j = targets[i];
    const issn = (j.issn || "").trim();
    if (!issn) { noHit += 1; continue; }
    try {
      const r = await fetchDetailByIssn(issn);
      if (!r) {
        noHit += 1;
        if (DEBUG) console.log(`[ablesci-detail][debug] ${issn} ${j.name} → 搜索未命中`);
      } else {
        const $ = cheerio.load(r.html);
        const text = $.text().replace(/\s+/g, " ");
        const sc = parseSelfCitation(text);
        const ar = parseAcceptanceRate(text);
        const ad = parseAcceptanceDifficulty(text);
        const rc = parseReviewCycle(text);

        if (DEBUG) {
          console.log(`[ablesci-detail][debug] ${issn} ${j.name}: sc=${sc != null ? (sc * 100).toFixed(2) + "%" : "(无)"} ar=${ar != null ? (ar * 100).toFixed(2) + "%" : "(无)"} ad=${ad != null ? `"${ad}"` : "(无)"} rc=${rc != null ? `"${rc}"` : "(无)"}`);
        }

        const prov = j.fieldProvenance as { selfCitationRate?: string; acceptanceRate?: string; acceptanceDifficulty?: string; reviewCycle?: string } | null;
        let anyWrite = false;

        // 自引率: 同 PR #226 策略 (覆盖非 ablesci/非 manual)
        if (sc != null && (!prov?.selfCitationRate || prov.selfCitationRate === "openalex" || prov.selfCitationRate === "letpub")) {
          await db.update(journals).set({
            selfCitationRate: sc,
            fieldProvenance: sql`COALESCE(${journals.fieldProvenance}, '{}'::jsonb) || '{"selfCitationRate":"ablesci"}'::jsonb`,
          }).where(sql`${journals.id} = ${j.id}`);
          scFilled += 1; anyWrite = true;
        }
        // 录用率: 不覆盖 manual / letpub 真值 (这两源是历史唯一 48 本真数据)
        if (ar != null && (!prov?.acceptanceRate || prov.acceptanceRate === "openalex")) {
          await db.update(journals).set({
            acceptanceRate: ar,
            fieldProvenance: sql`COALESCE(${journals.fieldProvenance}, '{}'::jsonb) || '{"acceptanceRate":"ablesci"}'::jsonb`,
          }).where(sql`${journals.id} = ${j.id}`);
          arFilled += 1; anyWrite = true;
        }
        // PR #235: 投稿难度模糊词 (ablesci 主路径; 不覆盖 manual/letpub)
        if (ad != null && (!prov?.acceptanceDifficulty || prov.acceptanceDifficulty === "openalex")) {
          await db.update(journals).set({
            acceptanceDifficulty: ad,
            fieldProvenance: sql`COALESCE(${journals.fieldProvenance}, '{}'::jsonb) || '{"acceptanceDifficulty":"ablesci"}'::jsonb`,
          }).where(sql`${journals.id} = ${j.id}`);
          adFilled += 1; anyWrite = true;
        }
        // 审稿周期: 同上, 不覆盖 manual/letpub
        if (rc != null && (!prov?.reviewCycle || prov.reviewCycle === "openalex")) {
          await db.update(journals).set({
            reviewCycle: rc,
            fieldProvenance: sql`COALESCE(${journals.fieldProvenance}, '{}'::jsonb) || '{"reviewCycle":"ablesci"}'::jsonb`,
          }).where(sql`${journals.id} = ${j.id}`);
          rcFilled += 1; anyWrite = true;
        }

        if (anyWrite) updated += 1; else noHit += 1;
      }
    } catch (err) {
      errors += 1;
      logger.warn({ err: String(err), issn, name: j.name }, "[ablesci-detail] 抓取失败");
      await sleep(2500);
    }
    await sleep(800);
    if ((i + 1) % 100 === 0) console.log(`[ablesci-detail] 进度 ${i + 1}/${targets.length} (写入 ${updated}, 自引${scFilled}/录用${arFilled}/难度${adFilled}/审稿${rcFilled}, 未命中 ${noHit}, 错 ${errors})`);
  }

  console.log(`\n========== ablesci 详情多字段抓取报告 ==========`);
  console.log(`处理:            ${targets.length}`);
  console.log(`至少一字段写入:  ${updated}`);
  console.log(`  - 自引率:      ${scFilled}`);
  console.log(`  - 录用率精确:  ${arFilled}`);
  console.log(`  - 投稿难度:    ${adFilled}`);
  console.log(`  - 审稿周期:    ${rcFilled}`);
  console.log(`未命中:          ${noHit}`);
  console.log(`错误:            ${errors}`);
  console.log(`===============================================`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[ablesci-detail] 致命错误");
  process.exit(1);
});
