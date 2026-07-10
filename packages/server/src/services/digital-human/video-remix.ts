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
 *
 * 7-10 混剪新意批次(老韩反馈"没有太多新意"):
 *   ⑥ 片头模板池: 4 套版式(A 现款/B 色块标题条/C 数据大字卡/D 大字报), seed+clipStyle 加权选,
 *      版式逻辑独立在 intro-templates.ts(零依赖, 可单测/沙盒烧帧)。
 *   ⑦ 卡点转场: clipStyle 带 bpm(popsci 110/marketing 128)且有 BGM 时, B-roll 起止 + 片尾 xfade
 *      吸附节拍网格(beat-grid.ts); calm/无 BGM 回退原随机。
 *   ⑧ 自动封面: 成片渲染完从片头 t=1s 抽一帧 jpg 传 OSS, RemixResult.coverUrl 带回 —
 *      发布链路(公众号 thumb/抖音 cover)有真封面可用。抽帧失败不影响出片。
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storage } from "../storage/index.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { CLIP_STYLES, isClipStyleKey } from "../video/clip-styles.js";
import {
  ACCENT_COLORS,
  buildIntroFilter,
  pickIntroTemplate,
  sanitizeDrawtext,
  wrapTitleForTemplate,
} from "./intro-templates.js";
import { planBrollSlots, snapToBeat, type BeatGrid } from "./beat-grid.js";

// 兼容旧引用: 这两个原本在本文件定义, 7-10 拆到零依赖小模块(便于单测/烧帧脚本), 出口保持不变
export { wrapIntroTitle } from "./intro-templates.js";
export { planBrollSlots } from "./beat-grid.js";

