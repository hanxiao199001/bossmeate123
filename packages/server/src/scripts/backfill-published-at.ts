/**
 * 回填 `contents.published_at`（8-20）。**默认只读，加 --apply 才写。**
 *
 * ## 唯一数据源：`content_publish_log` 里 `status='success'` 的最早一条
 *
 * 那是运营在后台标记「已发布」时写的（`initiatedBy='manual'`）—— 全系统唯一一个
 * 「人确认发出去了」的信号，是**真实记录**，不是推断。
 *
 * 不算已发布的三类，**一条都不填**：
 * ```
 * draft_pushed   62   只推进草稿箱，没群发
 * draft_expired 269   推了草稿但过期作废
 * failed         17
 * ```
 *
 * ## 🔴 绝不用 `updated_at` 回填
 *
 * 那等于把污染原样搬进新字段 —— `updated_at` 已被批量运维刷过
 * （8-13 摘 body、8-18 救 35 条），且从此**看不出哪些是真的、哪些是搬来的**。
 * **NULL 是诚实的，猜出来的时间戳是毒数据。**
 *
 * ## 不动 status
 *
 * 历史内容当前是 `archived 305 / generated 175 / needs_review 45`，
 * 而状态机里 `needs_review`/`archived` 都到不了 `published`。
 * 为回填去放宽状态机，或强行改写历史状态，都是拿业务状态迁就一个统计字段。
 * `published_at` 记录**事实**，状态机记录**流转**，两件事。
 *
 * ```bash
 * npx tsx src/scripts/backfill-published-at.ts          # 只看
 * npx tsx src/scripts/backfill-published-at.ts --apply  # 真写
 * ```
 */
import { sql } from "drizzle-orm";
import { db } from "../models/db.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const stat = await db.execute(sql`
    select
      (select count(*)::int from contents where type = 'article') total,
      (select count(*)::int from contents where published_at is not null) already,
      (select count(distinct content_id)::int from content_publish_log where status = 'success') fillable,
      (select count(distinct content_id)::int from content_publish_log where status <> 'success') non_success`);
  const s = stat.rows[0] as Record<string, unknown>;
  console.log(`contents 总数 ${s.total} ｜ 已有 published_at ${s.already} ｜ 可回填(success) ${s.fillable} ｜ 非 success 的 ${s.non_success} 条不填\n`);

  const preview = await db.execute(sql`
    select c.id, left(c.title, 30) t, c.status, min(l.created_at) pub
    from contents c join content_publish_log l on l.content_id = c.id
    where l.status = 'success' and c.published_at is null
    group by 1, 2, 3 order by 4 desc limit 6`);
  console.log("样例（取最早的 success 时刻）：");
  for (const r of preview.rows as Array<Record<string, unknown>>) {
    console.log(`   ${String(r.pub).slice(0, 19)}  ${String(r.status).padEnd(13)} ${r.t}`);
  }

  // ⑥ 改动前后的对比数 —— 写进 commit，免得明天有人把变化当事故
  const before = await db.execute(sql`
    select count(*)::int n from contents where status = 'published' and updated_at > now() - interval '24 hours'`);
  const after = await db.execute(sql`
    select count(distinct l.content_id)::int n from content_publish_log l
    where l.status = 'success' and l.created_at > now() - interval '24 hours'`);
  console.log(`\n「24h 已发布」这个数：旧算法 ${(before.rows[0] as Record<string, unknown>).n} → 回填后 ${(after.rows[0] as Record<string, unknown>).n}`);

  if (!APPLY) {
    console.log("\n（只读模式。确认后加 --apply）");
    process.exit(0);
  }

  const r = await db.execute(sql`
    update contents c
    set published_at = src.pub
    from (
      select content_id, min(created_at) pub from content_publish_log
      where status = 'success' group by content_id
    ) src
    where c.id = src.content_id and c.published_at is null`);
  console.log(`\n✔ 已回填 ${r.rowCount ?? "?"} 条`);

  const chk = await db.execute(sql`
    select count(*)::int filled, min(published_at)::date f, max(published_at)::date l
    from contents where published_at is not null`);
  console.log("复核：", JSON.stringify(chk.rows[0]));
  process.exit(0);
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
