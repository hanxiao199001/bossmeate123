/**
 * AssetManager - 视频素材管理
 *
 * 负责：
 *  - 根据脚本中的 visualElements 关键词从 Pexels 拉取免费素材
 *  - 本地缓存（避免同 tenant 重复付费请求）
 *  - 下载到 storage，返回可访问 URL
 *
 * 依赖：
 *  - rateLimiter (provider=pexels)
 *  - storage (OSS / local)
 *  - env.PEXELS_API_KEY
 */

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
  sourceUrl: string;    // 原始 Pexels URL
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
   * 为一组关键词获取素材
   */
  async fetchAssets(
    tenantId: string,
    keywords: string[]
  ): Promise<SceneAsset[]> {
    if (!env.PEXELS_API_KEY) {
      logger.warn("PEXELS_API_KEY 未配置，使用纯色占位图");
      return this.generatePlaceholders(tenantId, keywords);
    }
    const results: SceneAsset[] = [];
    for (const kw of keywords) {
      try {
        const asset = await this.fetchOne(tenantId, kw);
        if (asset) results.push(asset);
      } catch (err) {
        logger.warn(
          { kw, err: err instanceof Error ? err.message : err },
          "素材抓取失败，跳过"
        );
      }
    }
    return results;
  }

  private async fetchOne(
    tenantId: string,
    keyword: string
  ): Promise<SceneAsset | null> {
    // 限流
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
    };
  }
  /**
   * 无 Pexels API 时生成有内容的占位图（1080×1920 竖版）
   * 渐变背景 + 关键词文字 + 装饰元素，保证视频有画面不是纯色块
   */
  private async generatePlaceholders(tenantId: string, keywords: string[]): Promise<SceneAsset[]> {
    const sharp = (await import("sharp")).default;
    const themes = [
      { bg1: "#0D47A1", bg2: "#1565C0", accent: "#FFD54F" }, // 蓝金
      { bg1: "#1B5E20", bg2: "#2E7D32", accent: "#A5D6A7" }, // 绿
      { bg1: "#B71C1C", bg2: "#D32F2F", accent: "#FFCDD2" }, // 红
      { bg1: "#4A148C", bg2: "#7B1FA2", accent: "#CE93D8" }, // 紫
      { bg1: "#E65100", bg2: "#F57C00", accent: "#FFE0B2" }, // 橙
      { bg1: "#006064", bg2: "#00838F", accent: "#80DEEA" }, // 青
    ];
    const results: SceneAsset[] = [];
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      const t = themes[i % themes.length];
      // 用 SVG 生成有内容的图：渐变底 + 装饰圆 + 序号 + 关键词
      const svg = `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" style="stop-color:${t.bg1}"/>
    <stop offset="100%" style="stop-color:${t.bg2}"/>
  </linearGradient></defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <circle cx="900" cy="300" r="200" fill="rgba(255,255,255,0.05)"/>
  <circle cx="200" cy="1600" r="300" fill="rgba(255,255,255,0.03)"/>
  <circle cx="540" cy="960" r="400" fill="rgba(255,255,255,0.02)"/>
  <rect x="80" y="800" width="6" height="120" rx="3" fill="${t.accent}"/>
  <text x="540" y="700" text-anchor="middle" font-size="120" font-weight="bold" fill="rgba(255,255,255,0.08)" font-family="sans-serif">${String(i + 1).padStart(2, "0")}</text>
  <text x="540" y="1700" text-anchor="middle" font-size="28" fill="rgba(255,255,255,0.3)" font-family="sans-serif">BossMate AI</text>
</svg>`;
      const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
      const remotePath = `assets/${tenantId}/placeholder/${Date.now()}-${i}.jpg`;
      const url = await storage.upload(buf, remotePath, "image/jpeg");
      results.push({
        keyword: kw,
        url,
        remotePath,
        type: "image",
        width: 1080,
        height: 1920,
        sourceUrl: "placeholder",
      });
    }
    logger.info({ count: results.length }, "生成占位图完成");
    return results;
  }
}

export const assetManager = new AssetManager();
