/**
 * 5-24 PR #251 — 探针: 试 4 种 DVH 字幕颜色格式, 找哪个能让默认黑字变白.
 *
 * 背景: PR #246/#248/#250 试过 6 位 hex (FFFFFF) / 8 位 RGBA (FFFFFFFF), 阿里云都不认.
 *   SDK d.ts 只说 color?: string, 没说具体格式. 试 4 个候选格式各发 1 个短任务.
 *
 * 用法 (prod):
 *   pnpm build
 *   node dist/scripts/probe-dvh-subtitle-color.js
 *
 * 流程: 并行 submit 4 个任务 → 等全部 SUCCESS → 打印 4 个 videoUrl → 老韩肉眼对比.
 *   只字幕颜色为 white (任何明显非黑色) 的那个格式就是有效的.
 *
 * 节省成本: text 用极短句 (8 字), 视频约 10-12 秒, 4 个共 ~40 秒 TTS.
 */
import { createDvhClient, $avatar20220130 } from "../services/digital-human/client.js";
import * as $Util from "@alicloud/tea-util";
import { logger } from "../config/logger.js";

// 4 种候选 color 格式 + 对应 outlineColor (统一用黑边对比)
interface Probe {
  label: string;
  color: string;
  outlineColor: string;
  note: string;
}

const PROBES: Probe[] = [
  {
    label: "01-css-name",
    color: "white",
    outlineColor: "black",
    note: "CSS color name (web 标准, 不少 SDK 接受)",
  },
  {
    label: "02-hex-hash",
    color: "#FFFFFF",
    outlineColor: "#000000",
    note: "带 # 的 6 位 hex (CSS / Material-UI 标准)",
  },
  {
    label: "03-0x-prefix",
    color: "0xFFFFFF",
    outlineColor: "0x000000",
    note: "0x 前缀 (C/Java 整数 hex 标准)",
  },
  {
    label: "04-ass-bgr",
    color: "&H00FFFFFF",
    outlineColor: "&H00000000",
    note: "ASS/SSA 字幕格式 BGR (libass 内部用)",
  },
];

const TENANT_ID = process.env.DVH_TENANT_ID;
const APP_ID = process.env.DVH_APP_ID;
const PROBE_TEXT = "字幕颜色测试。这是一段示例文本。";
// 紫灵礼服站姿 + 艾佳标准女声 (跟 A_academic 同套, 老韩之前看过的)
const AVATAR_CODE = "CH_2d_h3UlWl4iAGZZcTqY";
const VOICE_CODE = "aijia";

async function submitProbe(probe: Probe): Promise<{ label: string; taskUuid: string; submitMs: number }> {
  const client = createDvhClient();
  const startedAt = Date.now();
  const req = new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequest({
    tenantId: parseInt(TENANT_ID!, 10),
    app: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestApp({ appId: APP_ID }),
    title: `DVH 字幕色 probe ${probe.label}`.slice(0, 60),
    text: PROBE_TEXT,
    avatarInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestAvatarInfo({ code: AVATAR_CODE }),
    audioInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestAudioInfo({ voice: VOICE_CODE, speechRate: 150 }),
    videoInfo: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestVideoInfo({
      isAlpha: false,
      subtitleEmbedded: true,
      subtitleStyle: new $avatar20220130.SubmitTextTo2DAvatarVideoTaskRequestVideoInfoSubtitleStyle({
        color: probe.color,
        outlineColor: probe.outlineColor,
        size: 64,
        y: 1450,
      }),
      backgroundImageUrl: process.env.DVH_DEFAULT_BG_URL || undefined,
    }),
  });
  const resp = await client.submitTextTo2DAvatarVideoTaskWithOptions(req, new $Util.RuntimeOptions({}));
  if (resp.body?.success === false) {
    throw new Error(`[${probe.label}] submit failed: ${resp.body.code} ${resp.body.message}`);
  }
  const taskUuid = resp.body?.data?.taskUuid;
  if (!taskUuid) throw new Error(`[${probe.label}] no taskUuid`);
  return { label: probe.label, taskUuid, submitMs: Date.now() - startedAt };
}

async function pollUntilDone(taskUuid: string, label: string): Promise<{ label: string; videoUrl: string; status: string }> {
  const client = createDvhClient();
  const startedAt = Date.now();
  const TIMEOUT_MS = 10 * 60 * 1000;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    const req = new $avatar20220130.GetVideoTaskInfoRequest({
      tenantId: parseInt(TENANT_ID!, 10),
      app: new $avatar20220130.GetVideoTaskInfoRequestApp({ appId: APP_ID }),
      taskUuid,
    });
    const resp = await client.getVideoTaskInfoWithOptions(req, new $Util.RuntimeOptions({}));
    const rawStatus = resp.body?.data?.status;
    const statusNum = Number(rawStatus);
    if (statusNum === 3) {
      const r = resp.body?.data?.taskResult;
      return { label, videoUrl: r?.videoUrl ?? "(no videoUrl)", status: "SUCCESS" };
    }
    if (Number.isFinite(statusNum) && statusNum >= 4) {
      return { label, videoUrl: "(failed)", status: `FAILED ${rawStatus}` };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { label, videoUrl: "(timeout)", status: "TIMEOUT" };
}

async function main() {
  if (!TENANT_ID || !APP_ID) {
    console.error("缺 DVH_TENANT_ID / DVH_APP_ID env");
    process.exit(1);
  }
  console.log(`[probe] 试 4 种颜色格式, 并行 submit ...\n`);
  for (const p of PROBES) {
    console.log(`  ${p.label}: color=${p.color}, outline=${p.outlineColor}  (${p.note})`);
  }
  console.log();

  // 并行 submit
  const submitResults = await Promise.allSettled(PROBES.map(submitProbe));
  console.log("[probe] submit 结果:");
  const submitted: { label: string; taskUuid: string }[] = [];
  for (let i = 0; i < submitResults.length; i++) {
    const r = submitResults[i]!;
    const p = PROBES[i]!;
    if (r.status === "fulfilled") {
      console.log(`  ${p.label}: ✅ taskUuid=${r.value.taskUuid} (${r.value.submitMs}ms)`);
      submitted.push({ label: p.label, taskUuid: r.value.taskUuid });
    } else {
      console.log(`  ${p.label}: ❌ ${r.reason instanceof Error ? r.reason.message : r.reason}`);
    }
  }
  console.log();

  if (submitted.length === 0) {
    console.error("全部 submit 失败, 退出");
    process.exit(1);
  }

  // 并行 poll
  console.log(`[probe] 等 ${submitted.length} 个任务渲染完成 (约 60-90 秒)...\n`);
  const pollResults = await Promise.all(submitted.map((s) => pollUntilDone(s.taskUuid, s.label)));

  console.log("\n========== 探针结果 ==========");
  for (const r of pollResults) {
    const p = PROBES.find((x) => x.label === r.label);
    console.log(`\n  ${r.label}  (color=${p?.color}, outline=${p?.outlineColor})`);
    console.log(`    status: ${r.status}`);
    console.log(`    video:  ${r.videoUrl}`);
  }
  console.log("\n========== 下一步 ==========");
  console.log("打开 4 个 videoUrl, 肉眼对比字幕颜色 (默认是黑色).");
  console.log("哪个视频字幕变白 (或非黑) → 该 color 格式生效 → 改 submit-task.ts 用之.");
  console.log("================================\n");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "[probe] 致命错误");
  process.exit(1);
});
