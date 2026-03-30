/**
 * LetPub 期刊数据爬虫 —— SCI线
 *
 * 数据源：LetPub（https://www.letpub.com.cn）
 * 目的：按大类学科抓取SCI期刊列表，获取分区/IF/录用率/审稿周期
 *
 * 员工录音洞察：
 * - "SCI没有热点榜，靠产品驱动"
 * - "你想主打哪一个就主打哪一个，选录用率快的、周期快的，或者录用率高周期快的"
 * - "客户要的是：不花钱，快录用，不太水"
 * - 三大核心领域：医学（最大）、能源、计算机
 *
 * 策略：
 * 1. LetPub 的期刊查询接口是 POST 表单，按学科分类检索
 * 2. 解析返回的 HTML 表格，提取期刊数据
 * 3. 按录用率 + 审稿周期 + 影响因子综合排序
 */

import { logger } from "../../config/logger.js";
import type { CrawlerAdapter, CrawlerResult, JournalItem } from "./types.js";
import { LETPUB_DISCIPLINES } from "./types.js";

// LetPub 学科分类ID映射（从LetPub网站的下拉菜单提取）
const LETPUB_CATEGORY_IDS: Record<string, string> = {
  medicine: "5",
  energy: "8",
  computer: "7",
  engineering: "4",
  economics: "14",
  biology: "1",
  chemistry: "3",
  physics: "9",
  materials: "6",
  environment: "8",  // 环境归入能源大类
  agriculture: "2",
  psychology: "12",
  education: "15",
  math: "10",
};

export class LetPubCrawler implements CrawlerAdapter {
  platform = "letpub" as const;
  track = "sci" as const;

  async crawl(): Promise<CrawlerResult> {
    const now = new Date().toISOString();

    try {
      const journals: JournalItem[] = [];

      // 优先爬取三大核心领域（医学、能源、计算机）
      const priorityDisciplines = ["medicine", "energy", "computer"];
      const otherDisciplines = LETPUB_DISCIPLINES
        .map((d) => d.code)
        .filter((code) => !priorityDisciplines.includes(code));

      const allDisciplines = [...priorityDisciplines, ...otherDisciplines];

      for (const code of allDisciplines) {
        const discipline = LETPUB_DISCIPLINES.find((d) => d.code === code);
        if (!discipline) continue;

        const categoryId = LETPUB_CATEGORY_IDS[code];
        if (!categoryId) continue;

        try {
          const items = await this.fetchJournalsByCategory(
            categoryId,
            discipline.label,
            discipline.labelEn
          );
          journals.push(
            ...items.map((item) => ({ ...item, crawledAt: now }))
          );
          logger.info(
            { discipline: discipline.label, count: items.length },
            "LetPub 学科期刊抓取完成"
          );
          // 请求间隔
          await new Promise((r) => setTimeout(r, 1000));
        } catch (err) {
          logger.warn(
            { discipline: discipline.label, error: String(err) },
            "LetPub 学科抓取失败"
          );
        }
      }

      // 去重（按ISSN或期刊名）
      const seen = new Set<string>();
      const unique = journals.filter((j) => {
        const key = j.issn || j.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      logger.info(
        { platform: "letpub", total: unique.length },
        "LetPub 期刊数据抓取全部完成"
      );

      return {
        platform: "letpub",
        track: "sci",
        keywords: [],
        journals: unique,
        success: true,
        crawledAt: now,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error: errorMsg }, "LetPub 抓取失败");
      return {
        platform: "letpub",
        track: "sci",
        keywords: [],
        journals: [],
        success: false,
        error: errorMsg,
        crawledAt: now,
      };
    }
  }

  /**
   * 按LetPub学科分类获取期刊列表
   * LetPub 使用 POST 表单提交查询
   */
  private async fetchJournalsByCategory(
    categoryId: string,
    disciplineLabel: string,
    disciplineLabelEn: string
  ): Promise<Omit<JournalItem, "crawledAt">[]> {
    // LetPub 的期刊查询URL
    const url = "https://www.letpub.com.cn/index.php?page=journalapp&view=search";

    const formData = new URLSearchParams({
      searchname: "",
      searchissn: "",
      searchfield: categoryId,
      searchopen: "",
      searchsub: "",
      searchletter: "",
      "searchsort": "relevance",
      searchimpactlow: "",
      searchimpacthigh: "",
      currentpage: "1",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.letpub.com.cn/index.php?page=journalapp",
        Accept: "text/html",
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new Error(`LetPub HTTP ${response.status}`);
    }

    const html = await response.text();
    return this.parseJournalTable(html, disciplineLabel);
  }

  /**
   * 解析 LetPub 返回的期刊列表 HTML
   * LetPub 的表格结构相对稳定，用正则提取
   */
  private parseJournalTable(
    html: string,
    discipline: string
  ): Omit<JournalItem, "crawledAt">[] {
    const journals: Omit<JournalItem, "crawledAt">[] = [];

    // LetPub 表格行匹配（每行是一个期刊）
    // 表格列通常为：期刊名、ISSN、IF、分区、审稿周期、录用率等
    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = html.match(rowRegex) || [];

    for (const row of rows) {
      // 跳过表头行
      if (row.includes("<th")) continue;

      // 提取所有 td 单元格的文本内容
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells: string[] = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(row)) !== null) {
        cells.push(
          cellMatch[1]
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        );
      }

      // LetPub 通常有至少 6 列数据
      if (cells.length < 4) continue;

      // 尝试提取期刊名（通常在第一列，可能包含链接文本）
      const nameMatch = row.match(/<a[^>]*>([\s\S]*?)<\/a>/);
      const name = nameMatch
        ? nameMatch[1].replace(/<[^>]+>/g, "").trim()
        : cells[0];

      if (!name || name.length < 2) continue;

      // 尝试提取 ISSN
      const issnMatch = row.match(/(\d{4}-\d{3}[\dxX])/);
      const issn = issnMatch ? issnMatch[1] : undefined;

      // 尝试提取影响因子
      const ifMatch = row.match(/(\d+\.\d+)/);
      const impactFactor = ifMatch ? parseFloat(ifMatch[1]) : undefined;

      // 尝试提取分区（Q1-Q4）
      const partitionMatch = row.match(/Q[1-4]/i);
      const partition = partitionMatch
        ? partitionMatch[0].toUpperCase()
        : undefined;

      // 尝试提取审稿周期
      const cycleMatch = row.match(/([\d.]+)\s*(?:周|月|week|month)/i);
      const reviewCycle = cycleMatch ? cycleMatch[0] : undefined;

      // 检测是否预警
      const isWarning =
        /预警|warning|黑名单/i.test(row);

      // 检测是否OA
      const isOA = /open\s*access|OA|开放获取/i.test(row);

      journals.push({
        name,
        issn,
        discipline,
        partition,
        impactFactor,
        reviewCycle,
        isWarningList: isWarning,
        isOA,
        platform: "letpub",
      });
    }

    // 如果HTML解析失败（页面结构变了），返回空而不是垃圾数据
    if (journals.length === 0) {
      logger.warn(
        { discipline },
        "LetPub HTML解析未匹配到期刊数据，可能页面结构已变更"
      );
    }

    return journals.slice(0, 50); // 每个学科最多取50本期刊
  }
}
