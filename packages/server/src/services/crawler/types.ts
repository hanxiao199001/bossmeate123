/**
 * 爬虫通用类型定义
 *
 * 两条业务线：
 * 1. 国内核心线：抓热门学科关键词 → 做泛流量内容
 * 2. SCI线：按LetPub大类抓期刊数据 → 匹配科研产品
 */

// ===== 平台定义 =====
export type PlatformName =
  // 国内核心线：热门学科关键词来源
  | "baidu-academic"    // 百度学术热词
  | "wechat-index"      // 微信指数趋势
  | "zhihu-academic"    // 知乎学术热榜
  | "policy-monitor"    // 职称政策监控
  // SCI线：期刊数据源
  | "letpub"            // LetPub期刊分类库
  | "openalex"          // OpenAlex学术数据
  | "pubmed"            // PubMed医学论文
  | "arxiv"             // arXiv预印本
  | "springer-link"     // Springer Link 期刊数据（基础库+动态监控）
  // 社交媒体热搜线：泛流量热点来源
  | "baidu"             // 百度热搜
  | "toutiao"           // 今日头条热榜
  | "weibo"             // 微博热搜
  | "zhihu";            // 知乎热榜

// ===== 业务线标签 =====
export type CrawlerTrack = "domestic" | "sci" | "social";

// ===== 社交媒体热搜线：原始热点条目 =====
export interface RawHotItem {
  keyword: string;
  heatScore: number;
  platform: PlatformName;
  rank?: number;
  url?: string;
  description?: string;
  crawledAt: string;
}

// ===== 国内核心线：热门关键词 =====
export interface HotKeywordItem {
  keyword: string;           // 关键词
  heatScore: number;         // 热度分
  trend: "rising" | "stable" | "declining"; // 趋势
  discipline: string;        // 所属大类学科
  platform: PlatformName;
  rank?: number;
  url?: string;
  description?: string;
  crawledAt: string;
}

// ===== SCI线：期刊信息 =====
export interface JournalItem {
  name: string;              // 期刊英文名
  nameCn?: string;           // 期刊中文名
  issn?: string;
  discipline: string;        // LetPub大类学科
  subdiscipline?: string;    // 小类学科
  partition?: string;        // 分区 Q1/Q2/Q3/Q4
  impactFactor?: number;     // 影响因子
  acceptanceRate?: number;   // 录用率
  reviewCycle?: string;      // 审稿周期
  annualVolume?: number;     // 年发文量
  isWarningList?: boolean;   // 是否预警
  isOA?: boolean;            // 是否开放获取
  selfCiteRate?: number;     // 自引率
  url?: string;              // LetPub链接
  platform: PlatformName;
  crawledAt: string;
}

// ===== 统一结果 =====
export interface CrawlerResult {
  platform: PlatformName;
  track?: CrawlerTrack;
  keywords: HotKeywordItem[];    // 国内核心线产出
  journals: JournalItem[];       // SCI线产出
  items?: RawHotItem[];           // 社交媒体热搜线产出
  success: boolean;
  error?: string;
  crawledAt: string;
}

// ===== 适配器接口 =====
export interface CrawlerAdapter {
  platform: PlatformName;
  track?: CrawlerTrack;
  crawl(): Promise<CrawlerResult>;
}

// ===== LetPub大类学科（来自录音里员工提到的核心分类）=====
export const LETPUB_DISCIPLINES = [
  { code: "medicine", label: "医学", labelEn: "Medicine" },
  { code: "energy", label: "能源", labelEn: "Energy" },
  { code: "computer", label: "计算机", labelEn: "Computer Science" },
  { code: "engineering", label: "工程技术", labelEn: "Engineering" },
  { code: "economics", label: "经济管理", labelEn: "Economics & Management" },
  { code: "biology", label: "生物学", labelEn: "Biology" },
  { code: "chemistry", label: "化学", labelEn: "Chemistry" },
  { code: "physics", label: "物理", labelEn: "Physics" },
  { code: "materials", label: "材料科学", labelEn: "Materials Science" },
  { code: "environment", label: "环境科学", labelEn: "Environmental Science" },
  { code: "agriculture", label: "农林科学", labelEn: "Agricultural Science" },
  { code: "psychology", label: "心理学", labelEn: "Psychology" },
  { code: "education", label: "教育学", labelEn: "Education" },
  { code: "law", label: "法学", labelEn: "Law" },
  { code: "math", label: "数学", labelEn: "Mathematics" },
] as const;

// 国内核心热门学科（教育占70%核心市场，其次经济、农林）
export const DOMESTIC_HOT_DISCIPLINES = [
  { code: "education", label: "教育" },
  { code: "economics", label: "经济管理" },
  { code: "medicine", label: "医学" },
  { code: "agriculture", label: "农林" },
  { code: "engineering", label: "工程技术" },
  { code: "environment", label: "环境科学" },
  { code: "law", label: "法学" },
  { code: "psychology", label: "心理学" },
] as const;
