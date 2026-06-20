/**
 * 6-19 AI 混剪 MVP(防查重): DVH 数字人视频 → 加 片头标题卡 + 主体轻微缩放(变每帧指纹) + 片尾CTA + 交叉转场,
 *   由 seed 驱动随机(片头/尾底色、转场类型、缩放、时长抖动) → 同一条内容给不同账号传不同 seed = 不同成片。
 *   口型同步: 主视频/主音频 t0 都对齐到 xfade offset, 不变速、不裁主轴, 保证对口型。
 *   失败兜底: 任一步出错 → 返回原 videoUrl(不阻塞发布)。轻量(短视频 90s), 2核4G 可承受。
 *
 * ffmpeg 管线已在沙盒 4.4.2 验证通过。中文字幕需 CJK 字体(服务器装了 fonts-noto-cjk)。
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storage } from "../storage/index.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export interface RemixOptions {
  videoUrl: string;   // DVH 原视频 URL
  title: string;      // 片头标题(取文章标题)
  cta?: string;       // 片尾 CTA 文案
  taskUuid?: string;  // 用于 OSS key / 日志
  seed?: number;      // 随机种子: 不同账号传不同 seed → 不同成片
}
export interface RemixResult {
  videoUrl: string;   // 混剪后 URL(失败时回原 URL)
  remixed: boolean;
}

const FONT = process.env.DVH_REMIX_FONT
  || "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"; // 服务器 fonts-noto-cjk
const INTRO_COLORS = ["0x1a2a6c", "0x0b486b", "0x2c3e50", "0x4b134f", "0x16222a", "0x232526"];
const OUTRO_COLORS = ["0x0b486b", "0x1a2a6c", "0x141e30", "0x42275a", "0x0f2027", "0x000428"];
const TRANSITIONS = ["fade", "fadeblack", "dissolve", "wipeleft", "slideup", "circleopen", "smoothup"];

/** mulberry32 确定性随机(同 seed 同结果)。 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const escFf = (s: string) => s.replace(/'/g, "").replace(/[\\:]/g, " ").slice(0, 40);

async function probe(file: string): Promise<{ w: number; h: number; dur: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-show_entries", "format=duration",
      "-of", "default=nw=1", file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => {
      const w = Number(/width=(\d+)/.exec(out)?.[1]);
      const h = Number(/height=(\d+)/.exec(out)?.[1]);
      const dur = Number(/duration=([\d.]+)/.exec(out)?.[1]);
      if (!w || !h || !dur) return reject(new Error("ffprobe 解析失败"));
      resolve({ w, h, dur });
    });
  });
}

function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; proc.stderr.on("data", (d) => (err += String(d).slice(-2000)));
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; proc.kill("SIGKILL"); reject(new Error(`混剪 ffmpeg 超时 ${env.DVH_FFMPEG_TIMEOUT_MS}ms`)); } }, env.DVH_FFMPEG_TIMEOUT_MS);
    proc.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    proc.on("close", (code) => { if (done) return; done = true; clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`混剪 ffmpeg 退出码 ${code}: ${err.slice(-300)}`)); });
  });
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const maxBytes = env.DVH_DOWNLOAD_MAX_MB * 1024 * 1024;
  // DVH 视频在 LocalStorage 模式下是相对路径 /storage/...mp4, fetch 不接受相对 URL。
  // 直接读本地磁盘(复用 storage.resolveLocalPath), 仅 http(s) 才走 fetch(OSS/远程)。
  if (!/^https?:\/\//i.test(url)) {
    const remotePath = url.replace(/^\/?storage\//, "");
    const localPath = storage.resolveLocalPath?.(remotePath);
    if (!localPath) throw new Error(`无法解析本地视频路径: ${url}`);
    const buf = await readFile(localPath);
    if (buf.length > maxBytes) throw new Error(`视频过大 ${(buf.length / 1048576).toFixed(0)}MB`);
    await writeFile(filePath, buf);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.DVH_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`视频过大 ${(buf.length / 1048576).toFixed(0)}MB`);
    await writeFile(filePath, buf);
  } finally { clearTimeout(timer); }
}

/** 主入口: 原视频 → 混剪 → OSS。失败回原 URL, 不阻塞。 */
export async function remixVideo(opts: RemixOptions): Promise<RemixResult> {
  const { videoUrl, title, cta, taskUuid } = opts;
  const seed = (opts.seed ?? Math.floor(Math.random() * 1e9)) | 0;
  let workDir: string | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), "dvh-remix-"));
    const inMp4 = join(workDir, "in.mp4");
    const outMp4 = join(workDir, "out.mp4");
    const titleTxt = join(workDir, "title.txt");
    const ctaTxt = join(workDir, "cta.txt");

    await downloadToFile(videoUrl, inMp4);
    const { w, h, dur } = await probe(inMp4);

    const r = rng(seed);
    const pick = <T,>(arr: T[]) => arr[Math.floor(r() * arr.length) % arr.length]!;
    const introDur = 2.2 + r() * 0.8;            // 2.2~3.0s
    const outroDur = 1.6 + r() * 0.8;            // 1.6~2.4s
    const xf = 0.6;
    const zoom = (1.0 + r() * 0.03).toFixed(4);  // 1.00~1.03 轻微缩放, 变每帧指纹, 不动音频
    const introCol = pick(INTRO_COLORS), outroCol = pick(OUTRO_COLORS);
    const t1 = pick(TRANSITIONS), t2 = pick(TRANSITIONS);
    const off1 = +(introDur - xf).toFixed(3);          // 主视频/音频 t0 落点
    const v1Dur = off1 + dur;
    const off2 = +(v1Dur - xf).toFixed(3);
    const total = +(off2 + outroDur).toFixed(3);
    const delayMs = Math.round(off1 * 1000);

    await writeFile(titleTxt, escFf(title || ""));
    await writeFile(ctaTxt, escFf(cta || "关注我，投稿少踩坑"));

    const fc =
      `[0:v]fps=25,scale=iw*${zoom}:ih*${zoom},crop=${w}:${h},setsar=1,format=yuv420p,settb=AVTB[mainv];` +
      `[1:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,drawtext=fontfile='${FONT}':textfile='${titleTxt}':fontcolor=white:fontsize=${Math.round(w / 16)}:x=(w-text_w)/2:y=(h-text_h)/2,settb=AVTB[intro];` +
      `[2:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,drawtext=fontfile='${FONT}':textfile='${ctaTxt}':fontcolor=white:fontsize=${Math.round(w / 17)}:x=(w-text_w)/2:y=(h-text_h)/2,settb=AVTB[outro];` +
      `[intro][mainv]xfade=transition=${t1}:duration=${xf}:offset=${off1}[vx];` +
      `[vx][outro]xfade=transition=${t2}:duration=${xf}:offset=${off2}[vv];` +
      `[0:a]adelay=${delayMs}|${delayMs},apad[aa]`;

    const args = [
      "-y", "-i", inMp4,
      "-f", "lavfi", "-t", introDur.toFixed(2), "-i", `color=c=${introCol}:s=${w}x${h}:r=25`,
      "-f", "lavfi", "-t", outroDur.toFixed(2), "-i", `color=c=${outroCol}:s=${w}x${h}:r=25`,
      "-filter_complex", fc,
      "-map", "[vv]", "-map", "[aa]", "-t", total.toFixed(2),
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-movflags", "+faststart", outMp4,
    ];
    logger.info({ taskUuid, seed, dur, total, t1, t2 }, "dvh.remix.start");
    await runFFmpeg(args);

    const buffer = await readFile(outMp4);
    const key = `dvh-videos/remix-${taskUuid || Date.now()}-${seed}.mp4`;
    const newUrl = await storage.upload(buffer, key, "video/mp4");
    logger.info({ taskUuid, seed, newUrl, bytes: buffer.length }, "dvh.remix.done");
    return { videoUrl: newUrl, remixed: true };
  } catch (err) {
    logger.warn({ taskUuid, err: err instanceof Error ? err.message : err }, "dvh.remix.failed_fallback");
    return { videoUrl, remixed: false };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
