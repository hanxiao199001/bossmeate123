/**
 * 7-02 混剪提质④: 混剪素材解析 — 从视频 content 反查关联期刊, 取封面 + 数据图表当片头背景/B-roll。
 *
 * journalId 查找链(实测存储位置, 见 article-bridge.ts):
 *   DVH 视频 content.metadata 只存 sourceArticleId(不存 journalId) →
 *   文章 content.metadata.journalId 才是期刊关联 → 查不到再兜底 journal_usage 表(PR-N 选刊记录)。
 *
 * 图表栅格化: 红线#11 复用>重写 — services/video/chart-renderer.ts 已有
 *   "journals jsonb → 大字号视频 SVG → sharp → PNG" 的现成实现(IF 趋势/年发文量),
 *   直接复用它, 不重新栅格化 journal-chart-generator 那套公众号 <img> 用小字 SVG(视频里看不清)。
 *
 * 失败兜底: 任何一步失败(无期刊/封面 404/sharp 挂)都只影响对应素材, 最终最多返回空对象 —
 *   remixVideo 拿到空对象照常跑老混剪, 绝不阻塞出片。
 */
import { desc, eq, inArray } from "drizzle-orm";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../models/db.js";
import { contents, journals, journalUsage } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

export interface RemixAssets {
  introBgUrl?: string;   // 片头背景图本地路径(期刊封面)
  brollPaths?: string[]; // B-roll 本地 PNG(数据图表, 竖屏 1080x1920; 封面兜底)
  // 7-10 片头模板 C(数据大字卡)素材: IF/分区做视觉主角。只取 DB 已核实字段拼文本, 无编造。
  journalStats?: { ifText?: string; partitionText?: string };
  journalId?: string;    // 命中的期刊(日志用)
}

// 竖屏短视频标准尺寸 — remixVideo 会再按实际视频宽高等比放大裁切, 这里只要够清晰即可
const CHART_W = 1080;
const CHART_H = 1920;

/** 视频 content → sourceArticleId → 文章 metadata.journalId; 兜底 journal_usage。 */
async function findJournalId(contentId: string): Promise<string | undefined> {
  const [video] = await db.select({ metadata: contents.metadata }).from(contents)
    .where(eq(contents.id, contentId)).limit(1);
  if (!video) return undefined;
  const meta = video.metadata as { sourceArticleId?: string; journalId?: string } | null;
  // 有些内容(非 DVH 链路)metadata 直接带 journalId, 先认它
  if (typeof meta?.journalId === "string" && meta.journalId) return meta.journalId;

  const articleId = typeof meta?.sourceArticleId === "string" ? meta.sourceArticleId : undefined;
  if (articleId) {
    const [art] = await db.select({ metadata: contents.metadata }).from(contents)
      .where(eq(contents.id, articleId)).limit(1);
    const jid = (art?.metadata as { journalId?: string } | null)?.journalId;
    if (typeof jid === "string" && jid) return jid;
  }
  // 兜底: PR-N journal_usage 选刊记录(生成内容时记一笔), 按视频/文章 contentId 反查最近一条
  const candidateIds = [contentId, ...(articleId ? [articleId] : [])];
  const [u] = await db.select({ journalId: journalUsage.journalId }).from(journalUsage)
    .where(inArray(journalUsage.contentId, candidateIds))
    .orderBy(desc(journalUsage.usedAt)).limit(1);
  return u?.journalId;
}

