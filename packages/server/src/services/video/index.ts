/**
 * Video Production Chain 统一入口
 *
 * 高层 API：
 *   produceVideo(tenantId, script)
 *     = fetchAssets → synthesize TTS per scene → compose mp4
 *
 * 调用方：VideoProducer Agent / manual route
 */

import { assetManager } from "./asset-manager.js";
import { ttsService } from "./tts-service.js";
import { videoComposer } from "./composer.js";
import type { ComposeResult } from "./composer.js";
import { generateCard, type SceneType, type JournalCardData } from "./html-renderer.js";
import { unlink } from "node:fs/promises";
import { logger } from "../../config/logger.js";
import { storage } from "../storage/index.js";

export type { SceneType, JournalCardData } from "./html-renderer.js";

export interface ProduceSceneInput {
  voiceoverText: string;
  visualKeywords: string[];   // 用第一个命中作为素材（sceneType 缺席或渲染失败时的兜底）
  durationMs?: number;        // 不传则按 voiceover 长度估算
  subtitle?: string;
  /** 指定后优先用 Puppeteer 卡片作为画面（需要 journalData） */
  sceneType?: SceneType;
}

export interface ProduceVideoInput {
  tenantId: string;
  title: string;
  scenes: ProduceSceneInput[];
  /** 6 场景期刊卡片模式所需的期刊真实数据 */
  journalData?: JournalCardData;
}

export interface ProduceVideoResult extends ComposeResult {
  scenesCount: number;
  missingAssetsCount: number;
}

export async function produceVideo(
  input: ProduceVideoInput
): Promise<ProduceVideoResult> {
  const { tenantId, scenes, journalData } = input;

  // 只对"未指定 sceneType 或无 journalData"的场景抓素材，避免浪费 API 配额
  const needStockScenes = scenes.filter(
    (s) => !(s.sceneType && journalData),
  );
  const allKeywords = Array.from(
    new Set(needStockScenes.flatMap((s) => s.visualKeywords).filter(Boolean)),
  );
  const assets = allKeywords.length > 0
    ? await assetManager.fetchAssets(tenantId, allKeywords)
    : [];
  const assetMap = new Map(assets.map((a) => [a.keyword, a]));

  const composerScenes: Array<{
    imageSource: string;
    voiceoverSource: string;
    durationMs: number;
    subtitle?: string;
  }> = [];
  const tempCardPaths: string[] = [];  // 清理用
  let missing = 0;

  for (const s of scenes) {
    const tts = await ttsService.synthesize(tenantId, s.voiceoverText);

    // 1) 优先 Puppeteer 卡片
    let imageSource: string | undefined;
    if (s.sceneType && journalData) {
      try {
        imageSource = await generateCard(s.sceneType, journalData);
        tempCardPaths.push(imageSource);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, sceneType: s.sceneType },
          "卡片渲染失败，回退到素材库流程",
        );
      }
    }

    // 2) 回退到 visualKeywords → Pexels/占位图
    if (!imageSource) {
      const hitKw = s.visualKeywords.find((k) => assetMap.has(k));
      let asset = hitKw ? assetMap.get(hitKw) : undefined;
      if (!asset) {
        missing++;
        logger.warn(
          { scene: s.voiceoverText.slice(0, 20), keywords: s.visualKeywords },
          "场景无可用素材，尝试生成兜底占位图",
        );
        const fallbackKw = s.voiceoverText.slice(0, 15) || `scene-${composerScenes.length}`;
        const [fallbackAsset] = await assetManager.fetchAssets(tenantId, [fallbackKw]);
        if (fallbackAsset) {
          asset = fallbackAsset;
        } else {
          logger.error(
            { scene: s.voiceoverText.slice(0, 20) },
            "兜底占位图也生成失败，跳过该场景",
          );
          continue;
        }
      }
      imageSource = asset.url;
    }

    composerScenes.push({
      imageSource,
      voiceoverSource: tts.url,
      durationMs: s.durationMs ?? tts.durationMs,
      subtitle: s.subtitle,
    });
  }

  if (composerScenes.length === 0) {
    await cleanupCardFiles(tempCardPaths);
    throw new Error("没有可合成的场景（全部缺素材）");
  }

  try {
    const result = await videoComposer.compose({
      tenantId,
      scenes: composerScenes,
    });
    return {
      ...result,
      scenesCount: composerScenes.length,
      missingAssetsCount: missing,
    };
  } finally {
    await cleanupCardFiles(tempCardPaths);
  }
}

