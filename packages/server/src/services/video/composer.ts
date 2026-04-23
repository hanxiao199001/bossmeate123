/**
 * Video Composer - 使用 FFmpeg 将素材 + TTS + BGM 合成为最终视频
 *
 * 期刊科普短视频模式：
 *  - 每个场景底部 25% 为半透明黑色信息卡
 *  - 卡内展示：中文名 / 英文名 / 影响因子+分区 / 审稿周期+录用率
 *  - 顶部可选：场景旁白字幕
 *
 * 依赖系统已安装 ffmpeg（通过 PATH 调用）。
 */

import { spawn } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { storage } from "../storage/index.js";

/** resolve BGM path to absolute + check exists, return null if missing */
async function resolveBgmPath(p: string | undefined | null): Promise<string | null> {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  try { await access(abs); return abs; } catch { return null; }
}

/** 解析中文可渲染字体路径，顺序：env → Linux Noto/WQY → macOS 本机 */
let cachedFontPath: string | null | undefined = undefined;
async function resolveFontPath(): Promise<string | null> {
  if (cachedFontPath !== undefined) return cachedFontPath;
  const candidates = [
    env.VIDEO_FONT_PATH,
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try { await access(p); cachedFontPath = p; return p; } catch {}
  }
  cachedFontPath = null;
  logger.warn("未找到可用中文字体，drawtext 字幕将使用默认字体（中文可能乱码）");
  return null;
}

/** 期刊信息卡数据（composer 按约定的布局渲染） */
export interface JournalInfoCard {
  nameCn?: string | null;
  nameEn?: string | null;
  impactFactor?: number | null;
  partition?: string | null;        // Q1/Q2/Q3/Q4
  casPartition?: string | null;     // 中科院分区，如 "医学2区"
  reviewCycle?: string | null;
  acceptanceRate?: number | null;   // 0-100 或 0-1（两种都兼容）
}

export interface ComposerScene {
  /** 图片本地路径 或 http URL；http 会先下载到 temp */
  imageSource: string;
  /** 语音本地路径 或 http URL */
  voiceoverSource: string;
  durationMs: number;
  /** 叠加字幕（场景旁白，会显示在信息卡底部） */
  subtitle?: string;
  /** 期刊信息卡（存在时启用科普视频样式）；V2 card scenes 不使用 */
  journalInfo?: JournalInfoCard;
  /** V2: 场景类型（信息卡已预生成在 imageSource 中） */
  sceneType?: string;
}

export interface ComposeRequest {
  tenantId: string;
  scenes: ComposerScene[];
  bgmPath?: string;
  resolution?: string;  // 默认 env.VIDEO_RESOLUTION
  fps?: number;
}

export interface ComposeResult {
  url: string;
  remotePath: string;
  localPath: string;
  durationMs: number;
  sizeBytes: number;
}

