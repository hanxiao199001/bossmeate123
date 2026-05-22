/**
 * 5-22 PR #212 — 从 jcarindex 抓权威 CAR(国人占比指数)+ 风险等级, 按 ISSN 写 car_index_history.
 *
 * 背景: CAR/自引率之前用 OpenAlex 算, 偏差大已止血(PR #196/#206/#210)。jcarindex
 *   (Academic Integrity Risk Index) 是专做期刊风险评估的库, 抓包确认其公开接口
 *   /ifs/public/jcar/getJournalList?issn= 直接返回真实 CAR:
 *     carIndex / carIndexLastYear / carIndexBeforeLastYear / carIndexGrowthRate
 *     + sciRiskRank(低/中/高) + 当年/去年问题文章数。
 *
 * 反爬: 公开接口(tk 空, 不需登录), 之前直连吃 403 是因为缺 referer+UA。
 *   本脚本: 先 GET 首页拿 JSESSIONID, 再带 referer + 真实 UA 调接口, 限速 ≥800ms/本。
 *
 * 安全/礼貌: jcarindex 是非营利风险库, 务必温和限速、错峰、不并发。先用 --limit 小批验证再全量。
 *
 * 用法 (prod):
 *   小批验证(前 5 本):  node dist/scripts/scrape-jcar-car.js --limit 5
 *   全量:                node dist/scripts/scrape-jcar-car.js
 */
import { db } from "../models/db.js";
import { journals } from "../models/schema.js";
import { sql, isNotNull } from "drizzle-orm";
import { logger } from "../config/logger.js";

const BASE = "https://www.jcarindex.com";
const LIST_API = `${BASE}/ifs/public/jcar/getJournalList`;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// jcarindex CAR Index 最新列年份(经页面核实: 列头 2024/2025/2026, carIndex=最新=2026)。
//   carIndex→2026, carIndexLastYear→2025, carIndexBeforeLastYear→2024. 随 jcarindex 更新调整。
const JCAR_LATEST_YEAR = 2026;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 低/中/高 → low/mid/high (carIndexHistory.riskLevel 口径) */
function mapRisk(rank: string | null | undefined): "low" | "mid" | "high" {
  if (rank === "高") return "high";
  if (rank === "中") return "mid";
  return "low";
}

interface JcarRecord {
  issn?: string | null;
  name?: string | null;
  carIndex?: number | null;
  carIndexLastYear?: number | null;
  carIndexBeforeLastYear?: number | null;
  carIndexGrowthRate?: number | null;
  sciRiskRank?: string | null;
  sciRiskRankLastYear?: string | null;
  curYearProblemArticleCount?: number | null;
  lastYearProblemArticleCount?: number | null;
}

/** 启动时 GET 首页拿 JSESSIONID (模拟真实浏览器会话, 进一步降低被拦概率) */
async function bootstrapSession(): Promise<string> {
  try {
    const res = await fetch(`${BASE}/`, { headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9" } });
    const setCookie = res.headers.get("set-cookie") || "";
    const m = setCookie.match(/JSESSIONID=([^;]+)/);
    return m ? `JSESSIONID=${m[1]}` : "";
  } catch {
    return "";
  }
}

async function fetchByIssn(issn: string, cookie: string): Promise<JcarRecord | null> {
  const url = `${LIST_API}?page=1&pageSize=10&firstLetter=&sortKey=viewNum&sortDirection=desc&name=&issn=${encodeURIComponent(issn)}&researchArea=&ifsStart=&ifsEnd=&sciIncluded=&bigCat=&smallCat=&partCas=&partJcr=&isOa=`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      referer: `${BASE}/`,
      "user-agent": UA,
      ...(cookie ? { cookie } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { status?: boolean; data?: { records?: JcarRecord[] } };
  const records = json?.data?.records;
  if (!Array.isArray(records) || records.length === 0) return null;
  // ISSN 精确匹配优先(接口可能模糊命中多本)
  const exact = records.find((r) => (r.issn || "").replace(/\s/g, "") === issn.replace(/\s/g, ""));
  return exact || records[0];
}

/** jcar record → car_index_history jsonb (兼容现有 CarIndexHistoryShape + 扩展字段) */
function toCarHistory(r: JcarRecord) {
  const data: Array<{ year: number; carIndex: number }> = [];
  if (typeof r.carIndexBeforeLastYear === "number") data.push({ year: JCAR_LATEST_YEAR - 2, carIndex: r.carIndexBeforeLastYear });
  if (typeof r.carIndexLastYear === "number") data.push({ year: JCAR_LATEST_YEAR - 1, carIndex: r.carIndexLastYear });
  if (typeof r.carIndex === "number") data.push({ year: JCAR_LATEST_YEAR, carIndex: r.carIndex });
  if (data.length === 0) return null;
  return {
    data,
    riskLevel: mapRisk(r.sciRiskRank),
    riskRankText: r.sciRiskRank ?? null, // 原文 低/中/高
    growthRate: typeof r.carIndexGrowthRate === "number" ? r.carIndexGrowthRate : null,
    problemArticles: {
      current: r.curYearProblemArticleCount ?? null,
      last: r.lastYearProblemArticleCount ?? null,
    },
    source: "jcarindex",
    lastUpdatedAt: new Date().toISOString(),
  };
}

async function main() {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : 0;

  let targets = await db
    .select({ id: journals.id, name: journals.name, issn: journals.issn })
    .from(journals)
    .where(isNotNull(journals.issn));
  if (limit > 0) targets = targets.slice(0, limit);

  const cookie = await bootstrapSession();
  console.log(`[jcar] session=${cookie ? "ok" : "none"}, 待抓 ${targets.length} 本 (按 ISSN)`);

  let updated = 0;
  let noHit = 0;
  let errors = 0;
  for (let i = 0; i < targets.length; i++) {
    const j = targets[i];
    const issn = (j.issn || "").trim();
    if (!issn) { noHit += 1; continue; }
    try {
      const rec = await fetchByIssn(issn, cookie);
      if (!rec) { noHit += 1; }
      else {
        const carHist = toCarHistory(rec);
        if (carHist) {
          await db.update(journals).set({
            carIndexHistory: carHist,
            fieldProvenance: sql`COALESCE(${journals.fieldProvenance}, '{}'::jsonb) || '{"carIndexHistory":"jcarindex"}'::jsonb`,
          }).where(sql`${journals.id} = ${j.id}`);
          updated += 1;
        } else { noHit += 1; }
      }
    } catch (err) {
      errors += 1;
      logger.warn({ err: String(err), issn, name: j.name }, "[jcar] 抓取失败");
      // 连续错误可能是被限流; 退避久一点
      await sleep(2000);
    }
    await sleep(800); // 礼貌限速: ≥800ms/本
    if ((i + 1) % 100 === 0) console.log(`[jcar] 进度 ${i + 1}/${targets.length} (CAR 已填 ${updated}, 未命中 ${noHit}, 错 ${errors})`);
  }

  console.log(`\n========== jcar CAR 抓取报告 ==========`);
  console.log(`处理:        ${targets.length}`);
  console.log(`CAR 成功写入: ${updated}`);
  console.log(`未命中:      ${noHit}`);
  console.log(`错误:        ${errors}`);
  console.log(`======================================`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[jcar] 致命错误");
  process.exit(1);
});
