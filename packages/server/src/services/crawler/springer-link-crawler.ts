/**
 * Springer Link 期刊爬虫 — SCI 线核心数据源
 *
 * 两种工作模式：
 * 1. 基础库模式（月度）：通过 Python Scrapling 批量爬取所有学科的期刊列表+详情
 * 2. 动态监控模式（每日）：通过 Springer Meta API 获取重点期刊最新文章动态
 *
 * 数据流：
 *   基础库模式：springer_browse_crawler.py → JSON stdout → 写入 journals 表
 *   动态监控模式：api.springernature.com → 热词提取 → keywords 产出
 */

import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import { eq, and } from "drizzle-orm";
import type { CrawlerAdapter, CrawlerResult, JournalItem, HotKeywordItem } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BROWSE_SCRIPT = resolve(__dirname, "../../../scripts/springer_browse_crawler.py");

// Springer Link 网页（免费，无需 API Key）
const SPRINGER_NEW_ARTICLES = "https://link.springer.com/search/page/1?sortOrder=newestFirst&query=";

// 重点监控学科（SCI 权重大）
const PRIORITY_SUBJECTS = [
  "medicine-and-public-health",
  "computer-science",
  "engineering",
  "chemistry",
  "biological-sciences",
  "materials-science",
];

export class SpringerLinkCrawler implements CrawlerAdapter {
  platform = "springer-link" as const;
  track = "sci" as const;

  /**
   * CrawlerAdapter 接口 — 每日动态监控模式
   * 通过 Springer Meta API 获取重点学科最新发表趋势
   */
  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const keywords = await this.crawlLatestTrends();

