/**
 * Video Production Chain 统一入口
 *
 * 高层 API：
 *   produceVideo(tenantId, script, journalId?)
 *     = 期刊封面（或 Pexels 兜底） → 逐场景 TTS → FFmpeg 合成（含期刊信息卡字幕）
 *
 * 调用方：VideoProducer Agent / chat 路由
 */

import { eq, and } from "drizzle-orm";
import { assetManager } from "./asset-manager.js";
import type { SceneAsset, JournalAssetInput } from "./asset-manager.js";
import { ttsService } from "./tts-service.js";
import { videoComposer } from "./composer.js";
import type { ComposeResult, ComposerScene, JournalInfoCard } from "./composer.js";
import { generateCard } from "./html-renderer.js";
import type { SceneType, JournalCardData } from "./html-renderer.js";
import { logger } from "../../config/logger.js";
import { storage } from "../storage/index.js";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";

export interface ProduceSceneInput {
  voiceoverText: string;
  visualKeywords: string[];   // Pexels 兜底关键词
  durationMs?: number;
  subtitle?: string;
  /** V2: 场景类型，存在时生成对应信息卡底图，跳过封面/Pexels逻辑 */
  sceneType?: SceneType;
}

export interface ProduceVideoInput {
  tenantId: string;
  title: string;
  scenes: ProduceSceneInput[];
  /** 关联期刊 ID：用于拉封面和信息卡 */
  journalId?: string;
  /** 直接传入期刊数据（优先级高于 journalId，避免重复查库） */
  journal?: JournalAssetInput & JournalInfoCard & JournalCardData;
}

export interface ProduceVideoResult extends ComposeResult {
  scenesCount: number;
  missingAssetsCount: number;
}