export class VideoComposer {
  async compose(req: ComposeRequest): Promise<ComposeResult> {
    const resolution = req.resolution ?? env.VIDEO_RESOLUTION;
    const fps = req.fps ?? 30;
    const [resW, resH] = resolution.split("x").map(Number);

    const workDir = await mkdtemp(path.join(tmpdir(), "bossmate-video-"));
    const fontPath = await resolveFontPath();
    try {
      // 1. 下载远程素材至本地
      const preparedScenes: Array<{
        image: string;
        voice: string;
        durationMs: number;
        subtitle?: string;
        journalInfo?: JournalInfoCard;
        sceneType?: string;
      }> = [];

      for (let i = 0; i < req.scenes.length; i++) {
        const s = req.scenes[i];
        const img = await this.materialize(s.imageSource, workDir, `img${i}`);
        const voice = await this.materialize(s.voiceoverSource, workDir, `voice${i}`);
        preparedScenes.push({
          image: img,
          voice,
          durationMs: s.durationMs,
          subtitle: s.subtitle,
          journalInfo: s.journalInfo,
          sceneType: s.sceneType,
        });
      }

      // 2. 逐场景生成 mp4（含期刊信息卡 drawtext）
      const sceneMp4s: string[] = [];
      for (let i = 0; i < preparedScenes.length; i++) {
        const s = preparedScenes[i];
        const out = path.join(workDir, `scene${i}.mp4`);
        const durSec = (s.durationMs / 1000).toFixed(3);

        // 缩放 + 裁剪到目标分辨率
        const scaleCrop = `scale=${resW}:${resH}:force_original_aspect_ratio=increase,crop=${resW}:${resH}`;
        // V2 卡片场景：只叠字幕；普通场景：叠期刊信息卡
        const overlayFilter = s.sceneType
          ? buildCardSubtitleFilter(s.subtitle, fontPath, resW, resH)
          : buildJournalCardFilter(s.journalInfo, s.subtitle, fontPath, resW, resH);
        const vf = overlayFilter ? `${scaleCrop},${overlayFilter}` : scaleCrop;

        const args = [
          "-y",
          "-loop", "1",
          "-i", s.image,
          "-i", s.voice,
          "-t", durSec,
          "-vf", vf,
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-r", String(fps),
          "-c:a", "aac",
          "-shortest",
          out,
        ];
        await this.runFfmpeg(args);
        sceneMp4s.push(out);
      }

      // 3. xfade 转场合并场景（含音频 concat）
      const merged = path.join(workDir, "merged.mp4");
      if (sceneMp4s.length === 1) {
        await this.runFfmpeg(["-y", "-i", sceneMp4s[0], "-c", "copy", merged]);
      } else {
        const xfadeInputs = sceneMp4s.flatMap(p => ["-i", p]);
        const durations = preparedScenes.map(s => s.durationMs / 1000);
        const xfade = buildXfadeFilterGraph(durations, 0.5, "fade");
        const audioParts = preparedScenes.map((_, i) => `[${i}:a]`).join("");
        const mergeFilter = `${xfade.filterComplex};${audioParts}concat=n=${sceneMp4s.length}:v=0:a=1[aout]`;
        await this.runFfmpeg([
          "-y", ...xfadeInputs,
          "-filter_complex", mergeFilter,
          "-map", `[${xfade.outputLabel}]`,
          "-map", "[aout]",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(fps),
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart",
          merged,
        ]);
      }

      // 4. 叠加 BGM（可选）
      const finalPath = path.join(workDir, "final.mp4");
      const bgm = await resolveBgmPath(req.bgmPath) ?? await resolveBgmPath(env.BGM_DEFAULT_PATH);
      if (bgm) {
        await this.runFfmpeg([
          "-y",
          "-i", merged,
          "-i", bgm,
          "-filter_complex",
          "[1:a]volume=0.15[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2",
          "-c:v", "copy",
          finalPath,
        ]);
      } else {
        await this.runFfmpeg(["-y", "-i", merged, "-c", "copy", finalPath]);
      }

      // 5. 上传
      const buf = await readFile(finalPath);
      const remotePath = `videos/${req.tenantId}/${Date.now()}.mp4`;
      const url = await storage.upload(buf, remotePath, "video/mp4");
      const st = await stat(finalPath);

      return {
        url,
        remotePath,
        localPath: finalPath,
        durationMs: preparedScenes.reduce((s, x) => s + x.durationMs, 0),
        sizeBytes: st.size,
      };
    } finally {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err, workDir }, "临时目录清理失败");
      }
    }
  }

  private async materialize(
    source: string,
    workDir: string,
    namePrefix: string
  ): Promise<string> {
    // LocalStorage URL（/storage/xxx）→ 转成磁盘绝对路径
    if (source.startsWith("/storage/")) {
      const relativePath = source.replace("/storage/", "");
      const diskPath = path.resolve(env.UPLOAD_DIR, "storage", relativePath);
      try {
        await access(diskPath);
        return diskPath;
      } catch {
        throw new Error(`本地存储文件不存在: ${diskPath} (原始: ${source})`);
      }
    }
    if (/^https?:\/\//i.test(source)) {
      const resp = await fetch(source);
      if (!resp.ok) throw new Error(`下载素材失败: ${resp.status} ${source}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const ext = this.inferExt(source, resp.headers.get("content-type"));
      const p = path.join(workDir, `${namePrefix}.${ext}`);
      await writeFile(p, buf);
      return p;
    }
    return source;
  }

  private inferExt(url: string, contentType: string | null): string {
    const m = url.match(/\.([a-z0-9]{2,4})(?:\?|#|$)/i);
    if (m) return m[1].toLowerCase();
    if (contentType?.includes("jpeg")) return "jpg";
    if (contentType?.includes("png")) return "png";
    if (contentType?.includes("mpeg")) return "mp3";
    if (contentType?.includes("wav")) return "wav";
    return "bin";
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.debug({ args }, "ffmpeg");
      const proc = spawn(env.FFMPEG_PATH, args);
      let stderr = "";
      proc.stderr.on("data", (c) => {
        stderr += c.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-500)}`));
      });
    });
  }

  // ============ 图片轮播视频合成（composeSlideshow）============

  /**
   * 从图片序列合成简约商务风格宣传视频
   */
  async composeSlideshow(req: SlideshowRequest): Promise<SlideshowResult> {
    const resolution = req.resolution ?? env.VIDEO_RESOLUTION;
    const fps = req.fps ?? 30;
    const [resW, resH] = resolution.split("x").map(Number);
    const transitionSec = (req.transitionDurationMs ?? 800) / 1000;
    const transition = req.transition ?? "fade";

    const workDir = await mkdtemp(path.join(tmpdir(), "bossmate-slideshow-"));
    logger.info({ workDir, scenes: req.scenes.length, resolution }, "开始合成轮播视频");

    try {
      // ── Step 1: sharp 预 resize（逐张，控内存） ──
      const fontPath = await resolveFontPath();
      const preparedImages: string[] = [];
      for (let i = 0; i < req.scenes.length; i++) {
        const scene = req.scenes[i];
        const outPath = path.join(workDir, `prep${i}.png`);

        if (!scene.imageSource) {
          // remotePath 为空：生成带标题文字的深色占位图，跳过 sharp
          logger.warn({ sceneIndex: i, title: scene.title }, "场景图片路径为空，生成占位图");
          await this.generateScenePlaceholder(outPath, scene.title, resW * 2, resH * 2, fontPath);
        } else {
          const srcPath = await this.materialize(scene.imageSource, workDir, `raw${i}`);
          await sharp(srcPath)
            .rotate() // EXIF 校正
            .resize(resW * 2, resH * 2, { fit: "cover", withoutEnlargement: false })
            .png()
            .toFile(outPath);
        }

        preparedImages.push(outPath);
        if (req.onProgress) req.onProgress(Math.round((i / req.scenes.length) * 30) + 5);
      }

      // ── Step 2: 逐场景 zoompan → 单场景 mp4 ──
      const sceneMp4s: string[] = [];
      for (let i = 0; i < req.scenes.length; i++) {
        const scene = req.scenes[i];
        const durSec = scene.durationMs / 1000;
        const frames = Math.round(durSec * fps);
        const outMp4 = path.join(workDir, `scene${i}.mp4`);

        // Ken Burns: 交替 zoom-in / zoom-out
        const anim = scene.animation ?? (i % 2 === 0 ? "kenburns_in" : "kenburns_out");
        const zoomExpr = anim === "kenburns_out"
          ? `if(eq(on,1),1.15,max(zoom-0.0008,1.0))`
          : `min(zoom+0.0008,1.15)`;

        let vf = `zoompan=z='${zoomExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${resolution}:fps=${fps}`;

        // 文字叠加（可选）
        if (scene.title) {
          const escaped = escapeDrawtext(scene.title);
          const fontArg = fontPath ? `:fontfile=${fontPath.replace(/:/g, "\\:")}` : "";
          vf += `,drawtext=text='${escaped}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=h*0.78:box=1:boxcolor=black@0.3:boxborderw=20${fontArg}`;
        }

        const args = [
          "-y",
          "-i", preparedImages[i],
          "-vf", vf,
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-preset", "medium",
          "-crf", "21",
          "-profile:v", "high",
          "-level", "4.1",
          "-an",
          outMp4,
        ];
        await this.runFfmpeg(args);
        sceneMp4s.push(outMp4);
        if (req.onProgress) req.onProgress(Math.round(30 + (i / req.scenes.length) * 35));
      }

      // ── Step 3: xfade 级联转场拼接 ──
      let mergedPath: string;
      if (sceneMp4s.length === 1) {
        mergedPath = sceneMp4s[0];
      } else if (transition === "none") {
        // 无转场 → concat
        const concatList = path.join(workDir, "concat.txt");
        await writeFile(concatList, sceneMp4s.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
        mergedPath = path.join(workDir, "merged.mp4");
        await this.runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", mergedPath]);
      } else {
        // xfade 级联
        mergedPath = path.join(workDir, "merged.mp4");
        const xfadeGraph = buildXfadeFilterGraph(
          req.scenes.map(s => s.durationMs / 1000),
          transitionSec,
          transition,
        );
        const inputs = sceneMp4s.flatMap(p => ["-i", p]);
        await this.runFfmpeg([
          "-y", ...inputs,
          "-filter_complex", xfadeGraph.filterComplex,
          "-map", `[${xfadeGraph.outputLabel}]`,
          "-c:v", "libx264", "-preset", "medium", "-crf", "21",
          "-pix_fmt", "yuv420p",
          "-movflags", "+faststart",
          mergedPath,
        ]);
      }
      if (req.onProgress) req.onProgress(70);

      // ── Step 4: 混合 BGM ──
      const finalPath = path.join(workDir, "final.mp4");
      const bgm = await resolveBgmPath(req.bgmPath) ?? await resolveBgmPath(env.BGM_DEFAULT_PATH);
      if (!bgm) logger.warn({ bgmPath: req.bgmPath }, "BGM 文件不存在或未配置，跳过背景音乐");
      if (bgm) {
        await this.runFfmpeg([
          "-y",
          "-i", mergedPath,
          "-i", bgm,
          "-filter_complex",
          `[1:a]volume=0.15,afade=t=in:st=0:d=1,afade=t=out:st=999:d=2[bgm];[bgm]apad[bgmpad];[bgmpad]atrim=0:${req.scenes.reduce((s, x) => s + x.durationMs, 0) / 1000}[bgmtrim];[bgmtrim]anull[a]`,
          "-map", "0:v",
          "-map", "[a]",
          "-c:v", "copy",
          "-c:a", "aac", "-b:a", "128k",
          "-shortest",
          "-movflags", "+faststart",
          finalPath,
        ]);
      } else {
        // 无 BGM，添加静音音轨（某些播放器需要）
        await this.runFfmpeg([
          "-y", "-i", mergedPath,
          "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
          "-c:v", "copy", "-c:a", "aac", "-shortest",
          "-movflags", "+faststart",
          finalPath,
        ]);
      }
      if (req.onProgress) req.onProgress(85);

      // ── Step 5: 抽首帧封面 ──
      const coverPath = path.join(workDir, "cover.jpg");
      try {
        await this.runFfmpeg([
          "-y", "-i", finalPath, "-vframes", "1", "-q:v", "2", coverPath,
        ]);
      } catch {
        logger.warn("首帧封面提取失败，跳过");
      }

      // ── Step 6: ffprobe 读真实元数据 ──
      const probe = await this.runFfprobe(finalPath);

      // ── Step 7: 上传 ──
      const ts = Date.now();
      const videoBuf = await readFile(finalPath);
      const videoRemotePath = `videos/${req.tenantId}/${ts}.mp4`;
      const videoUrl = await storage.upload(videoBuf, videoRemotePath, "video/mp4");

      let coverUrl: string | undefined;
      let coverRemotePath: string | undefined;
      try {
        const coverBuf = await readFile(coverPath);
        coverRemotePath = `videos/${req.tenantId}/${ts}_cover.jpg`;
        coverUrl = await storage.upload(coverBuf, coverRemotePath, "image/jpeg");
      } catch { /* 封面可选 */ }

      const fileStat = await stat(finalPath);
      if (req.onProgress) req.onProgress(100);

      return {
        url: videoUrl,
        remotePath: videoRemotePath,
        localPath: finalPath,
        durationMs: Math.round((probe.durationSec ?? 0) * 1000),
        sizeBytes: fileStat.size,
        coverUrl,
        coverRemotePath,
        resolution,
        scenesCount: req.scenes.length,
      };
    } finally {
      try { await rm(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  /** 生成纯色占位图（imageSource 为空时兜底） */
  private async generateScenePlaceholder(
    outPath: string,
    title: string | undefined,
    width: number,
    height: number,
    fontPath: string | null,
  ): Promise<void> {
    const args: string[] = [
      "-y",
      "-f", "lavfi",
      "-i", `color=c=0x0d1b2a:size=${width}x${height}:rate=1`,
      "-frames:v", "1",
    ];
    if (title) {
      const text = escapeDrawtext(title).slice(0, 25);
      if (text) {
        const fontArg = fontPath ? `:fontfile=${fontPath.replace(/:/g, "\\:")}` : "";
        args.push(
          "-vf",
          `drawtext=text='${text}':fontsize=80:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.4:boxborderw=30${fontArg}`,
        );
      }
    }
    args.push(outPath);
    await this.runFfmpeg(args);
  }

  /** ffprobe 读取视频真实元数据 */
  private runFfprobe(filePath: string): Promise<{ durationSec: number | null; width: number | null; height: number | null }> {
    return new Promise((resolve) => {
      const proc = spawn(env.FFPROBE_PATH, [
        "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
      ]);
      let stdout = "";
      proc.stdout.on("data", (c) => { stdout += c.toString(); });
      proc.on("close", () => {
        try {
          const d = JSON.parse(stdout);
          const vs = d.streams?.find((s: any) => s.codec_type === "video");
          resolve({
            durationSec: d.format?.duration ? parseFloat(d.format.duration) : null,
            width: vs?.width ?? null,
            height: vs?.height ?? null,
          });
        } catch {
          resolve({ durationSec: null, width: null, height: null });
        }
      });
      proc.on("error", () => resolve({ durationSec: null, width: null, height: null }));
    });
  }
}

// ============ Slideshow 类型 ============

export interface SlideshowScene {
  imageSource: string;
  durationMs: number;
  title?: string;
  subtitle?: string;
  animation?: "kenburns_in" | "kenburns_out" | "pan_left" | "pan_right" | "static";
}

export interface SlideshowRequest {
  tenantId: string;
  scenes: SlideshowScene[];
  bgmPath?: string;
  resolution?: string;
  fps?: number;
  transition?: "fade" | "dissolve" | "none";
  transitionDurationMs?: number;
  onProgress?: (percent: number) => void;
}

export interface SlideshowResult extends ComposeResult {
  coverUrl?: string;
  coverRemotePath?: string;
  resolution: string;
  scenesCount: number;
}

// ============ 辅助函数 ============

/**
 * drawtext text= 的安全转义
 * FFmpeg filter 中，单引号包裹的字符串里无法含 ' : % \ —— 统一替换为视觉等价或移除
 */
function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "/")
    .replace(/'/g, "\u2019")       // 右单引号
    .replace(/"/g, "\u201D")       // 右双引号
    .replace(/:/g, "\uFF1A")       // 全角冒号
    .replace(/%/g, "\uFF05")       // 全角百分号
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** 期刊录用率统一归一到百分比数字 */
function formatAcceptance(rate: number | null | undefined): string | null {
  if (rate == null || Number.isNaN(rate)) return null;
  const pct = rate > 1 ? rate : rate * 100;
  return `${pct.toFixed(1)}%`;
}

/**
 * V2 卡片场景字幕 filter（字幕显示在底部 caption 区域）
 * 卡片底图已包含信息，只需叠加旁白文字
 */
export function buildCardSubtitleFilter(
  subtitle: string | undefined,
  fontPath: string | null,
  _resW: number,
  resH: number,
): string {
  if (!subtitle) return "";
  const text = escapeDrawtext(subtitle).slice(0, 50);
  if (!text) return "";
  const fontArg = fontPath ? `:fontfile=${fontPath.replace(/:/g, "\\:")}` : "";
  const y = Math.round(resH * 0.82);
  return `drawtext=text='${text}':fontsize=42:fontcolor=white:bordercolor=black:borderw=3:x=(w-text_w)/2:y=${y}${fontArg}`;
}

/**
 * 构建期刊信息卡 + 场景字幕的 drawtext filter 片段
 * 1080×1920 画布约定：底部 480px 高的半透明黑色信息卡
 */
export function buildJournalCardFilter(
  journal: JournalInfoCard | undefined,
  sceneSubtitle: string | undefined,
  fontPath: string | null,
  resW: number,
  resH: number,
): string {
  const filters: string[] = [];
  const hasJournal = journal && (
    journal.nameCn || journal.nameEn || journal.impactFactor != null ||
    journal.partition || journal.casPartition || journal.reviewCycle || journal.acceptanceRate != null
  );
  if (!hasJournal && !sceneSubtitle) return "";

  const fontArg = fontPath ? `:fontfile=${fontPath.replace(/:/g, "\\:")}` : "";

  // 信息卡背景条：底部 25%（1080×1920 时为 480px）
  const cardH = Math.round(resH * 0.25);
  const cardY = resH - cardH;
  if (hasJournal) {
    filters.push(`drawbox=y=${cardY}:w=iw:h=${cardH}:color=black@0.65:t=fill`);
  }

  // 场景旁白字幕：顶部向下 10% 位置，白字黑描边
  if (sceneSubtitle) {
    const text = escapeDrawtext(sceneSubtitle).slice(0, 60);
    if (text) {
      const y = Math.round(resH * 0.08);
      filters.push(
        `drawtext=text='${text}':fontsize=48:fontcolor=white:bordercolor=black:borderw=3:x=(w-text_w)/2:y=${y}${fontArg}`
      );
    }
  }

  if (hasJournal && journal) {
    let cursorY = cardY + Math.round(cardH * 0.08); // 卡内从上往下排

    // 中文名（主标题，大字）
    if (journal.nameCn) {
      const text = escapeDrawtext(journal.nameCn).slice(0, 30);
      filters.push(
        `drawtext=text='${text}':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=${cursorY}${fontArg}`
      );
      cursorY += 80;
    }

    // 英文名（副标题，灰字）
    if (journal.nameEn) {
      const text = escapeDrawtext(journal.nameEn).slice(0, 40);
      filters.push(
        `drawtext=text='${text}':fontsize=34:fontcolor=0xDDDDDD:x=(w-text_w)/2:y=${cursorY}${fontArg}`
      );
      cursorY += 70;
    }

    // 影响因子 + 分区
    const line1: string[] = [];
    if (journal.impactFactor != null) line1.push(`IF ${journal.impactFactor.toFixed(2)}`);
    if (journal.casPartition) line1.push(journal.casPartition);
    else if (journal.partition) line1.push(journal.partition);
    if (line1.length > 0) {
      const text = escapeDrawtext(line1.join("  ·  "));
      filters.push(
        `drawtext=text='${text}':fontsize=44:fontcolor=0xFFD54F:x=(w-text_w)/2:y=${cursorY}${fontArg}`
      );
      cursorY += 70;
    }

    // 审稿周期 + 录用率
    const line2: string[] = [];
    if (journal.reviewCycle) line2.push(`审稿 ${journal.reviewCycle}`);
    const acc = formatAcceptance(journal.acceptanceRate ?? null);
    if (acc) line2.push(`录用率 ${acc}`);
    if (line2.length > 0) {
      const text = escapeDrawtext(line2.join("  ·  "));
      filters.push(
        `drawtext=text='${text}':fontsize=44:fontcolor=white:x=(w-text_w)/2:y=${cursorY}${fontArg}`
      );
    }
  }

  return filters.join(",");
}

/**
 * 构建多场景 xfade 级联 filter_complex
 */
function buildXfadeFilterGraph(
  durations: number[],
  transitionSec: number,
  transitionType: string,
): { filterComplex: string; outputLabel: string } {
  if (durations.length <= 1) {
    return { filterComplex: "[0:v]null[v]", outputLabel: "v" };
  }

  const parts: string[] = [];
  let prevLabel = "0:v";
  let cumulativeOffset = 0;

  for (let i = 1; i < durations.length; i++) {
    const outLabel = i === durations.length - 1 ? "v" : `v${i}`;
    cumulativeOffset += durations[i - 1] - transitionSec;
    const offset = Math.max(0, cumulativeOffset).toFixed(3);
    parts.push(`[${prevLabel}][${i}:v]xfade=transition=${transitionType}:duration=${transitionSec}:offset=${offset}[${outLabel}]`);
    prevLabel = outLabel;
  }

  return { filterComplex: parts.join(";"), outputLabel: "v" };
}

export const videoComposer = new VideoComposer();
