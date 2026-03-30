/**
 * 关键词聚类 + 标题生成服务
 *
 * 核心逻辑（对齐用户需求）：
 *   1. 从可靠数据源获取当前热门学术关键词
 *   2. 用 DeepSeek 将关键词聚类成 2-3 个关联组合
 *   3. 每个组合生成 1-2 个吸引人的期刊标题
 *   4. 目的：用热门关键词标题引流，吸引有发表需求的人
 *
 * 搜索路径总结：
 *
 * 【国内核心线】
 *   百度学术搜索建议 → https://suggestion.baidu.com/su?wd={种子词}
 *     返回真实用户搜索联想词（公开API，不需要key）
 *
 * 【SCI线】
 *   OpenAlex → https://api.openalex.org/sources?filter=concepts.id:{id}&sort=works_count:desc
 *     全球最大开放学术数据库（免费API）→ 获取高发文量期刊
 *   PubMed → https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={query}
 *     美国国立医学图书馆（免费API）→ 医学方向30天论文热度
 */

import { getProvider } from "../ai/provider-factory.js";
import { logger } from "../../config/logger.js";

// ===== 类型定义 =====

export interface KeywordCluster {
  id: string;                    // 唯一标识
  keywords: string[];            // 2-3个关联关键词
  discipline: string;            // 所属学科
  track: "domestic" | "sci";     // 业务线
  heatScore: number;             // 综合热度
  suggestedTitles: string[];     // AI生成的推荐标题（1-2个）
  reasoning: string;             // 为什么这组关键词关联且热门
  createdAt: string;
}

export interface ClusterResult {
  clusters: KeywordCluster[];
  rawKeywordCount: number;       // 原始关键词数量
  clusterCount: number;          // 聚类数量
  durationMs: number;
}

// ===== 国内核心：学科种子词 =====

const DOMESTIC_SEEDS: Record<string, string[]> = {
  教育: [
    "教育核心期刊", "CSSCI教育", "教育评职称论文",
    "课程思政论文", "双减政策研究", "教育数字化",
    "高等教育改革", "教育学报投稿", "教育类普刊推荐",
  ],
  经济管理: [
    "经济管理核心期刊", "CSSCI经济", "数字经济论文",
    "ESG研究热点", "供应链管理", "碳中和经济",
    "管理学报投稿", "金融研究选题",
  ],
  医学: [
    "医学核心期刊", "中华医学杂志投稿", "医学评职称论文",
    "护理学核心期刊", "中医药核心", "循证医学论文",
    "临床医学投稿经验", "医学Meta分析",
  ],
  农林: [
    "农业核心期刊", "农林科学核心", "食品科学核心",
    "农业经济论文", "畜牧兽医投稿",
  ],
  工程技术: [
    "工程技术核心期刊", "EI投稿经验", "机械工程学报",
    "电气工程核心", "自动化学报投稿",
  ],
  法学: [
    "法学核心期刊", "CSSCI法学", "法律论文发表",
  ],
  心理学: [
    "心理学核心期刊", "心理学报投稿", "心理科学进展",
  ],
};

// ===== SCI：医学热门方向 =====

const SCI_MEDICAL_QUERIES = [
  "cancer immunotherapy",
  "machine learning diagnosis",
  "gut microbiome",
  "cardiovascular disease",
  "traditional chinese medicine",
  "nursing care quality",
  "public health policy",
  "diabetes treatment",
];

// ===== OpenAlex 学科 =====

const OPENALEX_FIELDS = [
  { id: "C71924100", label: "医学" },
  { id: "C127313418", label: "能源" },
  { id: "C41008148", label: "计算机" },
];

// ===== 核心函数：一键获取关键词聚类 =====

