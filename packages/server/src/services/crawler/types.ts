/**
 * 爬虫通用类型定义
 */

export type PlatformName =
  | "wechat"
  | "baidu"
  | "zhihu"
  | "douyin"
  | "xiaohongshu"
  | "weibo"
  | "baijiahao"
  | "toutiao"
  | "openalex"
  | "pubmed"
  | "arxiv";

export interface RawHotItem {
  keyword: string;
  heatScore: number;
  platform: PlatformName;
  rank?: number;
  url?: string;
  description?: string;
  crawledAt: string; // ISO timestamp
}

export interface CrawlerResult {
  platform: PlatformName;
  items: RawHotItem[];
  success: boolean;
  error?: string;
  crawledAt: string;
}

export interface CrawlerAdapter {
  platform: PlatformName;
  crawl(): Promise<CrawlerResult>;
}
