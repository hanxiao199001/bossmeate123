/**
 * 6-26 声音克隆(阿里云百炼 Qwen-TTS 声音复刻, 复用 QWEN_API_KEY, 成本全在阿里云一个账号):
 *   录音样本 → create_voice 拿专属音色 voice → 用该 voice 合成试听句 → 存 storage 打印 URL。
 *   优点: 建音色直接传 base64(不依赖 OSS 公网URL)、合成走现有 qwen-tts 同一 HTTP endpoint、无需原文。
 *   计费: 建音色 0.01 元/个(90天内 1000 次免费), 合成按 qwen-tts 量计。
 *
 * 用法(服务器 packages/server 下, 需 QWEN_API_KEY):
 *   pnpm clone:voice --audio voice-sample.wav --name hanvoice [--say "试听要说的话"]
 *   音频要求: WAV(16bit)/MP3/M4A, ≥24kHz, 单声道, 10~20秒清晰朗读(无背景音)。
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { env } from "../config/env.js";
import { storage } from "../services/storage/index.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }

const MIME: Record<string, string> = { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4" };

// 百炼基址 + 声音复刻模型(可被 env 覆盖; 若报"业务空间"错, 设 DASHSCOPE_BASE_URL 为带 WorkspaceId 的 maas 地址)
const BASE = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/api/v1").replace(/\/$/, "");
const VC_MODEL = process.env.QWEN_VC_MODEL || "qwen3-tts-vc-2026-01-22";

async function main() {
  const audioPath = arg("audio");
  const name = (arg("name") || "hanvoice").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "hanvoice";
  const say = arg("say") || "投了半年还没消息？这本期刊审稿快、录用友好，赶毕业的同学可以重点看看。";
  if (!audioPath) { console.error('用法: pnpm clone:voice --audio <音频文件> [--name 名(≤10字母数字)] [--say "试听句"]'); process.exitCode = 1; return; }
  const key = env.QWEN_API_KEY;
  if (!key) { console.error("❌ QWEN_API_KEY 未配置(百炼声音复刻复用它)"); process.exitCode = 1; return; }

  const ext = extname(audioPath).toLowerCase();
  const mime = MIME[ext] || "audio/wav";
  let dataUri: string;
  try { dataUri = `data:${mime};base64,${readFileSync(audioPath).toString("base64")}`; }
  catch (e) { console.error(`❌ 读不到音频 ${audioPath}:`, e instanceof Error ? e.message : e); process.exitCode = 1; return; }

  // ① 建音色(base64 直传, 不需要公网URL, 不需要原文)
  console.log(`\n🎙️ 百炼建音色中… (model=${VC_MODEL}, name=${name})`);
  const upResp = await fetch(`${BASE}/services/audio/tts/customization`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-voice-enrollment",
      input: { action: "create", target_model: VC_MODEL, preferred_name: name, audio: { data: dataUri } },
    }),
  });
  const upText = await upResp.text();
  if (!upResp.ok) {
    console.error(`❌ 建音色失败 ${upResp.status}: ${upText.slice(0, 400)}`);
    if (/workspace|业务空间|model not exist|InvalidParameter/i.test(upText)) console.error("   → 可能要带 WorkspaceId: 设 DASHSCOPE_BASE_URL=https://<业务空间ID>.cn-beijing.maas.aliyuncs.com/api/v1 再试");
    process.exitCode = 1; return;
  }
  let voice: string | undefined;
  try { voice = JSON.parse(upText).output?.voice; } catch { /* */ }
  if (!voice) { console.error("❌ 没拿到 voice:", upText.slice(0, 400)); process.exitCode = 1; return; }
  console.log(`✅ 克隆成功! 专属音色 voice = ${voice}`);

  // ② 用专属音色合成试听句(同现有 qwen-tts endpoint, 只换 model+voice)
  console.log(`\n🔊 用你的音色合成: "${say}"`);
  const spResp = await fetch(`${BASE}/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: VC_MODEL, input: { text: say, voice } }),
  });
  const spText = await spResp.text();
  if (!spResp.ok) { console.error(`❌ 合成失败 ${spResp.status}: ${spText.slice(0, 300)}`); process.exitCode = 1; return; }
  let audioUrl: string | undefined, b64: string | undefined;
  try { const j = JSON.parse(spText); audioUrl = j.output?.audio?.url; b64 = j.output?.audio?.data; } catch { /* */ }
  let buf: Buffer;
  if (audioUrl) { const a = await fetch(audioUrl); buf = Buffer.from(await a.arrayBuffer()); }
  else if (b64) { buf = Buffer.from(b64, "base64"); }
  else { console.error("❌ 合成无音频返回:", spText.slice(0, 300)); process.exitCode = 1; return; }

  const remote = `voice-clone-test/${name}-${Date.now()}.mp3`;
  const url = await storage.upload(buf, remote, "audio/mpeg");
  const listen = url.startsWith("http") ? url : "https://boss-mate.cn" + url; // 桶公共读, 裸URL可听; 本地存储则拼域名

  console.log(`\n══════════════ 结果 ══════════════`);
  console.log(`专属音色 voice : ${voice}`);
  console.log(`试听音频       : ${listen}`);
  console.log(`══════════════════════════════════`);
  console.log(`\n👉 听着像你 → 这个 voice 存到账号就能全程用你的声音(下一步做'录音→克隆→存账号'自助UI + 接进数字人/卡片视频)。`);
  console.log(`   不够像 → 换更长(20-30秒)、更安静的录音重试。`);
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error("克隆异常:", e instanceof Error ? e.message : e); process.exit(1); });
