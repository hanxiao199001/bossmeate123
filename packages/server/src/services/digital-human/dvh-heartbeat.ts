/**
 * 轮询器自己的死活 (9-04 件 2, 补充 c —— 七问 Q3)。
 *
 * 🔴 **轮询器挂了, 表现是所有行慢慢老化到 24h 变孤儿 ——
 *    和"阿里云慢"长得一模一样, 而且要 24 小时后才看得见。**
 *
 * 这是本次改造里唯一一条"检查器自己的检查器", 理由与红线 #23 一致:
 * 一个不工作的轮询器和一个"阿里云今天特别慢"的系统, 在指标上无法区分 ——
 * 除非有一个只有轮询器活着才会更新的东西。
 *
 * 判据: 每轮扫描写一次心跳; 超过 15 分钟(3 个轮询周期)没有心跳 → 告警。
 * 由每日简报调用 checkDvhPollerAlive。
 */
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { logger } from "../../config/logger.js";
import { DVH_POLL_INTERVAL_MINUTES } from "./dvh-tasks.js";

/** 3 个轮询周期没动静就算停摆 */
export const DVH_HEARTBEAT_STALE_MINUTES = DVH_POLL_INTERVAL_MINUTES * 3;

/**
 * 心跳落在 dvh_tasks 上而不是新建一张表: 用一行 task_uuid='__heartbeat__' 的哨兵行。
 * status 固定 'success' —— 它绝不能被 listPendingDvhTasks 捞到当成真任务。
 */
const HEARTBEAT_UUID = "__heartbeat__";

export async function noteDvhPollHeartbeat(now: Date = new Date()): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO dvh_tasks (task_uuid, tenant_id, status, submitted_at, settled_at, last_polled_at, detail)
      VALUES (${HEARTBEAT_UUID}, '00000000-0000-0000-0000-000000000001', 'success',
              ${now.toISOString()}, ${now.toISOString()}, ${now.toISOString()},
              '{"heartbeat":true}'::jsonb)
      ON CONFLICT (task_uuid) DO UPDATE
        SET last_polled_at = ${now.toISOString()}, updated_at = NOW()
    `);
  } catch (err) {
    // 心跳写不进去不该让轮询本身失败, 但必须喊 —— 心跳哑了会让停摆检测跟着失明
    logger.error({ err: err instanceof Error ? err.message : err }, "dvh.heartbeat.write_failed");
  }
}

export interface HeartbeatCheck { alive: boolean; text: string }

export async function checkDvhPollerAlive(now: Date = new Date()): Promise<HeartbeatCheck> {
  try {
    const res = await db.execute(sql`
      SELECT last_polled_at FROM dvh_tasks WHERE task_uuid = ${HEARTBEAT_UUID}
    `);
    const row = (res as unknown as { rows?: Array<{ last_polled_at: string | null }> }).rows?.[0];
    if (!row?.last_polled_at) {
      return { alive: false, text: "数字人轮询器**从未心跳过** —— 任务提交后不会有人去落定它们" };
    }
    const mins = (now.getTime() - new Date(row.last_polled_at).getTime()) / 60_000;
    if (mins > DVH_HEARTBEAT_STALE_MINUTES) {
      return {
        alive: false,
        text: `数字人轮询器已 ${Math.floor(mins)} 分钟无心跳(阈值 ${DVH_HEARTBEAT_STALE_MINUTES} 分钟) —— `
          + "付费任务不会被落定, 24 小时后会集体变成孤儿。这与「阿里云慢」在指标上分不开, 只有心跳能区分。",
      };
    }
    return { alive: true, text: "" };
  } catch (err) {
    // 🔴 查不动也要报 —— 静默返回 alive 等于告诉运营"轮询器正常"
    return { alive: false, text: `数字人轮询器心跳检查**没跑成**(≠ 轮询器正常): ${err instanceof Error ? err.message : String(err)}` };
  }
}
