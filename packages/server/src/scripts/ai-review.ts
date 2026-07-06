/**
 * 7-05 ④ CLI: 手动跑一轮 AI 审稿扫描 (不等每小时 cron)。
 *
 * 用法 (packages/server 下):
 *   pnpm review:ai                    # 按 env.AI_REVIEWER_MODE, 每轮默认 20 篇
 *   pnpm review:ai -- --limit 5       # 只审 5 篇
 *   pnpm review:ai -- --mode shadow   # 覆盖模式 (off/shadow/live) — 只影响本轮, 不改 env
 */
import { runAiReviewScan, type AiReviewerMode } from "../services/review/ai-reviewer.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const limitRaw = arg("limit");
  const modeRaw = arg("mode");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const mode = modeRaw && ["off", "shadow", "live"].includes(modeRaw) ? (modeRaw as AiReviewerMode) : undefined;
  if (modeRaw && !mode) {
    console.error(`无效 --mode "${modeRaw}" (可选: off/shadow/live)`);
    process.exit(1);
  }
  console.log(`AI 审稿手动触发: limit=${limit ?? "默认20"}, mode=${mode ?? "env 默认"}`);
  const r = await runAiReviewScan({ ...(limit ? { limit } : {}), ...(mode ? { mode } : {}) });
  console.log("结果:", JSON.stringify(r, null, 2));
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