      return {
        platform: "springer-link",
        track: "sci",
        keywords,
        journals: [],
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      logger.error({ err }, "SpringerLinkCrawler daily crawl failed");
      return {
        platform: "springer-link",
        track: "sci",
        keywords: [],
        journals: [],
        success: false,
        error: (err as Error).message,
        crawledAt: now,
      };
    }
  }

  /**
   * 基础库模式 — 月度全量爬取
   * 通过 Python Scrapling 脚本批量爬取期刊列表和详情
   */
  async crawlJournalCatalog(options?: {
    subject?: string;
    proxy?: string;
    maxDetails?: number;
    stealthy?: boolean;
  }): Promise<{ total: number; upserted: number; errors: number }> {
    const { subject, proxy, maxDetails = 30, stealthy = false } = options || {};

    return new Promise((resolve) => {
      const args: string[] = [BROWSE_SCRIPT];

      if (subject) {
        args.push("--subject", subject);
      } else {
        args.push("--all");
      }

      if (proxy) {
        args.push("--proxy", proxy);
      }

      args.push("--max-details", String(maxDetails));

      if (stealthy) {
        args.push("--stealthy");
      }

      const timeout = subject ? 5 * 60_000 : 60 * 60_000; // 单学科 5 分钟，全部 60 分钟

      logger.info(
        { script: BROWSE_SCRIPT, subject: subject || "ALL", proxy, timeout },
        "Starting Springer catalog crawl"
      );

      execFile(
        "python3",
        args,
        { timeout, maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer
        async (error, stdout, stderr) => {
          if (stderr) {
            // stderr 包含进度信息，逐行记录
            for (const line of stderr.split("\n").filter(Boolean)) {
              try {
                const msg = JSON.parse(line);
                if (msg.info) logger.info(msg.info);
                else if (msg.progress) logger.debug(msg.progress);
                else if (msg.warning) logger.warn(msg.warning);
              } catch {
                logger.debug({ stderr: line.slice(0, 200) }, "Springer crawler stderr");
              }
            }
          }

          if (error) {
            logger.error({ err: error.message }, "Springer catalog crawl failed");
            resolve({ total: 0, upserted: 0, errors: 1 });
            return;
          }

          // 解析输出
          const trimmed = (stdout || "").trim();
          if (!trimmed) {
            logger.warn("Springer catalog crawl returned empty output");
            resolve({ total: 0, upserted: 0, errors: 0 });
            return;
          }

          try {
            const data = JSON.parse(trimmed);
            const journalList = data.journals || [];

            logger.info(
              { total: journalList.length, subjects: data.subjects },
              "Springer catalog crawl completed, upserting to DB"
            );

            // 写入数据库
            const result = await this.upsertJournals(journalList);
            resolve(result);
          } catch (parseErr) {
            logger.error(
              { err: (parseErr as Error).message, stdout: trimmed.slice(0, 500) },
              "Failed to parse Springer catalog output"
            );
            resolve({ total: 0, upserted: 0, errors: 1 });
          }
        }
      );
    });
  }

  /**
   * 将爬取的期刊数据 upsert 到 journals 表
   */
  private async upsertJournals(
    journalList: any[]
  ): Promise<{ total: number; upserted: number; errors: number }> {
    let upserted = 0;
    let errors = 0;

    for (const j of journalList) {
      try {
        // 查找是否已存在（按 springerJournalId 或 ISSN）
        let existing = null;

        if (j.springerJournalId) {
          const found = await db
            .select()
            .from(journals)
            .where(eq(journals.springerJournalId, j.springerJournalId))
            .limit(1);
          if (found.length) existing = found[0];
        }

        if (!existing && j.issn) {
          const found = await db
            .select()
            .from(journals)
            .where(eq(journals.issn, j.issn))
            .limit(1);
          if (found.length) existing = found[0];
        }

        const updateData: Record<string, any> = {
          updatedAt: new Date(),
          source: "springer-link",
        };

        if (j.nameEn) updateData.nameEn = j.nameEn;
        if (j.name && !j.nameEn) updateData.nameEn = j.name;
        if (j.issn) updateData.issn = j.issn;
        if (j.discipline) updateData.discipline = j.discipline;
        if (j.impactFactor) updateData.impactFactor = j.impactFactor;
        if (j.citeScore) updateData.citeScore = j.citeScore;
        if (j.apcFee) updateData.apcFee = j.apcFee;
        if (j.publisher) updateData.publisher = j.publisher;
        if (j.scopeDescription) updateData.scopeDescription = j.scopeDescription;
        if (j.website) updateData.website = j.website;
        if (j.springerJournalId) updateData.springerJournalId = j.springerJournalId;
        if (j.timeToFirstDecisionDays) updateData.timeToFirstDecisionDays = j.timeToFirstDecisionDays;
        if (j.isOA !== undefined) updateData.isOA = j.isOA;
        if (j.isHybrid !== undefined) updateData.isHybrid = j.isHybrid;

        updateData.springerFetchedAt = new Date();

        if (existing) {
          await db
            .update(journals)
            .set(updateData)
            .where(eq(journals.id, existing.id));
        }
        // 注意：不在这里 INSERT 新期刊，因为需要 tenantId
        // 新期刊会在 seed 或手动导入时处理

        upserted++;
      } catch (err) {
        logger.warn({ err, journal: j.nameEn || j.name }, "Failed to upsert journal");
        errors++;
      }
    }

    logger.info(
      { total: journalList.length, upserted, errors },
      "Springer journals upsert completed"
    );

    return { total: journalList.length, upserted, errors };
  }

  /**
   * 每日动态：直接爬取 Springer Link 搜索页面获取最新发表趋势
   * 无需 API Key，直接从网页提取文章标题中的高频关键词
   */
  /**
   * 每日动态：Springer Link 热词抓取
   *
   * 注意：Springer Link 有强反爬（Client Challenge / Cloudflare），
   * 从国内云服务器无法直接抓取。日常热度信号由其他 SCI 线平台提供：
   * - LetPub: 期刊分区/IF 数据
   * - OpenAlex: 学术引用趋势
   * - PubMed: 医学方向热点
   * - arXiv: 预印本研究趋势
   *
   * Springer 的核心价值在月度基础库更新（crawlJournalCatalog），
   * 可通过本地电脑或代理服务器执行。
   * 如果未来有可用代理，可在此处配置 SPRINGER_PROXY 启用抓取。
   */
  private async crawlLatestTrends(): Promise<HotKeywordItem[]> {
    const proxy = process.env.SPRINGER_PROXY;

    if (!proxy) {
      logger.info(
        "Springer daily trends skipped (no proxy configured, anti-bot blocks direct access). " +
        "SCI trends covered by LetPub/OpenAlex/PubMed/arXiv."
      );
      return [];
    }

    // 如果配置了代理，尝试通过代理抓取
    const keywords: HotKeywordItem[] = [];
    const now = new Date().toISOString();

    const subjects = [
      { slug: "medicine-and-public-health", discipline: "医学" },
      { slug: "computer-science", discipline: "计算机" },
      { slug: "engineering", discipline: "工程技术" },
      { slug: "chemistry", discipline: "化学" },
    ];

    for (const { slug, discipline } of subjects) {
      try {
        const result = await new Promise<string>((resolve, reject) => {
          execFile(
            "python3",
            [BROWSE_SCRIPT, "--subject", slug, "--max-details", "0", "--stealthy", "--proxy", proxy],
            { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout) => {
              if (error) reject(error);
              else resolve(stdout || "");
            }
          );
        });

        const data = JSON.parse(result.trim() || "{}");
        const journalList = data?.journals || [];

        for (const j of journalList.slice(0, 10)) {
          const name = j.nameEn || j.name || "";
          if (name.length > 5) {
            keywords.push({
              keyword: name,
              heatScore: j.impactFactor ? Math.round(j.impactFactor * 50) : 100,
              trend: "rising" as const,
              discipline,
              platform: "springer-link" as const,
              description: `Springer ${discipline} 活跃期刊 (IF: ${j.impactFactor || "N/A"})`,
              crawledAt: now,
            });
          }
        }

        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000));
      } catch (err) {
        logger.debug({ err, discipline }, "Springer proxy crawl failed (non-fatal)");
      }
    }

    logger.info({ totalKeywords: keywords.length }, "Springer trends crawl completed");
    return keywords;
  }
}
