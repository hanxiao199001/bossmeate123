/**
 * 6-26 声音克隆验证(第一步): 上传一段录音样本 → SiliconFlow CosyVoice2 克隆 → 拿到专属音色 uri
 *   → 直接用该 uri 合成一句试听 → 存 storage 打印 URL 给老韩听。
 * 自包含: 直接调 SiliconFlow /uploads/audio/voice + /audio/speech, 不走 ttsService(避开 TTS_PROVIDER 路由)。
 *
 * 用法(服务器 packages/server 下, 需 SILICONFLOW_API_KEY):
 *   pnpm clone:voice --audio /path/录音.mp3 --text "录音里念的原文一字不差" [--name 老韩] [--say "试听要说的话"]
 *
 * 录音建议: 安静环境, 清晰读 20-40 秒, --text 必须跟录音内容一字对应(CosyVoice2 靠它对齐)。
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { env } from "../config/env.js";
import { storage } from "../services/storage/index.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
};

async function main() {
  const audioPath = arg("audio");
  const refText = arg("text");
  const name = (arg("name") || `hanvoice`).replace(/[^a-zA-Z0-9_-]/g, "-");
  const say = arg("say") || "投了半年还没消息？这本期刊审稿快、录用友好，赶毕业的同学可以重点看看。";

  if (!audioPath || !refText) {
    console.error('用法: pnpm clone:voice --audio <音频文件> --text "<录音里念的原文,一字不差>" [--name 名] [--say "试听句"]');
    process.exitCode = 1; return;
  }
  const key = env.SILICONFLOW_API_KEY;
  if (!key) { console.error("❌ SILICONFLOW_API_KEY 未配置(克隆走 SiliconFlow)"); process.exitCode = 1; return; }
  const model = env.TTS_SILICONFLOW_MODEL;
  const base = env.SILICONFLOW_BASE_URL.replace(/\/$/, "");

  const ext = extname(audioPath).toLowerCase();
  const mime = MIME[ext] || "audio/mpeg";
  let b64: string;
  try { b64 = readFileSync(audioPath).toString("base64"); }
  catch (e) { console.error(`❌ 读不到音频 ${audioPath}:`, e instanceof Error ? e.message : e); process.exitCode = 1; return; }

  // 1) 上传样本 → 克隆音色
  console.log(`\n🎙️ 上传声音样本克隆中… (model=${model}, name=${name}, 样本=${(b64.length / 1.37 / 1024).toFixed(0)}KB)`);
  const upResp = await fetch(`${base}/uploads/audio/voice`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, customName: name, text: refText, audio: `data:${mime};base64,${b64}` }),
  });
  const upText = await upResp.text();
  if (!upResp.ok) { console.error(`❌ 克隆上传失败 ${upResp.status}: ${upText.slice(0, 400)}`); process.exitCode = 1; return; }
  let uri: string | undefined;
  try { uri = JSON.parse(upText).uri; } catch { /* */ }
  if (!uri) { console.error("❌ 没拿到音色 uri:", upText.slice(0, 400)); process.exitCode = 1; return; }
  console.log(`✅ 克隆成功! 专属音色 uri = ${uri}`);

  // 2) 用专属音色合成试听句
  console.log(`\n🔊 用你的音色合成试听句: "${say}"`);
  const spResp = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: say, voice: uri, response_format: "mp3", sample_rate: 44100, speed: 1, gain: 0, stream: false }),
  });
  if (!spResp.ok) { const t = await spResp.text().catch(() => ""); console.error(`❌ 合成失败 ${spResp.status}: ${t.slice(0, 300)}`); process.exitCode = 1; return; }
  const audioBuf = Buffer.from(await spResp.arrayBuffer());
  const url = await storage.upload(audioBuf, `voice-clone-test/${name}-${Date.now()}.mp3`, "audio/mpeg");

  console.log(`\n══════════════ 结果 ══════════════`);
  console.log(`专属音色 uri : ${uri}`);
  console.log(`试听音频     : ${url.startsWith("http") ? url : "https://boss-mate.cn" + url}`);
  console.log(`══════════════════════════════════`);
  console.log(`\n👉 听着像你 → 这个 uri 存到账号就能全程用你的声音(下一步做'录音→克隆→存账号'自助UI)。`);
  console.log(`   不够像 → 换更长/更干净的录音重试, 或调 --text 跟录音对齐。`);
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error("克隆异常:", e instanceof Error ? e.message : e); process.exit(1); });
