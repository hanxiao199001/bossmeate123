/**
 * TTS Service - 文字转语音
 *
 * 支持：
 *  - aliyun (默认) - 阿里云智能语音交互 NLS 短语音合成 HTTP 接口
 *  - azure - Azure Cognitive Services Speech
 *
 * 说明：
 *  - 阿里云短文本合成 HTTP 接口一次性返回 WAV/MP3 Buffer，上限 300 字符/次
 *  - 本服务自动分段，将结果拼接（简化处理：逐段上传，或拼成完整 mp3）
 *
 * 实际部署时需要引入阿里云 TTS SDK；本文件优先用 HTTP 直调 + Token 换取，
 * 未配置 key 时退化为 stub（写一段 1 秒静音 mp3 便于流程跑通）。
 */

import { execSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { rateLimiter } from "../rate-limiter/index.js";
import { storage } from "../storage/index.js";

/** 阿里云 RPC API 百分号编码（RFC 3986） */
function aliyunEncode(s: string): string {
  return encodeURIComponent(s).replace(/\*/g, "%2A");
}

/** 调用阿里云 NLS Meta API 换取 Token */
async function fetchNlsToken(
  akId: string,
  akSecret: string
): Promise<{ token: string; expireAt: number }> {
  const params: Record<string, string> = {
    AccessKeyId: akId,
    Action: "CreateToken",
    Format: "JSON",
    RegionId: "cn-shanghai",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2019-02-28",
  };

  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${aliyunEncode(k)}=${aliyunEncode(params[k])}`)
    .join("&");

  const stringToSign = `GET&${aliyunEncode("/")}&${aliyunEncode(canonical)}`;
  const signature = createHmac("sha1", `${akSecret}&`)
    .update(stringToSign)
    .digest("base64");

  const url = `https://nls-meta.cn-shanghai.aliyuncs.com/?${canonical}&Signature=${aliyunEncode(signature)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`NLS Token API ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    Token?: { Id: string; ExpireTime: number };
    Message?: string;
  };
  if (!data.Token?.Id) {
    throw new Error(`NLS Token 换取失败: ${data.Message || JSON.stringify(data)}`);
  }
  return {
    token: data.Token.Id,
    expireAt: data.Token.ExpireTime * 1000,
  };
}

export interface TTSResult {
  url: string;           // storage 访问 URL
  remotePath: string;
  durationMs: number;    // 估算时长
  bytes: number;
  format: "mp3" | "wav";
}

export class TTSService {
  private readonly provider = env.TTS_PROVIDER;
  private readonly voice = env.TTS_VOICE_ID;
  private tokenCache: { token: string; expireAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;

  /**
   * 将文字合成语音并上传到 storage
   */
  async synthesize(
    tenantId: string,
    text: string,
    opts?: { voice?: string; format?: "mp3" | "wav" }
  ): Promise<TTSResult> {
    const fmt = opts?.format ?? "mp3";
    const voice = opts?.voice ?? this.voice;

    await rateLimiter.acquireOrWait("aliyun-tts");

    let audio: Buffer;
    const hasAliyunCreds =
      env.ALIYUN_AK_ID && env.ALIYUN_AK_SECRET && env.ALIYUN_NLS_APPKEY;
    const hasStaticToken = env.TTS_API_KEY && env.ALIYUN_NLS_APPKEY;

    if (this.provider === "aliyun" && (hasAliyunCreds || hasStaticToken)) {
      try {
        audio = await this.synthesizeAliyun(text, voice, fmt);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : err }, "阿里云 TTS 合成失败，降级静音");
        audio = this.silentMp3(estimateDurationMs(text));
      }
    } else if (this.provider === "azure" && env.TTS_API_KEY) {
      audio = await this.synthesizeAzure(text, voice, fmt);
    } else {
      logger.warn("TTS 凭证未配置，生成占位静音音频");
      audio = this.silentMp3(estimateDurationMs(text));
    }

    const remotePath = `tts/${tenantId}/${Date.now()}.${fmt}`;
    const url = await storage.upload(
      audio,
      remotePath,
      fmt === "mp3" ? "audio/mpeg" : "audio/wav"
    );