export async function generateKeywordClusters(
  track: "domestic" | "sci" | "all" = "all",
  discipline?: string
): Promise<ClusterResult> {
  const startTime = Date.now();

  logger.info({ track, discipline }, "开始关键词聚类任务");

  // Step 1: 收集原始关键词
  let rawKeywords: Array<{ keyword: string; discipline: string; source: string; heat: number }> = [];

  if (track === "domestic" || track === "all") {
    const domesticKws = await fetchDomesticKeywords(discipline);
    rawKeywords.push(...domesticKws);
  }

  if (track === "sci" || track === "all") {
    const sciKws = await fetchSciKeywords(discipline);
    rawKeywords.push(...sciKws);
  }

  logger.info({ rawCount: rawKeywords.length }, "原始关键词收集完成");

  if (rawKeywords.length === 0) {
    return {
      clusters: [],
      rawKeywordCount: 0,
      clusterCount: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 2: 用 DeepSeek 聚类 + 生成标题
  const clusters = await clusterAndGenerateTitles(rawKeywords, track);

  logger.info(
    { rawCount: rawKeywords.length, clusterCount: clusters.length, durationMs: Date.now() - startTime },
    "关键词聚类任务完成"
  );

  return {
    clusters,
    rawKeywordCount: rawKeywords.length,
    clusterCount: clusters.length,
    durationMs: Date.now() - startTime,
  };
}


// ===== Step 1a: 国内核心 — 百度搜索建议获取热词 =====

async function fetchDomesticKeywords(
  targetDiscipline?: string
): Promise<Array<{ keyword: string; discipline: string; source: string; heat: number }>> {
  const results: Array<{ keyword: string; discipline: string; source: string; heat: number }> = [];

  const disciplines = targetDiscipline
    ? { [targetDiscipline]: DOMESTIC_SEEDS[targetDiscipline] || [] }
    : DOMESTIC_SEEDS;

  for (const [discipline, seeds] of Object.entries(disciplines)) {
    for (const seed of seeds) {
      try {
        const suggestions = await baiduSuggest(seed);
        for (let i = 0; i < suggestions.length; i++) {
          results.push({
            keyword: suggestions[i],
            discipline,
            source: "baidu",
            heat: 100 - i * 15, // 排名越前热度越高
          });
        }
        await sleep(200);
      } catch {
        // 单次失败不影响
      }
    }
  }

  // 去重
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.keyword.toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===== Step 1b: SCI — OpenAlex + PubMed 获取热门方向 =====

async function fetchSciKeywords(
  targetDiscipline?: string
): Promise<Array<{ keyword: string; discipline: string; source: string; heat: number }>> {
  const results: Array<{ keyword: string; discipline: string; source: string; heat: number }> = [];

  // PubMed: 医学方向30天论文数（实时热度指标）
  if (!targetDiscipline || targetDiscipline === "医学") {
    for (const query of SCI_MEDICAL_QUERIES) {
      try {
        const count = await pubmedSearchCount(query);
        if (count > 0) {
          results.push({
            keyword: query,
            discipline: "医学",
            source: "pubmed",
            heat: Math.min(count, 5000), // cap at 5000
          });
        }
        await sleep(400);
      } catch {
        // 继续
      }
    }
  }

  // OpenAlex: 高发文量期刊（对应热门学科方向）
  for (const field of OPENALEX_FIELDS) {
    if (targetDiscipline && field.label !== targetDiscipline) continue;
    try {
      const journals = await openalexTopJournals(field.id);
      for (const j of journals) {
        results.push({
          keyword: j.name,
          discipline: field.label,
          source: "openalex",
          heat: j.worksCount,
        });
      }
      await sleep(200);
    } catch {
      // 继续
    }
  }

  return results;
}


// ===== Step 2: DeepSeek AI 聚类 + 标题生成 =====

async function clusterAndGenerateTitles(
  rawKeywords: Array<{ keyword: string; discipline: string; source: string; heat: number }>,
  track: "domestic" | "sci" | "all"
): Promise<KeywordCluster[]> {
  const provider = getProvider("cheap");
  if (!provider) {
    logger.error("DeepSeek 未配置，无法执行关键词聚类");
    return [];
  }

  // 按学科分组，每个学科取热度最高的20个关键词
  const byDiscipline = new Map<string, typeof rawKeywords>();
  for (const kw of rawKeywords) {
    const list = byDiscipline.get(kw.discipline) || [];
    list.push(kw);
    byDiscipline.set(kw.discipline, list);
  }

  const allClusters: KeywordCluster[] = [];
  let clusterId = 1;

  for (const [discipline, keywords] of byDiscipline) {
    // 取热度最高的20个
    const top20 = keywords
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 20);

    const keywordList = top20.map((k) => `${k.keyword} (热度:${k.heat})`).join("\n");

    const systemPrompt = `你是期刊代发行业的内容营销专家。你的任务是把一组学术关键词聚类成2-3个关联词的组合，然后为每个组合生成一个能吸引潜在客户点进来的期刊推荐标题。

目标读者：准备发论文的硕博研究生、需要评职称的高校教师、医院医生
目的：通过热门关键词标题吸引他们，引流到我们的期刊推荐服务

标题要求：
1. 包含2-3个关联关键词（自然融入，不生硬）
2. 标题25字以内
3. 有数据感（"2026年"、"TOP10"、"录用率80%"等）
4. 直击痛点（"好发"、"录用快"、"不花钱"、"周期短"）
5. 风格参考公众号爆款标题`;

    const userPrompt = `学科：${discipline}
业务线：${track === "domestic" ? "国内核心期刊" : track === "sci" ? "SCI国际期刊" : "综合"}

以下是当前热门关键词（含热度分）：
${keywordList}

请将这些关键词聚类成5-8个组合，每组2-3个关联词，并为每组生成1-2个引流标题。

严格以JSON格式返回：
{
  "clusters": [
    {
      "keywords": ["关键词1", "关键词2", "关键词3"],
      "heatScore": 85,
      "suggestedTitles": ["2026年XXX核心期刊推荐：这3本录用率最高"],
      "reasoning": "这三个关键词都和XX方向相关，近期搜索热度上升"
    }
  ]
}

只返回JSON，不要其他内容。`;

    try {
      const response = await provider.chat({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        maxTokens: 3000,
      });

      const jsonStr = response.content
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();

      const parsed = JSON.parse(jsonStr) as {
        clusters: Array<{
          keywords: string[];
          heatScore: number;
          suggestedTitles: string[];
          reasoning: string;
        }>;
      };

      for (const c of parsed.clusters) {
        allClusters.push({
          id: `cluster-${clusterId++}`,
          keywords: c.keywords,
          discipline,
          track: track === "all"
            ? (["教育", "经济管理", "农林", "法学", "心理学", "工程技术"].includes(discipline) ? "domestic" : "sci")
            : track,
          heatScore: c.heatScore,
          suggestedTitles: c.suggestedTitles,
          reasoning: c.reasoning,
          createdAt: new Date().toISOString(),
        });
      }

      logger.info({ discipline, clusterCount: parsed.clusters.length }, "学科聚类完成");
    } catch (err) {
      logger.error({ discipline, error: String(err) }, "DeepSeek 聚类失败");
    }
  }

  // 按热度排序
  allClusters.sort((a, b) => b.heatScore - a.heatScore);

  return allClusters;
}


// ===== 底层 API 封装 =====

/**
 * 百度搜索建议API
 * URL: https://suggestion.baidu.com/su?wd={query}&cb=cb
 * 返回: cb({q:"query",s:["联想词1","联想词2",...]})
 */
async function baiduSuggest(query: string): Promise<string[]> {
  const url = `https://suggestion.baidu.com/su?wd=${encodeURIComponent(query)}&cb=cb&ie=utf-8&t=${Date.now()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    // 加 ie=utf-8 强制百度返回 UTF-8 编码
    const utf8Url = url.includes("ie=") ? url : url + "&ie=utf-8";
    const res = await fetch(utf8Url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.baidu.com/",
        "Accept-Charset": "utf-8",
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];

    const buf = await res.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);

    const match = text.match(/\[([^\]]*)\]/);
    if (!match) return [];

    const suggestions: string[] = JSON.parse(`[${match[1]}]`);
    return suggestions.filter((s) => s.length >= 4 && s.length <= 50).slice(0, 5);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * PubMed E-utilities 搜索计数
 * URL: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={query}&reldate=30&rettype=count&retmode=json
 * 返回: {esearchresult: {count: "1234"}}
 */
async function pubmedSearchCount(query: string): Promise<number> {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&datetype=edat&reldate=30&rettype=count&retmode=json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return 0;
    const data = (await res.json()) as { esearchresult?: { count?: string } };
    return parseInt(data.esearchresult?.count || "0", 10);
  } catch {
    return 0;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * OpenAlex 高发文量期刊
 * URL: https://api.openalex.org/sources?filter=type:journal,concepts.id:{conceptId}&sort=works_count:desc&per_page=10
 * 返回: {results: [{display_name, works_count, ...}]}
 */
async function openalexTopJournals(conceptId: string): Promise<Array<{ name: string; worksCount: number }>> {
  const url = `https://api.openalex.org/sources?filter=type:journal,concepts.id:${conceptId}&sort=works_count:desc&per_page=10&mailto=bossmate@example.com`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      results: Array<{ display_name: string; works_count: number }>;
    };

    return (data.results || []).map((r) => ({
      name: r.display_name,
      worksCount: r.works_count,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
