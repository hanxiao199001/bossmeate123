/**
 * 6-19 AI 混剪 MVP(防查重): DVH 数字人视频 → 加 片头标题卡 + 主体轻微缩放(变每帧指纹) + 片尾CTA + 交叉转场,
 *   由 seed 驱动随机(片头/尾底色、转场类型、缩放、时长抖动) → 同一条内容给不同账号传不同 seed = 不同成片。
 *   口型同步: 主视频/主音频 t0 都对齐到 xfade offset, 不变速、不裁主轴, 保证对口型。
 *   失败兜底: 任一步出错 → 返回原 videoUrl(不阻塞发布)。轻量(短视频 90s), 2核4G 可承受。
 *
 * 7-02 混剪提质(①③④):
 *   ① 片头钩子卡: 可传 introBgUrl(期刊封面等) — 铺满压暗当背景, 标题放大到 w/14 + 黑描边 + 两行断行 + 整段 fade in;
 *   ② BGM ducking: volume 死压 0.16 → sidechaincompress(人声出现自动压 BGM, 停顿处浮起, 有呼吸感);
 *   ③ B-roll 中段插层: brollPaths(1-3 张本地图) 全屏 overlay + enable 时间窗 + 轻微平移 —
 *      只叠加不切主轴, 主视频时间轴/音频完全不动(口型安全)。
 *   兜底策略: 增强滤镜图任何原因跑挂 → 自动降级重跑老滤镜图(无素材/无 ducking); 再挂才回原片。
 *
 * ffmpeg 管线已在沙盒 4.4.2 验证通过。中文字幕需 CJK 字体(服务器装了 fonts-noto-cjk)。
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
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
  introBgUrl?: string;   // ① 片头背景图(URL/本地路径, 如期刊封面); 拿不到/下载失败回退纯色
  brollPaths?: string[]; // ④ B-roll 本地图片路径(1-3 张, 如期刊封面/图表 PNG); 无效路径自动剔除
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
const escFf = (s: string) => s.replace(/'/g, "").replace(/[\\:]/g, " ").slice(0, 26);

/**
 * ① 标题断行: 26 字上限保留, 但超过 14 字改成 ~13 字断两行(drawtext textfile 支持真实换行) —
 *    比原来"截 26 字塞一行"更抓人; 单行时长标题字太小/两行都溢出的问题一并解决。
 */
export function wrapIntroTitle(title: string): string {
  const t = escFf(title || "");
  if (t.length <= 14) return t;
  const head = t.slice(0, 13);
  const tail = t.slice(13);
  return `${head}\n${tail}`;
}

/** 6-26 混剪 BGM: 从 DVH_BGM_DIR 按 seed 随机选一曲(老韩放曲到该目录); 无目录/无曲则跳过(不阻塞)。 */
async function resolveBgm(seed: number): Promise<string | undefined> {
  const dir = process.env.DVH_BGM_DIR || process.env.BGM_DIR;
  if (!dir) return undefined;
  try {
    const files = (await readdir(dir)).filter((f) => /\.(mp3|m4a|aac|wav)$/i.test(f));
    if (files.length === 0) return undefined;
    return join(dir, files[Math.abs(seed) % files.length]!);
  } catch { return undefined; }
}

