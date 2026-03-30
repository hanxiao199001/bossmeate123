/**
 * 风格学习服务
 *
 * 功能：
 * 1. 通过微信公众号API抓取自己的历史文章
 * 2. 搜狗微信搜索抓取同行公众号文章
 * 3. DeepSeek AI 分析文章风格特征
 * 4. 自动生成模版库
 */

import { logger } from "../config/logger.js";
import { getAccessToken } from "./wechat.js";
import { getProvider } from "./ai/provider-factory.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ===== 类型定义 =====

export interface ArticleMeta {
  title: string;
  url: string;
  digest: string;
  content?: string;       // 正文（HTML或纯文本）
  publishTime?: string;
  source: string;          // "self" | "peer"
  accountName?: string;
}

export interface StyleAnalysis {
  accountName: string;
  source: "self" | "peer";
  articleCount: number;
  titlePatterns: {
    avgLength: number;
    commonFormats: string[];    // 如 "数字型(TOP10)"、"问句型"、"对比型"
    hooks: string[];            // 高频钩子词
    examples: string[];
  };
  contentStyle: {
    avgLength: number;
    structure: string[];        // 常见段落结构
    tone: string;               // 语气风格
    commonSections: string[];   // 常见板块
    keyPhrases: string[];       // 高频用语
  };
  layoutFeatures: {
    hasEmoji: boolean;
    hasBold: boolean;
    hasQuote: boolean;
    hasTable: boolean;
    hasList: boolean;
    hasImage: boolean;
    headingStyle: string;       // 标题样式描述
  };
  overallSummary: string;       // AI一句话总结
}

export interface GeneratedTemplate {
  id: string;
  name: string;
  desc: string;
  icon: string;
  source: string;               // 来源: "self_style" | "peer_style" | "ai_generated"
  sourceAccount?: string;
  sections: string[];
  titleFormula: string;         // 标题公式，如 "2026年{学科}核心期刊TOP{N}：这{M}本{特点}"
  styleTags: string[];          // 风格标签
  sampleTitle: string;
  prompt: string;               // 给AI的风格指令
}

// ===== 1. 抓取自己公众号历史文章 =====

/**
 * 通过微信公众号API获取历史文章列表
 * 接口: GET /cgi-bin/freepublish/batchget
 */
export async function fetchOwnArticles(
  tenantId: string,
  count: number = 20
): Promise<ArticleMeta[]> {
  const token = await getAccessToken(tenantId);

  const articles: ArticleMeta[] = [];
  let offset = 0;
  const batchSize = 20;

  while (articles.length < count) {
    const url = `https://api.weixin.qq.com/cgi-bin/freepublish/batchget?access_token=${token}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset,
        count: Math.min(batchSize, count - articles.length),
        no_content: 0, // 返回正文内容
      }),
    });

    const data = (await resp.json()) as any;

    if (data.errcode) {
      // 40001 = token无效, 48001 = 未授权freepublish
      // 降级尝试 material/batchget_material
      if (data.errcode === 48001) {
        logger.warn("freepublish API 未授权，降级到 material 接口");
        return fetchOwnArticlesViaMaterial(token, count);
      }
      logger.error({ errcode: data.errcode, errmsg: data.errmsg }, "获取已发布文章失败");
      break;
    }

    if (!data.item || data.item.length === 0) break;

    for (const item of data.item) {
      if (!item.content || !item.content.news_item) continue;
      for (const news of item.content.news_item) {
        articles.push({
          title: news.title || "",
          url: news.url || "",
          digest: news.digest || "",
          content: news.content || "",
          publishTime: item.update_time
            ? new Date(item.update_time * 1000).toISOString()
            : undefined,
          source: "self",
        });
      }
    }

    offset += batchSize;
    if (data.total_count <= offset) break;

    // 限速
    await sleep(300);
  }

  logger.info({ count: articles.length }, "获取自己公众号文章完成");
  return articles.slice(0, count);
}

/**
 * 降级方案：通过素材管理接口获取图文素材
 */
async function fetchOwnArticlesViaMaterial(
  token: string,
  count: number
): Promise<ArticleMeta[]> {
  const url = `https://api.weixin.qq.com/cgi-bin/material/batchget_material?access_token=${token}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "news", offset: 0, count: Math.min(count, 20) }),
  });

  const data = (await resp.json()) as any;
  const articles: ArticleMeta[] = [];

  if (data.item) {
    for (const item of data.item) {
      if (!item.content || !item.content.news_item) continue;
      for (const news of item.content.news_item) {
        articles.push({
          title: news.title || "",
          url: news.url || "",
          digest: news.digest || "",
          content: news.content || "",
          publishTime: item.update_time
            ? new Date(item.update_time * 1000).toISOString()
            : undefined,
          source: "self",
        });
      }
    }
  }

  return articles;
}