    return {
      url,
      remotePath,
      durationMs: estimateDurationMs(text),
      bytes: audio.length,
      format: fmt,
    };
  }

  /** 取阿里云 NLS Token，带缓存和并发去重 */
  private async getNlsToken(): Promise<string> {
    const now = Date.now();
    // 提前 1 小时刷新
    if (this.tokenCache && this.tokenCache.expireAt > now + 60 * 60 * 1000) {
      return this.tokenCache.token;
    }
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      try {
        // 优先用 AccessKey 动态换取；fallback 到静态 TTS_API_KEY（调试用）
        if (env.ALIYUN_AK_ID && env.ALIYUN_AK_SECRET) {
          const { token, expireAt } = await fetchNlsToken(
            env.ALIYUN_AK_ID,
            env.ALIYUN_AK_SECRET
          );
          this.tokenCache = { token, expireAt };
          logger.info(
            { expireAt: new Date(expireAt).toISOString() },
            "阿里云 NLS Token 已刷新"
          );
          return token;
        }
        if (env.TTS_API_KEY) return env.TTS_API_KEY;
        throw new Error("阿里云 NLS 凭证未配置（需 ALIYUN_AK_ID + ALIYUN_AK_SECRET）");
      } finally {
        this.tokenPromise = null;
      }
    })();
    return this.tokenPromise;
  }

  // --- 阿里云 NLS 短文本合成 ---
  private async synthesizeAliyun(
    text: string,
    voice: string,
    fmt: "mp3" | "wav"
  ): Promise<Buffer> {
    const appkey = env.ALIYUN_NLS_APPKEY;
    if (!appkey) throw new Error("ALIYUN_NLS_APPKEY 未配置");

    const token = await this.getNlsToken();

    // 阿里云 NLS TTS 一次上限 300 字符，超出需分段合成
    const chunks = this.splitText(text, 280);
    const buffers: Buffer[] = [];

    for (const chunk of chunks) {
      const url =
        "https://nls-gateway.cn-shanghai.aliyuncs.com/stream/v1/tts" +
        `?appkey=${encodeURIComponent(appkey)}` +
        `&text=${encodeURIComponent(chunk)}` +
        `&voice=${encodeURIComponent(voice)}` +
        `&format=${fmt}`;

      const resp = await fetch(url, {
        headers: { "X-NLS-Token": token },
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`阿里云 TTS ${resp.status}: ${errText.slice(0, 200)}`);
      }
      buffers.push(Buffer.from(await resp.arrayBuffer()));
    }

    return Buffer.concat(buffers);
  }

  // --- Azure TTS ---
  private async synthesizeAzure(
    text: string,
    voice: string,
    fmt: "mp3" | "wav"
  ): Promise<Buffer> {
    const region = process.env.AZURE_SPEECH_REGION || "eastasia";
    const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const ssml = `<speak version='1.0' xml:lang='zh-CN'><voice name='${voice}'>${escapeXml(
      text
    )}</voice></speak>`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": env.TTS_API_KEY!,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat":
          fmt === "mp3"
            ? "audio-24khz-96kbitrate-mono-mp3"
            : "riff-16khz-16bit-mono-pcm",
      },
      body: ssml,
    });
    if (!resp.ok) {
      throw new Error(`Azure TTS ${resp.status}: ${await resp.text()}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  private splitText(text: string, maxLen: number): string[] {
    const sentences = text.split(/([，。！？,.!?;\n])/);
    const chunks: string[] = [];
    let buf = "";
    for (const s of sentences) {
      if ((buf + s).length > maxLen) {
        if (buf) chunks.push(buf);
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf) chunks.push(buf);
    return chunks.length ? chunks : [text];
  }

  /** 生成真正的静音 MP3（用 FFmpeg anullsrc，确保后续 FFmpeg 合成能解析） */
  private silentMp3(durationMs: number): Buffer {
    const durSec = Math.max(0.5, durationMs / 1000);
    try {
      return Buffer.from(execSync(
        `ffmpeg -y -f lavfi -i anullsrc=channel_layout=mono:sample_rate=22050 -t ${durSec.toFixed(2)} -c:a libmp3lame -b:a 32k -f mp3 pipe:1`,
        { maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
      ));
    } catch {
      // FFmpeg 不可用 fallback: 最小合法 MP3（单帧头 + 空数据 × N帧）
      const hdr = Buffer.from([0xFF, 0xFB, 0x90, 0x00]);
      const frameSz = 417;
      const frameCnt = Math.max(1, Math.ceil(durSec * 44100 / 1152));
      const frames: Buffer[] = [];
      for (let i = 0; i < frameCnt; i++) {
        const f = Buffer.alloc(frameSz, 0);
        hdr.copy(f);
        frames.push(f);
      }
      return Buffer.concat(frames);
    }
  }
}

function estimateDurationMs(text: string): number {
  // 按中文 3.5 字/秒 估算
  const chars = text.length;
  return Math.ceil((chars / 3.5) * 1000);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;");
}

export const ttsService = new TTSService();