export async function probeVideo(file: string): Promise<{ w: number; h: number; dur: number }> {
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

/**
 * ① 片头背景图落地: 本地已存在的路径直接用; URL(/storage/ 或 http) 下载到 workDir。
 *    任何失败返回 undefined → 片头回退纯色, 不阻塞。
 */
async function resolveIntroBg(introBgUrl: string, workDir: string): Promise<string | undefined> {
  try {
    if (!/^https?:\/\//i.test(introBgUrl) && !introBgUrl.startsWith("/storage/")) {
      await stat(introBgUrl); // 本地路径(remix-assets 已下载好的封面)
      return introBgUrl;
    }
    const dst = join(workDir, "intro-bg.img");
    await downloadToFile(introBgUrl, dst);
    return dst;
  } catch (err) {
    logger.warn({ introBgUrl, err: err instanceof Error ? err.message : err }, "dvh.remix.intro_bg_skip");
    return undefined;
  }
}

/** ④ 剔除不存在的 B-roll 路径, 最多 3 张。 */
async function filterBroll(paths: string[] | undefined): Promise<string[]> {
  if (!paths?.length) return [];
  const ok: string[] = [];
  for (const p of paths.slice(0, 3)) {
    try { await stat(p); ok.push(p); } catch { /* 素材缺失直接跳过, 不阻塞 */ }
  }
  return ok;
}

interface BrollSlot { start: number; seg: number; }

/**
 * ④ B-roll 排期(seed 驱动): 全部落在主视频 25%~80% 区间(避开片头/片尾 xfade),
 *    每段 2.6~3.2s, 多张互不重叠且间隔 ≥5s(把区间均分成 slot, 抖动上限扣掉段长+最小间隔,
 *    数学上保证任意相邻两段 gap ≥ 5s)。放不下就少放, 一张都放不下返回空。
 */
export function planBrollSlots(r: () => number, mainDur: number, mainStart: number, count: number): BrollSlot[] {
  const MIN_GAP = 5, SEG_MIN = 2.6, SEG_MAX = 3.2;
  const spanStart = mainStart + mainDur * 0.25;
  const span = mainDur * 0.55; // 25%~80%
  const n = Math.min(count, 3, Math.floor((span + MIN_GAP) / (SEG_MAX + MIN_GAP)));
  if (n <= 0) return [];
  const slot = span / n;
  const out: BrollSlot[] = [];
  for (let i = 0; i < n; i++) {
    const seg = +(SEG_MIN + r() * (SEG_MAX - SEG_MIN)).toFixed(3);
    const jitterMax = Math.max(0, slot - seg - MIN_GAP);
    const start = +(spanStart + i * slot + r() * jitterMax).toFixed(3);
    out.push({ start, seg });
  }
  return out;
}

/** 偶数化(yuv420p 尺寸必须偶数)。 */
const even = (n: number) => 2 * Math.ceil(n / 2);

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
    const { w, h, dur } = await probeVideo(inMp4);

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

    await writeFile(titleTxt, wrapIntroTitle(title));
    await writeFile(ctaTxt, escFf(cta || "关注我，投稿少踩坑"));

    const bgmPath = await resolveBgm(seed);
    // ① 片头背景图 + ④ B-roll 素材(全部可缺省, 缺了回退老观感)
    const introBgPath = opts.introBgUrl ? await resolveIntroBg(opts.introBgUrl, workDir) : undefined;
    const brollFiles = await filterBroll(opts.brollPaths);
    const brollSlots = planBrollSlots(r, dur, off1, brollFiles.length);
    const brolls = brollSlots.map((s, i) => ({ ...s, file: brollFiles[i]! }));

    /**
     * 组装 ffmpeg 参数。enhanced=false 是 6-26 老滤镜图原样保留 —
     * 为什么留两套: 增强图(图片片头/ducking/overlay)滤镜面更宽, 任何一处在某台机器/某个素材上
     * 跑挂都不该导致这条片废掉, 降级重跑老图比直接回原片多保住 90% 的混剪价值。
     */
    const buildArgs = (enhanced: boolean) => {
      const introFontSize = enhanced ? Math.round(w / 14) : Math.round(w / 24);
      const borderW = Math.max(2, Math.round(w / 270)); // 1080 宽 ≈ 4px 黑描边
      const titleDraw = enhanced
        ? `drawtext=fontfile='${FONT}':textfile='${titleTxt}':fontcolor=white:fontsize=${introFontSize}:borderw=${borderW}:bordercolor=black:line_spacing=${Math.round(w / 90)}:x=(w-text_w)/2:y=(h-text_h)/2`
        : `drawtext=fontfile='${FONT}':textfile='${titleTxt}':fontcolor=white:fontsize=${introFontSize}:line_spacing=8:x=(w-text_w)/2:y=(h-text_h)/2`;

      // ① 片头: 有图 → 铺满(等比放大裁切) + eq 压暗当底; 无图 → 纯色。整段 fade in 0.4s 更抓人。
      const useIntroImg = enhanced && !!introBgPath;
      const introChain = useIntroImg
        ? `[1:v]fps=25,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},eq=brightness=-0.28,setsar=1,format=yuv420p,${titleDraw},fade=t=in:d=0.4,settb=AVTB[intro];`
        : `[1:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,${titleDraw}${enhanced ? ",fade=t=in:d=0.4" : ""},settb=AVTB[intro];`;

      // ③ BGM: 老图 volume=0.16 死压; 增强图 sidechaincompress — BGM 基线提到 0.30,
      //   人声(delay 对齐后 asplit 一路)当 sidechain 自动压下, 人声停顿/片头片尾自然浮起。
      //   sidechain 输入顺序: [被压的 BGM][控制信号人声]; 人声侧链 apad 铺满, 避免人声先结束把 BGM 截断。
      let audioFc: string;
      if (!bgmPath) {
        audioFc = `[0:a]adelay=${delayMs}|${delayMs},apad[aout]`;
      } else if (enhanced) {
        // 注意: 4.4 的 sidechaincompress 不会自动协商两路输入格式(实测直接报
        // "could not choose their formats"), 必须两路都显式 aformat 到 dbl/44100/stereo。
        audioFc =
          `[0:a]adelay=${delayMs}|${delayMs},asplit=2[amain][avraw];` +
          `[avraw]apad,aformat=sample_fmts=dbl:sample_rates=44100:channel_layouts=stereo[avduck];` +
          `[3:a]volume=0.30,aformat=sample_fmts=dbl:sample_rates=44100:channel_layouts=stereo[bgin];` +
          `[bgin][avduck]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[bgduck];` +
          `[amain][bgduck]amix=inputs=2:duration=longest:dropout_transition=500[aout]`;
      } else {
        audioFc = `[0:a]adelay=${delayMs}|${delayMs}[amain];[3:a]volume=0.16[bg];[amain][bg]amix=inputs=2:duration=longest:dropout_transition=500[aout]`;
      }

      // ④ B-roll: 只在增强图。每张图: 放大 1.08 倍→crop 随 t 平移(比 zoompan 省资源)→
      //   fade in/out 0.35s→setpts 平移到插入时刻; overlay 用 enable 精确开窗, 主轴帧/音频不动。
      const useBroll = enhanced && brolls.length > 0;
      const brollBase = bgmPath ? 4 : 3; // 输入序: 0=主片 1=片头 2=片尾 [3=BGM] 之后是 B-roll 图
      const sw = even(w * 1.08), sh = even(h * 1.08);
      let brollChains = "";
      let lastLabel = "vv";
      if (useBroll) {
        brolls.forEach((b, i) => {
          const idx = brollBase + i;
          const fadeOutSt = +(b.seg - 0.35).toFixed(3);
          brollChains +=
            `[${idx}:v]fps=25,scale=${sw}:${sh}:force_original_aspect_ratio=increase,` +
            `crop=${w}:${h}:x='(iw-ow)*min(t/${b.seg}\\,1)':y=(ih-oh)/2,setsar=1,format=yuv420p,` +
            `fade=t=in:st=0:d=0.35,fade=t=out:st=${fadeOutSt}:d=0.35,setpts=PTS-STARTPTS+${b.start}/TB[b${i}];`;
        });
        brolls.forEach((b, i) => {
          const src = i === 0 ? "vv" : `ov${i - 1}`;
          const dst = `ov${i}`;
          const end = +(b.start + b.seg).toFixed(3);
          brollChains += `[${src}][b${i}]overlay=eof_action=pass:enable='between(t\\,${b.start}\\,${end})'[${dst}];`;
          lastLabel = dst;
        });
      }

      const fc =
        `[0:v]fps=25,scale=iw*${zoom}:ih*${zoom},crop=${w}:${h},setsar=1,format=yuv420p,settb=AVTB[mainv];` +
        introChain +
        `[2:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,drawtext=fontfile='${FONT}':textfile='${ctaTxt}':fontcolor=white:fontsize=${Math.round(w / 26)}:x=(w-text_w)/2:y=(h-text_h)/2,settb=AVTB[outro];` +
        `[intro][mainv]xfade=transition=${t1}:duration=${xf}:offset=${off1}[vx];` +
        `[vx][outro]xfade=transition=${t2}:duration=${xf}:offset=${off2}[vv];` +
        brollChains +
        audioFc;

      const args = [
        "-y", "-i", inMp4,
        // 片头输入: 图片(loop 成 introDur 视频流) 或 lavfi 纯色
        ...(useIntroImg
          ? ["-framerate", "25", "-loop", "1", "-t", introDur.toFixed(2), "-i", introBgPath!]
          : ["-f", "lavfi", "-t", introDur.toFixed(2), "-i", `color=c=${introCol}:s=${w}x${h}:r=25`]),
        "-f", "lavfi", "-t", outroDur.toFixed(2), "-i", `color=c=${outroCol}:s=${w}x${h}:r=25`,
        ...(bgmPath ? ["-stream_loop", "-1", "-i", bgmPath] : []),  // input #3 = BGM(循环)
        ...(useBroll ? brolls.flatMap((b) => ["-framerate", "25", "-loop", "1", "-t", b.seg.toFixed(3), "-i", b.file]) : []),
        "-filter_complex", fc,
        "-map", `[${useBroll ? lastLabel : "vv"}]`, "-map", "[aout]", "-t", total.toFixed(2),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-movflags", "+faststart", outMp4,
      ];
      return args;
    };

    logger.info(
      { taskUuid, seed, dur, total, t1, t2, introBg: !!introBgPath, brolls: brolls.map((b) => ({ start: b.start, seg: b.seg })), ducking: !!bgmPath },
      "dvh.remix.start",
    );
    try {
      await runFFmpeg(buildArgs(true));
    } catch (err) {
      // 增强图挂了(滤镜不兼容/素材损坏/超时等) → 降级老图重跑, 保住基础混剪, 绝不因新能力阻塞出片
      logger.warn({ taskUuid, err: err instanceof Error ? err.message : err }, "dvh.remix.enhanced_failed_downgrade");
      await runFFmpeg(buildArgs(false));
    }

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