async function cleanupCardFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    try { await unlink(p); } catch { /* 文件已清理或从未创建 */ }
  }
}

// ============ 图片转视频 ============

export interface ImageToVideoInput {
  tenantId: string;
  title: string;
  images: Array<{
    /** storage 中的路径（不接受外部 URL，防 SSRF） */
    remotePath: string;
    durationMs?: number;
    title?: string;
    subtitle?: string;
    animation?: "kenburns_in" | "kenburns_out" | "pan_left" | "pan_right" | "static";
  }>;
  bgmId?: string;
  resolution?: "1080x1920" | "1920x1080";
  transition?: "fade" | "dissolve" | "none";
}

export interface ImageToVideoResult {
  url: string;
  remotePath: string;
  durationMs: number;
  sizeBytes: number;
  coverUrl?: string;
  coverRemotePath?: string;
  resolution: string;
  scenesCount: number;
}

/** 预置 BGM 列表（ID → 路径），一期只用预置不允许上传 */
import { resolve } from "node:path";
const BGM_DIR = resolve(process.cwd(), "data/bgm");
const BGM_PRESETS: Record<string, string> = {
  gentle: resolve(BGM_DIR, "gentle.mp3"),
  business: resolve(BGM_DIR, "business.mp3"),
  upbeat: resolve(BGM_DIR, "upbeat.mp3"),
};

/**
 * 图片序列 → 宣传短视频
 * 调用方：video-worker（BullMQ job handler）
 */
export async function produceFromImages(
  input: ImageToVideoInput,
  onProgress?: (percent: number) => void,
): Promise<ImageToVideoResult> {
  const { tenantId, images } = input;

  // 校验
  const maxImages = parseInt(process.env.VIDEO_MAX_IMAGES || "15");
  const maxDuration = parseInt(process.env.VIDEO_MAX_DURATION_SEC || "120");
  if (images.length > maxImages) throw new Error(`最多 ${maxImages} 张图片`);
  const totalDurationSec = images.reduce((s, img) => s + (img.durationMs ?? 4000) / 1000, 0);
  if (totalDurationSec > maxDuration) throw new Error(`总时长不能超过 ${maxDuration} 秒`);

  // remotePath → 本地路径或签名 URL
  const scenes = images.map((img) => ({
    imageSource: storage.resolveLocalPath
      ? storage.resolveLocalPath(img.remotePath)
      : img.remotePath,
    durationMs: img.durationMs ?? 4000,
    title: img.title,
    subtitle: img.subtitle,
    animation: img.animation,
  }));

  // BGM
  const bgmPath = input.bgmId && BGM_PRESETS[input.bgmId]
    ? BGM_PRESETS[input.bgmId]
    : undefined;

  const result = await videoComposer.composeSlideshow({
    tenantId,
    scenes,
    bgmPath,
    resolution: input.resolution,
    transition: input.transition,
    onProgress,
  });

  return {
    url: result.url,
    remotePath: result.remotePath,
    durationMs: result.durationMs,
    sizeBytes: result.sizeBytes,
    coverUrl: result.coverUrl,
    coverRemotePath: result.coverRemotePath,
    resolution: result.resolution,
    scenesCount: result.scenesCount,
  };
}

export { assetManager, ttsService, videoComposer };
