/**
 * 一次性清洗存量 journals.review_cycle 脏值 —— 剥掉 ablesci 夹带的"网友分享经验："等噪音 + 抽取干净时长。
 * 与 scrape-ablesci-detail.ts 的 parseReviewCycle 同口径(3个月 / 6-8周 / 4.5个月)。
 * 用法(服务器, 部署后): cd /home/projects/bossmate/packages/server && node scripts/clean-review-cycle.mjs
 */
import { db } from "../dist/models/db.js";
import { sql } from "drizzle-orm";

function clean(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/\s+/g, " ").replace(/<[^>]+>/g, "").trim();
  v = v.replace(/网友分享经验[:：]?/g, "").replace(/网友分享[:：]?/g, "").replace(/经验[:：]/g, "").trim();
  if (!v || !/月|周|天|年|month|week|day/i.test(v)) return v || null;
  const dur = v.match(/(\d+(?:\.\d+)?(?:\s*[-~]\s*\d+(?:\.\d+)?)?)\s*(个?月|周|天|年|months?|weeks?|days?)/i);
  if (dur) {
    let num = dur[1].replace(/\s+/g, "");
    if (!/[-~]/.test(num)) { const n = parseFloat(num); if (Number.isInteger(n)) num = String(n); }
    return `${num}${dur[2]}`;
  }
  return v.length > 20 ? v.slice(0, 20) : v;
}

const res = await db.execute(sql`SELECT id, review_cycle AS rc FROM journals WHERE review_cycle IS NOT NULL AND (review_cycle LIKE '%网友%' OR review_cycle LIKE '%经验%' OR review_cycle LIKE '%平均%' OR review_cycle ~ '\d\.\d')`);
const rows = res.rows ?? res ?? [];
let n = 0;
for (const r of rows) {
  const c = clean(r.rc);
  if (c && c !== r.rc) { await db.execute(sql`UPDATE journals SET review_cycle = ${c} WHERE id = ${r.id}`); n++; }
}
console.log(`审稿周期清洗完成: ${n}/${rows.length} 条更新`);
process.exit(0);
