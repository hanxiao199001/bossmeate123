/**
 * 6-22 抖音/视频号"错峰限频"派单调度。
 *
 * 背景: 抖音风控对"一秒钟批量齐发多个号"判定为机器行为, 会触发短信验证墙甚至关联封号。
 *   原派单是 delay = i * 3000(3 秒线性), 机器味十足。这里把抖音/视频号的派单时机做成:
 *     ① 加大间隔(分钟级, 非秒级)  ② 随机抖动(每段间隔随机, 不等距)
 *     ③ 按号最小间隔(同一个号两条至少隔 N 分钟, 避免同号连发)
 *     ④ 打散窗口封顶(总延迟不超过上限, 别拖到天荒地老)
 *     ⑤ 起始随机偏移(别每次整点齐发)
 *   公众号(服务器凭证发布)不涉及这道风控, 用小节流即可, 不打散。
 *
 * 这是"让发布行为本身真的低风险"的合规做法 —— 不伪造任何信号、不绕过任何检测,
 *   只是把节奏放慢、打散、拟人, 与正规矩阵运营一致。全部阈值可用环境变量覆盖。
 *
 * 7-28 阶段1-B: 本文件原先自带一份 `AGENT_PLATFORMS = new Set(["douyin","wechat_video"])`,
 *   与 agent-dispatch.ts 的那份是复制粘贴关系且从未 import —— 任一边加平台另一边就漂。
 *   现统一读 services/platforms/capabilities.ts 的 publishVia 维度。
 */
import { AGENT_PLATFORMS } from "../platforms/capabilities.js";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const PACE = {
  // 抖音/视频号: 两次派单之间的随机间隔(分钟级)
  minGapMs: num(process.env.DY_PACE_MIN_MS, 6 * 60_000),          // 默认 6 分钟
  maxGapMs: num(process.env.DY_PACE_MAX_MS, 18 * 60_000),         // 默认 18 分钟
  // 同一个号两条之间的最小间隔(避免同号连发被风控)
  perAccountMinMs: num(process.env.DY_PACE_ACCOUNT_MIN_MS, 90 * 60_000), // 默认 90 分钟
  // 整批打散窗口上限(总延迟封顶, 防拖太久)
  maxSpreadMs: num(process.env.DY_PACE_MAX_SPREAD_MS, 4 * 3600_000),     // 默认 4 小时
  // 起始随机偏移上限(别整点齐发)
  startJitterMs: num(process.env.DY_PACE_START_JITTER_MS, 60_000),       // 默认 0~60 秒
  // 公众号等服务器凭证平台的小节流
  serverThrottleMs: num(process.env.PUBLISH_SERVER_THROTTLE_MS, 3_000),  // 默认 3 秒
};

const rand =(a: number, b: number) => a + Math.floor(Math.random() * Math.max(1, b - a));

export interface PacingJob {
  accountId: string;
  platform: string;
}

/**
 * 给一批待派任务计算各自的 delayMs(毫秒)。
 * 抖音/视频号 → 错峰+抖动+按号隔离+封顶; 其它(公众号等) → 小节流线性。
 * 入参顺序即派单顺序; 返回与入参等长的 delay 数组。
 */
export function computePublishDelays(jobs: PacingJob[]): number[] {
  let agentClock = rand(0, PACE.startJitterMs); // 全局错峰时钟, 起始随机偏移
  let serverIdx = 0;
  const acctNextEarliest = new Map<string, number>(); // 每号下次最早可发时刻
  const out: number[] = [];

  for (const j of jobs) {
    if (!AGENT_PLATFORMS.has(j.platform)) {
      // 公众号等: 小节流, 不打散
      out.push(serverIdx * PACE.serverThrottleMs);
      serverIdx++;
      continue;
    }
    // 抖音/视频号: 推进全局时钟一个随机间隔
    agentClock += rand(PACE.minGapMs, PACE.maxGapMs);
    // 不早于该号的"最早可发"(按号最小间隔)
    const earliest = acctNextEarliest.get(j.accountId) ?? 0;
    let delay = Math.max(agentClock, earliest);
    // 打散窗口封顶
    if (delay > PACE.maxSpreadMs) delay = PACE.maxSpreadMs;
    out.push(delay);
    // 更新游标
    agentClock = delay;
    acctNextEarliest.set(j.accountId, delay + PACE.perAccountMinMs);
  }
  return out;
}