/** 下载期刊封面到 workDir(10s 超时 + 20MB 上限); 失败返回 undefined。 */
async function downloadCover(url: string, workDir: string): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 20 * 1024 * 1024) throw new Error(`封面大小异常 ${buf.length}B`);
    const ct = res.headers.get("content-type") || "";
    const ext = /png/i.test(ct) ? "png" : /webp/i.test(ct) ? "webp" : "jpg";
    const dst = join(workDir, `remix-cover.${ext}`);
    await writeFile(dst, buf);
    return dst;
  } catch (err) {
    logger.warn({ url, err: err instanceof Error ? err.message : err }, "dvh.remix_assets.cover_failed");
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 主入口: contentId(视频 content) + workDir(调用方负责创建/清理) → 混剪素材。
 * 任何失败返回空对象 {}, 调用方直接展开传给 remixVideo 即可。
 */
export async function resolveRemixAssets(contentId: string, workDir: string): Promise<RemixAssets> {
  try {
    const journalId = await findJournalId(contentId);
    if (!journalId) {
      logger.info({ contentId }, "dvh.remix_assets.no_journal_skip");
      return {};
    }
    const [j] = await db.select({
      id: journals.id,
      name: journals.name,
      coverUrlHd: journals.coverUrlHd,
      coverImageUrl: journals.coverImageUrl,
      ifHistory: journals.ifHistory,
      publicationStats: journals.publicationStats,
      impactFactor: journals.impactFactor,
      partition: journals.partition,
      casPartition: journals.casPartition,
      casPartitionNew: journals.casPartitionNew,
    }).from(journals).where(eq(journals.id, journalId)).limit(1);
    if (!j) return {};

    // ① 封面(取用模式与 asset-manager 一致: coverUrlHd > coverImageUrl) → 片头背景
    let coverPath: string | undefined;
    const coverUrl = j.coverUrlHd || j.coverImageUrl;
    if (coverUrl && /^https?:\/\//i.test(coverUrl)) {
      coverPath = await downloadCover(coverUrl, workDir);
    }

    // ② 数据图表 → B-roll PNG(最多 2 张)。sharp 加载失败也不能拖垮 remix → 动态 import 包在 try 里
    const brollPaths: string[] = [];
    try {
      const { renderChartFrame } = await import("../video/chart-renderer.js");
      const chartSpecs = [
        { type: "if" as const, data: j.ifHistory, name: "chart-if" },
        { type: "volume" as const, data: j.publicationStats, name: "chart-volume" },
      ];
      for (const spec of chartSpecs) {
        if (!spec.data || brollPaths.length >= 2) continue;
        const buf = await renderChartFrame({ type: spec.type, data: spec.data, width: CHART_W, height: CHART_H });
        if (buf) {
          const p = join(workDir, `${spec.name}.png`);
          await writeFile(p, buf);
          brollPaths.push(p);
        }
      }
    } catch (err) {
      logger.warn({ journalId, err: err instanceof Error ? err.message : err }, "dvh.remix_assets.chart_failed");
    }

    // 图表不足 2 张时, 封面也顶一张 B-roll(有片头背景重复曝光问题, 但比中段全程无插层观感好)
    if (coverPath && brollPaths.length < 2) brollPaths.push(coverPath);

    // ③ 7-10 片头模板 C 数据文本: IF 保留 1 位小数(real 浮点误差别上屏); 分区优先中科院新锐 > 中科院 > JCR。
    //    两者都空 → 不给 journalStats, 模板池自动不出 C。
    const ifText = typeof j.impactFactor === "number" && j.impactFactor > 0
      ? `IF ${j.impactFactor.toFixed(1)}`
      : undefined;
    const partitionText = j.casPartitionNew || j.casPartition || (j.partition ? `JCR ${j.partition}` : undefined) || undefined;
    const journalStats = ifText || partitionText
      ? { ...(ifText ? { ifText } : {}), ...(partitionText ? { partitionText } : {}) }
      : undefined;

    const assets: RemixAssets = {
      ...(coverPath ? { introBgUrl: coverPath } : {}),
      ...(brollPaths.length > 0 ? { brollPaths } : {}),
      ...(journalStats ? { journalStats } : {}),
      journalId,
    };
    logger.info({ contentId, journalId, journal: j.name, cover: !!coverPath, brolls: brollPaths.length }, "dvh.remix_assets.resolved");
    return assets;
  } catch (err) {
    logger.warn({ contentId, err: err instanceof Error ? err.message : err }, "dvh.remix_assets.failed_empty");
    return {};
  }
}