export interface RemixOptions {
  videoUrl: string;   // DVH 原视频 URL
  title: string;      // 片头标题(取文章标题)
  cta?: string;       // 片尾 CTA 文案
  taskUuid?: string;  // 用于 OSS key / 日志
  seed?: number;      // 随机种子: 不同账号传不同 seed → 不同成片
  introBgUrl?: string;   // ① 片头背景图(URL/本地路径, 如期刊封面); 拿不到/下载失败回退纯色
  brollPaths?: string[]; // ④ B-roll 本地图片路径(1-3 张, 如期刊封面/图表 PNG); 无效路径自动剔除
  clipStyle?: string;    // ⑦ 剪辑风格 key(clip-styles): 参与片头模板加权 + 卡点 BPM + BGM 子目录; 非法值忽略
  journalStats?: { ifText?: string; partitionText?: string }; // ⑥ 模板 C 数据大字素材(如 "IF 26.3"/"中科院医学1区")
}
export interface RemixResult {
  videoUrl: string;   // 混剪后 URL(失败时回原 URL)
  remixed: boolean;
  coverUrl?: string;  // ⑧ 片头抽帧封面 URL(仅 remixed=true 且抽帧成功时有)
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
const escFf = sanitizeDrawtext; // 原地实现搬到 intro-templates(零依赖模块), 本地别名保持下文可读

/**
 * 6-26 混剪 BGM: 从 DVH_BGM_DIR 按 seed 随机选一曲(老韩放曲到该目录); 无目录/无曲则跳过(不阻塞)。
 * 7-10: 传了 bgmTag(clip-styles 风格子目录, 如 upbeat/energetic)则优先从 DVH_BGM_DIR/<bgmTag>/ 选 —
 *   卡点吸附用的 bpm 是按风格标称的, 曲子也得来自对应节奏的曲库才踩得准; 子目录不存在回退根目录。
 */
async function resolveBgm(seed: number, bgmTag?: string): Promise<string | undefined> {
  const base = process.env.DVH_BGM_DIR || process.env.BGM_DIR;
  if (!base) return undefined;
  const dirs = bgmTag ? [join(base, bgmTag), base] : [base];
  for (const dir of dirs) {
    try {
      const files = (await readdir(dir)).filter((f) => /\.(mp3|m4a|aac|wav)$/i.test(f));
      if (files.length > 0) return join(dir, files[Math.abs(seed) % files.length]!);
    } catch { /* 子目录不存在 → 试下一个 */ }
  }
  return undefined;
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

/** 偶数化(yuv420p 尺寸必须偶数)。 */
const even = (n: number) => 2 * Math.ceil(n / 2);

/**
 * ⑧ 自动封面: 从成片(片头段, 默认 t=1.0s — introDur 最短 2.2s, 必落在片头画面内)抽一帧 jpg。
 *    发布平台(公众号 thumb / 抖音 cover)要封面图, 以前视频内容没封面只能靠平台自动取首帧(黑帧/糊帧居多)。
 *    任何失败返回 false, 调用方跳过封面 — 绝不影响出片。
 */
export async function extractCoverFrame(videoFile: string, outJpg: string, atSec = 1.0): Promise<boolean> {
  try {
    // -ss 放 -i 前 = 输入侧粗跳(快); 只解 1 帧, 2核4G 上耗时 <1s
    await runFFmpeg(["-y", "-ss", atSec.toFixed(2), "-i", videoFile, "-frames:v", "1", "-q:v", "3", outJpg]);
    await stat(outJpg);
    return true;
  } catch (err) {
    logger.warn({ videoFile, err: err instanceof Error ? err.message : err }, "dvh.remix.cover_extract_failed");
    return false;
  }
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
    const { w, h, dur } = await probeVideo(inMp4);

    const r = rng(seed);
    const pick = <T,>(arr: T[]) => arr[Math.floor(r() * arr.length) % arr.length]!;
    const introDur = 2.2 + r() * 0.8;            // 2.2~3.0s
    const outroDur = 1.6 + r() * 0.8;            // 1.6~2.4s
    const xf = 0.6;
    const zoom = (1.0 + r() * 0.03).toFixed(4);  // 1.00~1.03 轻微缩放, 变每帧指纹, 不动音频
    const introCol = pick(INTRO_COLORS), outroCol = pick(OUTRO_COLORS);
    const accentCol = pick(ACCENT_COLORS);       // ⑥ 片头点缀色(色条/大字)
    const t1 = pick(TRANSITIONS), t2 = pick(TRANSITIONS);
    const off1 = +(introDur - xf).toFixed(3);          // 主视频/音频 t0 落点
    const v1Dur = off1 + dur;
    const delayMs = Math.round(off1 * 1000);

    // ⑦ 卡点转场: clipStyle 合法且预设带 bpm(popsci/marketing)才建节拍网格; 原点 = 主视频起点 off1。
    //   calm 风格(academic/data)无强节拍不设 bpm, 无 BGM 更谈不上卡点 → beat 为空 = 完全走老随机。
    const stylePreset = opts.clipStyle && isClipStyleKey(opts.clipStyle) ? CLIP_STYLES[opts.clipStyle] : undefined;
    const bgmPath = await resolveBgm(seed, stylePreset?.bgmTag);
    const beat: BeatGrid | undefined = bgmPath && stylePreset?.bpm
      ? { origin: off1, beatDur: 60 / stylePreset.bpm }
      : undefined;

    // 片尾 xfade 时刻吸拍: 只向前吸(floor) — 向后吸会把 offset 推过主视频末尾, ffmpeg 直接报错。
    //   向前吸意味着片尾转场提前 ≤1 拍盖住主视频最后几帧; 限制 ≤0.35s(半拍多点), 超过就放弃吸附 —
    //   口型/最后一句话完整 > 卡点(音频主轴完全不动, 只是画面转场提前, 且 outroDur≥1.6s > 提前量+xf, 音频不会被 -t 截断)。
    let off2 = +(v1Dur - xf).toFixed(3);
    if (beat) {
      const snapped = snapToBeat(off2, beat, 1, "floor");
      if (off2 - snapped <= 0.35) off2 = snapped;
    }
    const total = +(off2 + outroDur).toFixed(3);

    // ⑥ 片头模板池: 先解析封面(有无图决定候选池), 再 seed+clipStyle 加权选模板, 标题按模板断行。
    const introBgPath = opts.introBgUrl ? await resolveIntroBg(opts.introBgUrl, workDir) : undefined;
    const statsBig = opts.journalStats?.ifText || opts.journalStats?.partitionText; // C 的大字: IF 优先, 没 IF 用分区顶
    const statsSmall = opts.journalStats?.ifText ? opts.journalStats?.partitionText : undefined;
    const template = pickIntroTemplate(r, { hasCover: !!introBgPath, hasStats: !!statsBig, clipStyle: opts.clipStyle });
    const titleWrapped = wrapTitleForTemplate(template, title);
    await writeFile(titleTxt, titleWrapped);
    await writeFile(ctaTxt, escFf(cta || "关注我，投稿少踩坑"));
    let statsCtx: { bigFile: string; bigText: string; smallFile?: string; smallText?: string } | undefined;
    if (statsBig) {
      const bigFile = join(workDir, "stats-big.txt");
      await writeFile(bigFile, escFf(statsBig));
      statsCtx = { bigFile, bigText: escFf(statsBig) };
      if (statsSmall) {
        const smallFile = join(workDir, "stats-small.txt");
        await writeFile(smallFile, escFf(statsSmall));
        statsCtx.smallFile = smallFile;
        statsCtx.smallText = escFf(statsSmall);
      }
    }
    // 获客-2: 片尾 outro 叠企微客服二维码(固定素材, env WECOM_KF_QR_URL)。下载失败/未配置 → 不叠, 片尾照旧。
    let qrPath: string | undefined;
    if (env.WECOM_KF_QR_URL) {
      try { const p = join(workDir, "kf-qr.png"); await downloadToFile(env.WECOM_KF_QR_URL, p); qrPath = p; }
      catch (e) { logger.warn({ taskUuid, err: e instanceof Error ? e.message : e }, "dvh.remix.kf_qr_download_failed"); }
    }
    const brollFiles = await filterBroll(opts.brollPaths);
    // ⑦ beat 非空时 B-roll 起止吸附节拍网格; 空则与原随机行为逐 bit 一致
    const brollSlots = planBrollSlots(r, dur, off1, brollFiles.length, beat);
    const brolls = brollSlots.map((s, i) => ({ ...s, file: brollFiles[i]! }));

    /**
     * 组装 ffmpeg 参数。enhanced=false 是 6-26 老滤镜图原样保留 —
     * 为什么留两套: 增强图(图片片头/ducking/overlay)滤镜面更宽, 任何一处在某台机器/某个素材上
     * 跑挂都不该导致这条片废掉, 降级重跑老图比直接回原片多保住 90% 的混剪价值。
     */
    const buildArgs = (enhanced: boolean) => {
      // ⑥ 片头: 增强图走模板池(intro-templates 4 套版式); 降级图保持 6-26 老样式(小字居中纯色)。
      //   只有 A/B 吃封面图输入; C(数据大字卡)/D(大字报) 恒用 lavfi 纯色底(C 特意要深色衬大字)。
      const useIntroImg = enhanced && !!introBgPath && (template === "A" || template === "B");
      const titleDraw = `drawtext=fontfile='${FONT}':textfile='${titleTxt}':fontcolor=white:fontsize=${Math.round(w / 24)}:line_spacing=8:x=(w-text_w)/2:y=(h-text_h)/2`;
      const introChain = enhanced
        ? buildIntroFilter(template, {
            w, h, font: FONT,
            introColor: introCol, accentColor: accentCol,
            titleFile: titleTxt, titleLines: titleWrapped.split("\n").length,
            hasImage: useIntroImg, stats: statsCtx,
          })
        : `[1:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,${titleDraw},settb=AVTB[intro];`;

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

      // ⑤ 片尾 outro: CTA 文字 +(有二维码时)客服二维码。二维码只在增强图叠, 降级图不叠(与其余增强能力同进退)。
      //   二维码只在纯色片尾帧上, 不在主视频/数字人画面上 → 结构上不可能压口型。lanczos 缩放保清晰不糊。
      const useQr = enhanced && !!qrPath;
      const qrSize = even(Math.round(Math.min(w, h) / 3)); // 竖屏/横屏都 ≈ min 边 1/3, 够扫
      const ctaY = useQr ? `(h-text_h)/2-${Math.round(h * 0.14)}` : `(h-text_h)/2`; // 有二维码则 CTA 上移腾位
      const outroDraw = `drawtext=fontfile='${FONT}':textfile='${ctaTxt}':fontcolor=white:fontsize=${Math.round(w / 26)}:x=(w-text_w)/2:y=${ctaY}`;
      const outroChain = useQr
        ? `[2:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,${outroDraw},settb=AVTB[outrobg];` +
          `movie='${qrPath!.replace(/:/g, "\\:")}',scale=${qrSize}:${qrSize}:flags=lanczos,format=rgba[kfqr];` +
          `[outrobg][kfqr]overlay=x=(W-w)/2:y=${Math.round(h * 0.50)}[outro];`
        : `[2:v]fps=25,scale=${w}:${h},setsar=1,format=yuv420p,${outroDraw},settb=AVTB[outro];`;

      const fc =
        `[0:v]fps=25,scale=iw*${zoom}:ih*${zoom},crop=${w}:${h},setsar=1,format=yuv420p,settb=AVTB[mainv];` +
        introChain +
        outroChain +
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
      {
        taskUuid, seed, dur, total, t1, t2, template, introBg: !!introBgPath,
        brolls: brolls.map((b) => ({ start: b.start, seg: b.seg })), ducking: !!bgmPath,
        beat: beat ? { bpm: stylePreset?.bpm, origin: beat.origin, off2 } : undefined,
      },
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

    // ⑧ 自动封面: 片头 t=1.0s 抽帧 → OSS。整段包 try, 失败只 warn, 出片照常。
    let coverUrl: string | undefined;
    try {
      const coverJpg = join(workDir, "cover.jpg");
      if (await extractCoverFrame(outMp4, coverJpg)) {
        const coverBuf = await readFile(coverJpg);
        coverUrl = await storage.upload(coverBuf, `dvh-videos/cover-${taskUuid || Date.now()}-${seed}.jpg`, "image/jpeg");
      }
    } catch (err) {
      logger.warn({ taskUuid, err: err instanceof Error ? err.message : err }, "dvh.remix.cover_upload_failed");
    }

    logger.info({ taskUuid, seed, newUrl, coverUrl, bytes: buffer.length }, "dvh.remix.done");
    return { videoUrl: newUrl, remixed: true, ...(coverUrl ? { coverUrl } : {}) };
  } catch (err) {
    logger.warn({ taskUuid, err: err instanceof Error ? err.message : err }, "dvh.remix.failed_fallback");
    return { videoUrl, remixed: false };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
