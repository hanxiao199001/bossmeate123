/**
 * 5-24 PR #252 — DVH 视频后处理: 用 ffmpeg 烧自定义字幕.
 *
 * 背景: 阿里云 DVH SubtitleStyle.color 实测不工作 (PR #251 试 6 种格式都被忽略).
 *   改方案: 关 subtitleEmbedded → 拿 taskResult.subtitlesUrl SRT → ffmpeg burn-in 自定义样式.
 *
 * 流程:
 *   1. 下载 DVH 原始 mp4 + SRT 到 /tmp
 *   2. ffmpeg subtitles 滤镜 burn-in (ASS style: 白字黑边/字号/位置/字体)
 *   3. 上传处理后 mp4 到 BossMate OSS bucket (bossmate-assets)
 *   4. 返回新 OSS URL, 清理 /tmp 文件
 *
 * 依赖: prod 装 ffmpeg + fonts-noto-cjk (中文字体)
 *   apt-get install -y ffmpeg fonts-noto-cjk
 *
 * 失败兜底: 若任一步出错 (ffmpeg / OSS / 网络), logger.warn + return DVH 原 videoUrl (不阻塞链路).
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../config/logger.js";
import { storage } from "../storage/index.js";

export interface PostprocessOptions {
  videoUrl: string;         // DVH 原始 mp4 OSS URL
  subtitlesUrl: string;     // DVH 返回的 SRT URL
  taskUuid: string;         // 用作 OSS key 防冲突
  /** 字幕样式 (ASS force_style 格式, 可选). 默认 BossMate 抖音风 (白字黑边 size 18 居中下方). */
  subtitleStyle?: SubtitleAssStyle;
}

export interface PostprocessResult {
  videoUrl: string;        // 处理后的 OSS URL (或失败时回 DVH 原 URL)
  postprocessed: boolean;  // true = ffmpeg 成功, false = fallback DVH 原视频
}

/**
 * ASS style 字段 (ffmpeg subtitles 滤镜 force_style 用).
 *   ASS PrimaryColour 是 BGR (不是 RGB), 加 alpha 前缀: &HAABBGGRR&
 *   颜色: 白字 &H00FFFFFF&, 黑边 &H00000000&, 黄字 &H0000FFFF&
 */
export interface SubtitleAssStyle {
  fontName?: string;       // 字体名, 默认 "Noto Sans CJK SC" (中文黑体)
  fontSize?: number;       // 字号, 默认 18 (ASS 字号 ~ 像素 / 2)
  primaryColour?: string;  // 字体色 &HAABBGGRR&, 默认 白色 &H00FFFFFF&
  outlineColour?: string;  // 描边色, 默认 黑色 &H00000000&
  outline?: number;        // 描边宽度 (像素), 默认 2
  shadow?: number;         // 阴影, 默认 0 (描边足够清晰, 不需要阴影)
  alignment?: number;      // 1-9 九宫格位置, 默认 2 (居中下方); 5 居中, 8 居中上方
  marginV?: number;        // 距底部/顶部边距, 默认 80
  bold?: 0 | 1;            // 加粗, 默认 1
}

const DEFAULT_STYLE: Required<SubtitleAssStyle> = {
  fontName: "Noto Sans CJK SC",
  // PR #253 (5-24): 字号 18 在 1080×1920 视觉太小, 改 28.
  // PR #254 (5-24): 28 仍偏小, 再 +2 到 30.
  fontSize: 42, // PR #256: 老韩拍 40+, 一步到位 42
  primaryColour: "&H00FFFFFF&",  // 白字
  outlineColour: "&H00000000&",  // 黑边
  outline: 2,
  shadow: 0,
  alignment: 2,                   // 居中下方
  // PR #253: marginV 80 距底边太近 (会被抖音 UI 遮挡), 改 200 (距底 ~10% 安全区).
  marginV: 200,
  bold: 1,  // PR #257: 抖音爆款常态粗体
};

function buildForceStyle(style: SubtitleAssStyle): string {
  const merged = { ...DEFAULT_STYLE, ...style };
  return [
    `FontName=${merged.fontName}`,
    `FontSize=${merged.fontSize}`,
    `PrimaryColour=${merged.primaryColour}`,
    `OutlineColour=${merged.outlineColour}`,
    `Outline=${merged.outline}`,
    `Shadow=${merged.shadow}`,
    `Alignment=${merged.alignment}`,
    `MarginV=${merged.marginV}`,
    `Bold=${merged.bold}`,
    `BorderStyle=1`,  // 1 = outline only, 3 = box bg (BossMate 用 outline)
  ].join(",");
}

async function runFFmpeg(inputMp4: string, srtPath: string, outputMp4: string, style: SubtitleAssStyle): Promise<void> {
  const forceStyle = buildForceStyle(style);
  // ffmpeg -y -i input.mp4 -vf "subtitles=input.srt:force_style='...'" -c:v libx264 -c:a copy output.mp4
  const args = [
    "-y",
    "-i", inputMp4,
    "-vf", `subtitles=${srtPath}:force_style='${forceStyle}'`,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "22",
    "-c:a", "copy",
    outputMp4,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn 失败: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
}

/**
 * 主入口: DVH 原视频 + SRT → ffmpeg burn-in → BossMate OSS.
 * 失败时 fallback 返回 DVH 原 videoUrl, 不阻塞主链路.
 */
export async function postprocessVideoWithSubtitle(opts: PostprocessOptions): Promise<PostprocessResult> {
  const { videoUrl, subtitlesUrl, taskUuid, subtitleStyle } = opts;
  if (!subtitlesUrl) {
    logger.warn({ taskUuid }, "dvh.postprocess.no_srt_skip");
    return { videoUrl, postprocessed: false };
  }

  let workDir: string | undefined;
  const startedAt = Date.now();
  try {
    workDir = await mkdtemp(join(tmpdir(), "dvh-pp-"));
    const inputMp4 = join(workDir, "input.mp4");
    const srtPath = join(workDir, "input.srt");
    const outputMp4 = join(workDir, "output.mp4");

    logger.info({ taskUuid, workDir }, "dvh.postprocess.start");

    // 并行下载 mp4 + SRT
    await Promise.all([
      downloadToFile(videoUrl, inputMp4),
      downloadToFile(subtitlesUrl, srtPath),
    ]);

    // ffmpeg burn-in
    await runFFmpeg(inputMp4, srtPath, outputMp4, subtitleStyle ?? {});

    // 上传到 BossMate OSS
    const buffer = await readFile(outputMp4);
    const ossKey = `dvh-videos/${taskUuid}.mp4`;
    const newUrl = await storage.upload(buffer, ossKey, "video/mp4");

    const ms = Date.now() - startedAt;
    logger.info({ taskUuid, newUrl, sizeMB: (buffer.length / 1024 / 1024).toFixed(1), ms }, "dvh.postprocess.success");

    return { videoUrl: newUrl, postprocessed: true };
  } catch (err) {
    logger.warn({ taskUuid, err: err instanceof Error ? err.message : err, ms: Date.now() - startedAt }, "dvh.postprocess.failed_fallback_original");
    return { videoUrl, postprocessed: false };
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