export async function produceVideo(
  input: ProduceVideoInput
): Promise<ProduceVideoResult> {
  const { tenantId, scenes } = input;

  // 1. 载入期刊数据（如果有）
  let journal: (JournalAssetInput & JournalInfoCard & JournalCardData) | undefined = input.journal;
  if (!journal && input.journalId) {
    try {
      const [row] = await db
        .select({
          id: journals.id,
          name: journals.name,
          nameEn: journals.nameEn,
          coverImageUrl: journals.coverImageUrl,
          coverUrlHd: journals.coverUrlHd,
          website: journals.website,
          impactFactor: journals.impactFactor,
          partition: journals.partition,
          casPartition: journals.casPartition,
          casPartitionNew: journals.casPartitionNew,
          reviewCycle: journals.reviewCycle,
          acceptanceRate: journals.acceptanceRate,
          selfCitationRate: journals.selfCitationRate,
          citeScore: journals.citeScore,
          jcrSubjects: journals.jcrSubjects,
          scopeDescription: journals.scopeDescription,
          discipline: journals.discipline,
          publisher: journals.publisher,
        })
        .from(journals)
        .where(and(eq(journals.id, input.journalId), eq(journals.tenantId, tenantId)))
        .limit(1);
      if (row) {
        journal = {
          id: row.id,
          name: row.name,
          nameCn: row.name,
          nameEn: row.nameEn,
          coverImageUrl: row.coverImageUrl,
          coverUrlHd: row.coverUrlHd,
          website: row.website,
          impactFactor: row.impactFactor,
          partition: row.partition,
          casPartition: row.casPartition,
          casPartitionNew: row.casPartitionNew,
          reviewCycle: row.reviewCycle,
          acceptanceRate: row.acceptanceRate,
          selfCitationRate: row.selfCitationRate,
          citeScore: row.citeScore,
          jcrSubjects: row.jcrSubjects,
          scopeDescription: row.scopeDescription,
          discipline: row.discipline,
          publisher: row.publisher,
        };
      } else {
        logger.warn({ journalId: input.journalId, tenantId }, "未找到期刊，将使用关键词兜底素材");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, journalId: input.journalId },
        "期刊加载失败，将使用关键词兜底素材"
      );
    }
  }

  // 期刊信息卡（所有场景共用）
  const journalInfoCard: JournalInfoCard | undefined = journal ? {
    nameCn: journal.nameCn ?? journal.name ?? null,
    nameEn: journal.nameEn ?? null,
    impactFactor: journal.impactFactor ?? null,
    partition: journal.partition ?? null,
    casPartition: journal.casPartition ?? null,
    reviewCycle: journal.reviewCycle ?? null,
    acceptanceRate: journal.acceptanceRate ?? null,
  } : undefined;

  // 2. 期刊封面（优先级 1） — 下载一次所有场景复用
  let journalCover: SceneAsset | null = null;
  if (journal) {
    journalCover = await assetManager.fetchJournalCover(tenantId, journal);
    if (!journalCover) {
      // 预留：期刊官网截图（TODO）
      journalCover = await assetManager.fetchJournalScreenshot(tenantId, journal);
    }
  }

  // 3. Pexels 兜底（优先级 3） — 仅当期刊封面缺失时才抓关键词素材
  const allKeywords = Array.from(
    new Set(scenes.flatMap((s) => s.visualKeywords).filter(Boolean))
  );
  const pexelsAssets = journalCover
    ? []
    : await assetManager.fetchAssets(tenantId, allKeywords);
  const assetMap = new Map(pexelsAssets.map((a) => [a.keyword, a]));

  // 构建卡片数据（供 V2 卡片生成器使用）
  const cardData: JournalCardData | null = journal ? {
    name: journal.name ?? null,
    nameEn: journal.nameEn ?? null,
    impactFactor: journal.impactFactor ?? null,
    casPartition: journal.casPartition ?? null,
    casPartitionNew: (journal as any).casPartitionNew ?? null,
    partition: journal.partition ?? null,
    reviewCycle: journal.reviewCycle ?? null,
    acceptanceRate: journal.acceptanceRate ?? null,
    selfCitationRate: (journal as any).selfCitationRate ?? null,
    citeScore: (journal as any).citeScore ?? null,
    jcrSubjects: (journal as any).jcrSubjects ?? null,
    scopeDescription: (journal as any).scopeDescription ?? null,
    discipline: (journal as any).discipline ?? null,
    publisher: (journal as any).publisher ?? null,
  } : null;

  // 4. 逐场景生成 TTS + 组装 composer scene
  const composerScenes: ComposerScene[] = [];
  let missing = 0;
  for (const s of scenes) {
    const tts = await ttsService.synthesize(tenantId, s.voiceoverText);

    // V2: sceneType 存在时生成信息卡底图
    let imageUrl: string | null = null;
    if (s.sceneType && cardData) {
      try {
        const cardBuf = await generateCard(s.sceneType, cardData);
        const cardPath = `assets/${tenantId}/cards/${s.sceneType}-${Date.now()}.png`;
        imageUrl = await storage.upload(cardBuf, cardPath, "image/png");
        logger.info({ sceneType: s.sceneType, cardPath }, "V2 信息卡生成完成");
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err, sceneType: s.sceneType }, "信息卡生成失败，回退到封面/Pexels");
      }
    }

    // 非 V2 或卡片生成失败：使用封面/Pexels/占位
    if (!imageUrl) {
      let asset: SceneAsset | null | undefined = journalCover;
      if (!asset) {
        const hitKw = s.visualKeywords.find((k) => assetMap.has(k));
        asset = hitKw ? assetMap.get(hitKw) : undefined;
      }
      if (!asset) {
        // 兜底2：用旁白前 15 字再搜一次 Pexels
        const fallbackKw = s.voiceoverText.slice(0, 15) || `scene-${composerScenes.length}`;
        const [fallbackAsset] = await assetManager.fetchAssets(tenantId, [fallbackKw]);
        asset = fallbackAsset;
      }
      if (!asset) {
        // 兜底3：纯色背景
        asset = await assetManager.generateColorPlaceholder(tenantId);
      }
      if (!asset) {
        missing++;
        logger.error(
          { scene: s.voiceoverText.slice(0, 20), keywords: s.visualKeywords },
          "场景素材获取失败，跳过该场景"
        );
        continue;
      }
      imageUrl = asset.url;
    }

    composerScenes.push({
      imageSource: imageUrl,
      voiceoverSource: tts.url,
      durationMs: s.durationMs ?? tts.durationMs,
      subtitle: s.subtitle,
      journalInfo: s.sceneType ? undefined : journalInfoCard,
      sceneType: s.sceneType,
    });
  }

  if (composerScenes.length === 0) {
    throw new Error("没有可合成的场景（全部缺素材）");
  }

  const result = await videoComposer.compose({
    tenantId,
    scenes: composerScenes,
  });

  return {
    ...result,
    scenesCount: composerScenes.length,
    missingAssetsCount: missing,
  };
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
  const emptyPaths = images.filter((img) => !img.remotePath);
  if (emptyPaths.length > 0) {
    logger.warn(
      { count: emptyPaths.length, total: images.length },
      "部分图片 remotePath 为空，将生成占位图替代",
    );
  }

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
