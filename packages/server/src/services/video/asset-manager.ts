/**
 * AssetManager - 视频素材管理
 *
 * 素材优先级（期刊科普短视频）：
 *  1. journals 表的封面图（coverUrlHd > coverImageUrl）
 *  2. 期刊官网截图（TODO：待接入 headless browser，目前返回 null）
 *  3. Pexels 关键词搜图兜底
 *
 * 不使用纯色占位图（视频效果差）。若全部失败则放弃该场景。
 *
 * 依赖：
 *  - rateLimiter (provider=pexels)
 *  - storage (OSS / local)
 *  - env.PEXELS_API_KEY
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { rateLimiter } from "../rate-limiter/index.js";
import { storage } from "../storage/index.js";

export interface SceneAsset {
  keyword: string;
  url: string;          // 存储后的可访问 URL
  remotePath: string;   // storage 中的相对路径
  type: "image" | "video";
  width: number;
  height: number;
  sourceUrl: string;    // 原始 URL（Pexels / 期刊封面 / 官网）
  source: "journal_cover" | "journal_website" | "pexels";
}

/** 最小化的期刊信息接口，asset-manager 只关心封面相关字段 */
export interface JournalAssetInput {
  id?: string;
  name?: string | null;
  coverImageUrl?: string | null;
  coverUrlHd?: string | null;
  website?: string | null;
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  src: { original: string; large2x: string; large: string };
  url: string;
}

interface PexelsSearchResponse {
  photos: PexelsPhoto[];
  total_results: number;
}

export class AssetManager {
  private readonly endpoint = "https://api.pexels.com/v1/search";