// ===== 2. 搜索同行公众号文章 =====

/**
 * 期刊发表领域头部公众号列表
 */
const PEER_ACCOUNTS = [
  "学术论文投稿指南",
  "科研圈",
  "募格学术",
  "学术志",
  "iNature",
  "学术桥",
  "SCI投稿指南",
  "论文写作与发表",
  "核心期刊投稿",
  "学术圈那些事",
];

/**
 * 搜索同行公众号文章（通过微信搜索 / 搜狗微信搜索）
 */
export async function fetchPeerArticles(
  accountNames?: string[],
  maxPerAccount: number = 5
): Promise<ArticleMeta[]> {
  const accounts = accountNames && accountNames.length > 0 ? accountNames : PEER_ACCOUNTS;
  const allArticles: ArticleMeta[] = [];

  for (const account of accounts) {
    try {
      const articles = await searchWechatArticles(account, maxPerAccount);
      allArticles.push(
        ...articles.map((a) => ({ ...a, source: "peer" as const, accountName: account }))
      );
      logger.info({ account, count: articles.length }, "同行文章抓取完成");
    } catch (err) {
      logger.warn({ account, error: String(err) }, "同行文章抓取失败");
    }
    await sleep(1000); // 限速
  }

  return allArticles;
}

/**
 * 通过搜狗微信搜索获取公众号文章
 */
async function searchWechatArticles(
  accountName: string,
  limit: number
): Promise<ArticleMeta[]> {
  const searchUrl = `https://weixin.sogou.com/weixin?type=1&s_from=input&query=${encodeURIComponent(accountName)}&ie=utf8`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(searchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return [];

    const html = await resp.text();

    // 从搜索结果中提取文章列表
    const articles: ArticleMeta[] = [];
    const titleRegex = /<h3>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const digestRegex = /<p class="txt-info">([\s\S]*?)<\/p>/gi;

    let match;
    while ((match = titleRegex.exec(html)) !== null && articles.length < limit) {
      const url = match[1].replace(/&amp;/g, "&");
      const title = match[2].replace(/<[^>]+>/g, "").trim();

      if (title.length < 5) continue;

      // 尝试获取摘要
      const digestMatch = digestRegex.exec(html);
      const digest = digestMatch ? digestMatch[1].replace(/<[^>]+>/g, "").trim() : "";

      articles.push({
        title,
        url,
        digest,
        source: "peer",
        accountName,
      });
    }

    // 如果搜狗微信搜索没结果，用备选方案
    if (articles.length === 0) {
      return searchViaAlternative(accountName, limit);
    }

    return articles;
  } catch {
    clearTimeout(timeout);
    return searchViaAlternative(accountName, limit);
  }
}

/**
 * 备选搜索方案：用百度搜索 site:mp.weixin.qq.com
 */
async function searchViaAlternative(
  accountName: string,
  limit: number
): Promise<ArticleMeta[]> {
  const query = `site:mp.weixin.qq.com ${accountName} 期刊 发表`;
  const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8&rn=${limit}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(searchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        "Accept-Charset": "utf-8",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return [];

    const buf = await resp.arrayBuffer();
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);

    const articles: ArticleMeta[] = [];
    const resultRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = resultRegex.exec(html)) !== null && articles.length < limit) {
      const title = match[2].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
      const url = match[1];
      if (title.length < 5 || !url) continue;

      articles.push({
        title,
        url,
        digest: "",
        source: "peer",
        accountName,
      });
    }

    return articles;
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

// ===== 3. AI 风格分析 =====

/**
 * 用 DeepSeek AI 分析一组文章的风格特征
 */
