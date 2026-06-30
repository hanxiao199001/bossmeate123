/**
 * 6-26 声音克刻服务(阿里云百炼 Qwen-TTS 声音复刻, 复用 QWEN_API_KEY)。
 *   被 CLI(clone-voice.ts)和自助接口(POST /accounts/:id/clone-voice)共用。
 *   建音色: base64 音频直传(不依赖 OSS 公网URL、不需原文)。合成: 现有 qwen-tts 同一 HTTP endpoint。
 */
import { env } from "../../config/env.js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/api/v1").replace(/\/$/, "");
const VC_MODEL = process.env.QWEN_VC_MODEL || "qwen3-tts-vc-2026-01-22";

/** base64 音频(data URI) → 百炼建音色 → 返回专属 voice_id。 */
export async function createClonedVoice(opts: { audioBase64DataUri: string; name: string }): Promise<{ voice: string }> {
  const key = env.QWEN_API_KEY;
  if (!key) throw new Error("QWEN_API_KEY 未配置(百炼声音复刻复用它)");
  const name = (opts.name || "voice").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "voice";
  const resp = await fetch(`${BASE}/services/audio/tts/customization`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen-voice-enrollment",
      input: { action: "create", target_model: VC_MODEL, preferred_name: name, audio: { data: opts.audioBase64DataUri } },
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    if (/workspace|业务空间|model not exist|InvalidParameter/i.test(text)) {
      throw new Error(`建音色失败(可能需配 DASHSCOPE_BASE_URL 带业务空间ID): ${resp.status} ${text.slice(0, 200)}`);
    }
    throw new Error(`建音色失败 ${resp.status}: ${text.slice(0, 300)}`);
  }
  let voice: string | undefined;
  try { voice = JSON.parse(text).output?.voice; } catch { /* */ }
  if (!voice) throw new Error(`未拿到 voice: ${text.slice(0, 300)}`);
  return { voice };
}

/** 用克隆音色合成一句文本, 返回音频 Buffer(试听/通用)。 */
export async function synthesizeWithClonedVoice(voice: string, text: string): Promise<Buffer> {
  const key = env.QWEN_API_KEY;
  if (!key) throw new Error("QWEN_API_KEY 未配置");
  const resp = await fetch(`${BASE}/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: VC_MODEL, input: { text, voice } }),
  });
  const t = await resp.text();
  if (!resp.ok) throw new Error(`合成失败 ${resp.status}: ${t.slice(0, 200)}`);
  let url: string | undefined, b64: string | undefined;
  try { const j = JSON.parse(t); url = j.output?.audio?.url; b64 = j.output?.audio?.data; } catch { /* */ }
  if (url) { const a = await fetch(url); if (!a.ok) throw new Error(`下载克隆音频失败 ${a.status}`); return Buffer.from(await a.arrayBuffer()); }
  if (b64) return Buffer.from(b64, "base64");
  throw new Error(`合成无音频返回: ${t.slice(0, 200)}`);
}


/**
 * 浏览器录音多为 webm/opus, 但百炼要 WAV/MP3/M4A → ffmpeg 转 wav(24kHz 单声道, 百炼推荐规格)。
 *   输入任意可解码音频, 输出 wav Buffer。失败抛错。
 */
export async function convertToWav24kMono(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vc-conv-"));
  const inPath = join(dir, "in"), outPath = join(dir, "out.wav");
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      const p = spawn("ffmpeg", ["-y", "-i", inPath, "-ac", "1", "-ar", "24000", "-f", "wav", outPath], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => { err += d.toString(); });
      p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg 转码失败(${code}): ${err.slice(-200)}`)));
      p.on("error", reject);
    });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