  /**
   * 期刊封面抓取（优先级 1）
   * 将远程封面下载到 storage，保证 FFmpeg 合成时本地可访问。
   *
   * 重试策略（T28-2）：阿里云 OSS / LetPub CDN 偶发跨区抖动，单次 fetch 失败常见。
   * - 3 次尝试，指数退避 200ms / 600ms / 1800ms
   * - 每次单独 10s timeout（避免单次卡死）
   * - 全部失败 → 返回 null，由上游回退到下一级素材
   */
  async fetchJournalCover(
    tenantId: string,
    journal: JournalAssetInput
  ): Promise<SceneAsset | null> {
    const coverUrl = journal.coverUrlHd || journal.coverImageUrl;
    if (!coverUrl) return null;
    if (!/^https?:\/\//i.test(coverUrl)) {
      logger.warn({ journalId: journal.id, coverUrl }, "期刊封面 URL 非法，跳过");
      return null;
    }

    const TIMEOUT_MS = 10_000;
    const BACKOFF_MS = [200, 600, 1800];
    const MAX_ATTEMPTS = BACKOFF_MS.length;

    let lastErr: unknown = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const resp = await fetch(coverUrl, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const ext = this.inferExt(coverUrl, resp.headers.get("content-type"));
        const remotePath = `assets/${tenantId}/journal-cover/${journal.id || "unknown"}-${Date.now()}.${ext}`;
        const accessUrl = await storage.upload(
          buf,
          remotePath,
          `image/${ext === "jpg" ? "jpeg" : ext}`
        );
        logger.info(
          { journalId: journal.id, coverUrl, attempts: attempt + 1 },
          "期刊封面下载完成"
        );
        return {
          keyword: "__journal_cover__",
          url: accessUrl,
          remotePath,
          type: "image",
          width: 0,
          height: 0,
          sourceUrl: coverUrl,
          source: "journal_cover",
        };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS - 1) {
          logger.warn(
            { journalId: journal.id, coverUrl, attempt: attempt + 1, errMsg, nextBackoffMs: BACKOFF_MS[attempt] },
            "期刊封面下载失败，重试中"
          );
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        }
      }
    }

    logger.warn(
      {
        journalId: journal.id,
        coverUrl,
        attempts: MAX_ATTEMPTS,
        err: lastErr instanceof Error ? lastErr.message : lastErr,
      },
      "期刊封面下载彻底失败（已重试 3 次），回退到下一级素材"
    );
    return null;
  }

  /**
   * 期刊官网截图（优先级 2） — 预留接口
   * TODO: 接入 Playwright/Puppeteer headless browser
   * 目前始终返回 null，直接走 Pexels 兜底
   */
  async fetchJournalScreenshot(
    _tenantId: string,
    _journal: JournalAssetInput
  ): Promise<SceneAsset | null> {
    return null;
  }

  /**
   * Pexels 关键词搜图（优先级 3，兜底）
   */
  async fetchAssets(
    tenantId: string,
    keywords: string[]
  ): Promise<SceneAsset[]> {
    if (!env.PEXELS_API_KEY) {
      logger.warn("PEXELS_API_KEY 未配置，无法获取 Pexels 兜底素材");
      return [];
    }
    const results: SceneAsset[] = [];
    for (const kw of keywords) {
      try {
        const asset = await this.fetchOne(tenantId, kw);
        if (asset) results.push(asset);
      } catch (err) {
        logger.warn(
          { kw, err: err instanceof Error ? err.message : err },
          "Pexels 素材抓取失败，跳过"
        );
      }
    }
    return results;
  }

  private async fetchOne(
    tenantId: string,
    keyword: string
  ): Promise<SceneAsset | null> {
    await rateLimiter.acquireOrWait("pexels");

    const q = encodeURIComponent(keyword);
    const url = `${this.endpoint}?query=${q}&per_page=1&orientation=portrait`;
    const resp = await fetch(url, {
      headers: { Authorization: env.PEXELS_API_KEY! },
    });
    if (!resp.ok) {
      throw new Error(`Pexels API ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as PexelsSearchResponse;
    if (!data.photos || data.photos.length === 0) {
      return null;
    }
    const photo = data.photos[0];
    const imgResp = await fetch(photo.src.large2x);
    if (!imgResp.ok) throw new Error(`图片下载失败: ${imgResp.status}`);
    const buf = Buffer.from(await imgResp.arrayBuffer());

    const remotePath = `assets/${tenantId}/pexels/${photo.id}.jpg`;
    const accessUrl = await storage.upload(buf, remotePath, "image/jpeg");

    return {
      keyword,
      url: accessUrl,
      remotePath,
      type: "image",
      width: photo.width,
      height: photo.height,
      sourceUrl: photo.url,
      source: "pexels",
    };
  }

  /**
   * 纯色背景占位图（最终兜底）
   * 用 FFmpeg lavfi color 生成 1080×1920 深色 JPEG，无需任何外部 API
   */
  async generateColorPlaceholder(tenantId: string): Promise<SceneAsset | null> {
    const outPath = join(tmpdir(), `bm-placeholder-${Date.now()}.jpg`);
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn("ffmpeg", [
          "-y",
          "-f", "lavfi",
          "-i", "color=c=0x0d1b2a:size=1080x1920:rate=1",
          "-frames:v", "1",
          "-q:v", "2",
          outPath,
        ]);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
        p.on("error", reject);
      });
      const buf = await readFile(outPath);
      const remotePath = `assets/${tenantId}/placeholder/bg-${Date.now()}.jpg`;
      const accessUrl = await storage.upload(buf, remotePath, "image/jpeg");
      logger.info({ remotePath }, "生成纯色占位背景图");
      return {
        keyword: "__placeholder__",
        url: accessUrl,
        remotePath,
        type: "image",
        width: 1080,
        height: 1920,
        sourceUrl: "",
        source: "pexels",  // 复用已有 source 类型，避免改接口
      };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "纯色占位图生成失败");
      return null;
    } finally {
      unlink(outPath).catch(() => {});
    }
  }

  private inferExt(url: string, contentType: string | null): string {
    const m = url.match(/\.([a-z0-9]{2,4})(?:\?|#|$)/i);
    if (m) return m[1].toLowerCase();
    if (contentType?.includes("jpeg")) return "jpg";
    if (contentType?.includes("png")) return "png";
    if (contentType?.includes("webp")) return "webp";
    return "jpg";
  }
}

export const assetManager = new AssetManager();