export async function analyzeStyle(
  articles: ArticleMeta[],
  accountName: string,
  source: "self" | "peer"
): Promise<StyleAnalysis | null> {
  if (articles.length === 0) return null;

  const provider = getProvider("cheap");
  if (!provider) {
    logger.error("没有可用的AI模型，无法分析风格");
    return null;
  }

  // 准备分析素材：标题列表 + 前3篇文章的内容片段
  const titles = articles.map((a) => a.title);
  const contentSamples = articles
    .filter((a) => a.content)
    .slice(0, 3)
    .map((a) => {
      // 去掉HTML标签，截取前2000字
      const text = (a.content || "")
        .replace(/<[^>]+>/g, "")
        .replace(/&[a-z]+;/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000);
      return `【${a.title}】\n${text}`;
    });

  const prompt = `你是一个专业的公众号内容分析师。请深度分析以下公众号「${accountName}」的文章风格。

【标题列表（共${titles.length}篇）】
${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}

${contentSamples.length > 0 ? `【文章内容样本】\n${contentSamples.join("\n\n---\n\n")}` : ""}

请从以下维度分析，输出JSON格式（不要代码块）：

{
  "titlePatterns": {
    "avgLength": 标题平均字数,
    "commonFormats": ["格式1如'数字榜单型(TOP10)'", "格式2", "格式3"],
    "hooks": ["高频钩子词1", "钩子词2", "..."],
    "examples": ["3个最典型的标题"]
  },
  "contentStyle": {
    "avgLength": 正文平均字数估计,
    "structure": ["常见段落结构，如'痛点导语→期刊推荐→投稿建议→总结引导'"],
    "tone": "语气风格描述，如'专业权威但亲和'",
    "commonSections": ["常见板块名称，如'期刊推荐'、'投稿攻略'"],
    "keyPhrases": ["高频用语/口头禅，如'建议收藏'、'干货分享'"]
  },
  "layoutFeatures": {
    "hasEmoji": true/false,
    "hasBold": true/false,
    "hasQuote": true/false,
    "hasTable": true/false,
    "hasList": true/false,
    "hasImage": true/false,
    "headingStyle": "标题样式描述"
  },
  "overallSummary": "一句话总结这个账号的内容风格特点"
}`;

  try {
    const result = await provider.chat({
      messages: [{ role: "user", content: prompt }],
      model: "deepseek-chat",
      temperature: 0.3,
    });

    const cleaned = result.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      accountName,
      source,
      articleCount: articles.length,
      ...parsed,
    };
  } catch (err) {
    logger.error({ err, accountName }, "AI风格分析失败");
    return null;
  }
}

// ===== 4. 自动生成模版库 =====

/**
 * 根据风格分析结果，自动生成文章模版
 */
export async function generateTemplates(
  styleAnalyses: StyleAnalysis[]
): Promise<GeneratedTemplate[]> {
  const provider = getProvider("cheap");
  if (!provider) return [];

  // 汇总所有风格特征
  const stylesSummary = styleAnalyses.map((s) =>
    `【${s.accountName}（${s.source === "self" ? "自己" : "同行"}）】\n` +
    `风格: ${s.overallSummary}\n` +
    `标题格式: ${s.titlePatterns.commonFormats.join("、")}\n` +
    `内容结构: ${s.contentStyle.structure.join("；")}\n` +
    `语气: ${s.contentStyle.tone}\n` +
    `常见板块: ${s.contentStyle.commonSections.join("、")}`
  ).join("\n\n");

  const prompt = `你是一个公众号模版设计专家。根据以下风格分析，为"期刊推荐/投稿指南"类公众号设计5-8个实用的文章模版。

${stylesSummary}

请为每个模版输出JSON数组格式（不要代码块）：
[
  {
    "name": "模版名称（4-6字）",
    "desc": "模版描述（一句话）",
    "icon": "一个合适的emoji",
    "source": "self_style或peer_style或ai_generated",
    "sourceAccount": "参考的账号名（如果有）",
    "sections": ["段落1名称", "段落2", "..."],
    "titleFormula": "标题公式，用{变量}表示可替换部分",
    "styleTags": ["标签1", "标签2"],
    "sampleTitle": "一个示例标题",
    "prompt": "给AI写文章时的风格指令（50-100字，描述语气、排版、用词等要求）"
  }
]

要求：
1. 至少1个模版来自"自己"的风格（如果有分析数据）
2. 至少2个模版来自同行的优秀风格
3. 至少1个是创新融合型
4. 每个模版的sections应该有4-6个段落
5. prompt要具体可执行`;

  try {
    const result = await provider.chat({
      messages: [{ role: "user", content: prompt }],
      model: "deepseek-chat",
      temperature: 0.5,
    });

    const cleaned = result.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const templates: GeneratedTemplate[] = JSON.parse(cleaned);

    // 给每个模版添加ID
    return templates.map((t, i) => ({
      ...t,
      id: `learned_${Date.now()}_${i}`,
    }));
  } catch (err) {
    logger.error({ err }, "模版生成失败");
    return [];
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
