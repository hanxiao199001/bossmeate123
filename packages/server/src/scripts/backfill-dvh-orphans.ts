/**
 * 把存量 10 条"孤儿"灌进 dvh_tasks, 作为件 2 的验收用例 (9-04)。
 *
 * 用法(服务器上):
 *   ssh "$BOSSMATE_DEPLOY_SERVER" 'cd /home/projects/bossmate/packages/server && \
 *     node dist/scripts/backfill-dvh-orphans.js'
 *
 * ## 为什么灌全部 10 条而不只是那条成功的
 *
 * 只验成功那一条的话, **失败分支依然是 0 次执行** —— 和现在 dvh_task_failed
 * 至今 0 次是同一个形态。预期第一轮扫描结果:
 *
 * ```
 * 8 × failed    (7×10010002 图片分辨率 + 1×10050005 任务处理超时)
 * 1 × success   (66335e8e, 若尚未过期)
 * 1 × expired   (c8c45ead, 8-18, 已 status=6)
 * ```
 *
 * 三个数对上, 单一写者与记账时机才算验过。
 *
 * ⚠️ 66335e8e 会在 9-03~9-12 之间过期(结果保留期 6~15 天), 过期后它这一行的
 * 预期结果从 success 变成 expired, 验收表要跟着改 —— 成片已于 9-04 存档到
 * OSS `_orphan-archive/2026-08-28/`。
 *
 * 幂等: ON CONFLICT DO NOTHING, 重复跑不会产生第二行, 也不会重复记账
 * (本脚本**不记账** —— 这 10 条的钱 8 月就已经记过了)。
 */
import { sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { logger } from "../config/logger.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";

/** 9-03 从 cost_ledger 的孤儿记录里提取, 金额为当时按预估记的分 */
const ORPHANS: Array<{ uuid: string; submittedAt: string; cents: number }> = [
  { uuid: "73af703c-0234-4fd4-8b45-7cac3669f7bb", submittedAt: "2026-08-31T00:18:00Z", cents: 1700 },
  { uuid: "66335e8e-bc20-4acb-b517-1b3f7426bd1b", submittedAt: "2026-08-27T19:48:00Z", cents: 1980 },
  { uuid: "c8c45ead-4161-4dff-a607-23c437b7c5e8", submittedAt: "2026-08-17T23:22:00Z", cents: 1502 },
  { uuid: "4a94e9d0-8e83-42c5-b5ab-aa573315f64a", submittedAt: "2026-08-12T18:07:00Z", cents: 1766 },
  { uuid: "d63dc12d-7bb1-4d90-97a6-2fd427c23220", submittedAt: "2026-08-11T18:34:00Z", cents: 1749 },
  { uuid: "44d1bc48-a228-484c-9489-93c0788fab49", submittedAt: "2026-08-11T18:26:00Z", cents: 1716 },
  { uuid: "7e43ffa3-3ff3-4f0e-9fd7-9a341b29e078", submittedAt: "2026-08-11T18:16:00Z", cents: 1353 },
  { uuid: "14bc60bb-0afe-4e3f-9c08-41f10d90927c", submittedAt: "2026-08-09T19:43:00Z", cents: 1980 },
  { uuid: "059b741a-9071-4f79-b6f0-e94ce6dd98b5", submittedAt: "2026-08-07T01:32:00Z", cents: 1667 },
  { uuid: "4c26f0d9-ed55-4144-b65d-457cc299320a", submittedAt: "2026-08-07T01:25:00Z", cents: 1518 },
];

async function main() {
  let inserted = 0;
  for (const o of ORPHANS) {
    const res = await db.execute(sql`
      INSERT INTO dvh_tasks (task_uuid, tenant_id, status, submitted_at, estimated_cents, detail)
      VALUES (${o.uuid}, ${SYSTEM_RECOMMENDATION_TENANT_ID}, 'submitted', ${o.submittedAt}, ${o.cents},
              '{"backfilled":true,"source":"9-03 孤儿盘点"}'::jsonb)
      ON CONFLICT (task_uuid) DO NOTHING
    `);
    const n = (res as { rowCount?: number }).rowCount ?? 0;
    inserted += n;
    logger.info({ taskUuid: o.uuid, inserted: n > 0 }, "backfill.dvh_orphan");
  }
  /**
   * 🔴 灌进来时 submitted_at 全都超过 24 小时, 所以第一轮扫描会先被
   * listOverdueDvhTasks 判成孤儿 —— 那不是我们要的验收结果。
   *
   * 因此把它们的 submitted_at 拨到"刚刚", 让轮询器把它们当**待落定**处理,
   * 走 listPendingDvhTasks → 真去查阿里云 → 拿到 8 failed / 1 success / 1 expired。
   * 这是灌历史数据做验收的必要动作, 不是掩盖时间。detail 里记了原始时间。
   */
  await db.execute(sql`
    UPDATE dvh_tasks
    SET detail = detail || jsonb_build_object('originalSubmittedAt', submitted_at::text),
        submitted_at = NOW()
    WHERE detail->>'backfilled' = 'true' AND status = 'submitted'
  `);
  logger.info({ inserted, total: ORPHANS.length }, "✅ 存量孤儿已灌入 dvh_tasks, 等待下一轮 dvh-poll(每 5 分钟)");
  process.exit(0);
}

main().catch((err) => { logger.fatal(err, "backfill 失败"); process.exit(1); });
