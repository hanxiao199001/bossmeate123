/**
 * 目录静态知识（A2 第 2 步，8-10）—— 「目录是什么 / 怎么查证」那一章的全部素材。
 *
 * ## 🔴 现状：机制已就绪，数据**空着**，等人工审校
 *
 * 本表要写进文章的是**关于真实机构的事实断言**：谁编制的、去哪儿查。
 * 这类断言一旦写错，错的不是语气而是事实，而且读者一查就露。
 * 所以这里的规矩是：**没经人工确认的字段一律空着，对应句子整段不出现**，
 * 绝不由模型生成一个"看起来对"的机构名或 URL 填进去。
 *
 * 每个目录有一个 `reviewed` 开关，默认 `false` —— 只要它是 false，
 * `catalogFactBlock()` 对该目录**不输出任何内容**，第 6 章自然缺席。
 * 文章少一章无害；写错一个编制机构，整个体裁的可查证性卖点就没了。
 *
 * ## 待老韩确认（确认完把 reviewed 改 true 并填字段）
 *
 *   五个目录各自的：① 编制机构全称 ② 官方查证入口 URL
 *   （CSSCI / CSSCI 扩展版 / 北大核心 / CSCD / SCI 核心）
 *
 * 确认前 10 篇样例里第 6 章不会出现 —— 这是**刻意的**，对比页会标注。
 *
 * ## 版本年不在这里
 *
 * 版本年逐目录不同且随快照走（pku-core 2023、其余 2023-2024），
 * 单一真相源是 `catalog-snapshot` 里每条记录自带的 `catalogYear`。
 * 在本表再抄一份 = 两处会漂移，文章就会写出与所引数字不同版本的限定语。
 */
import type { CatalogTag } from "./catalog-snapshot.js";

export interface CatalogFact {
  /** 目录全称，如「中文社会科学引文索引」。空 = 不写全称 */
  fullName: string;
  /** 编制机构全称。空 = 整句不出现 */
  institution: string;
  /** 官方查证入口 URL。空 = 全文不给任何网址 */
  verifyUrl: string;
  /** 一句话说明这个目录是什么、依据什么遴选。空 = 不出现 */
  whatItIs: string;
  /**
   * 🔴 人工审校开关。**false 时本目录一个字都不输出**。
   * 改 true 之前必须逐字核对上面四个字段 —— 它们是关于真实机构的事实断言。
   */
  reviewed: boolean;
  /** 审校人与日期，如 "老韩 2026-08-11"。留痕用，不进文案 */
  reviewedBy: string;
}

const EMPTY: Omit<CatalogFact, "reviewed" | "reviewedBy"> = {
  fullName: "",
  institution: "",
  verifyUrl: "",
  whatItIs: "",
};

/**
 * ⚠️ 全部 reviewed:false —— 等人工确认。别在这里"顺手补一个"。
 */
export const CATALOG_FACTS: Record<CatalogTag, CatalogFact> = {
  cssci: { ...EMPTY, reviewed: false, reviewedBy: "" },
  "cssci-ext": { ...EMPTY, reviewed: false, reviewedBy: "" },
  "pku-core": { ...EMPTY, reviewed: false, reviewedBy: "" },
  cscd: { ...EMPTY, reviewed: false, reviewedBy: "" },
  "sci-core": { ...EMPTY, reviewed: false, reviewedBy: "" },
};

/** 还没审校的目录。样例脚本与对比页据此标注「第 6 章缺席是预期的」 */
export function pendingCatalogFacts(): CatalogTag[] {
  return (Object.keys(CATALOG_FACTS) as CatalogTag[]).filter((t) => !CATALOG_FACTS[t].reviewed);
}

/**
 * 渲染 prompt 的 `##目录说明(照抄不得改写)##` 块。
 *
 * 逐字段判空：审校过但只填了全称，就只出全称那一句。
 * **返回空串 = 第 6 章整章不出现**，而不是出一段含糊其辞的说明。
 */
export function catalogFactBlock(tags: CatalogTag[]): string {
  const lines: string[] = [];
  for (const t of tags) {
    const f = CATALOG_FACTS[t];
    if (!f?.reviewed) continue; // 未审校 → 一个字都不输出
    if (f.fullName) lines.push(`${t} 的全称是「${f.fullName}」。`);
    if (f.whatItIs) lines.push(f.whatItIs);
    if (f.institution) lines.push(`该目录由${f.institution}编制。`);
    if (f.verifyUrl) lines.push(`官方查证入口：${f.verifyUrl}`);
  }
  return lines.join("\n");
}

/**
 * 允许在正文中出现的网址白名单 —— 只有审校过的查证入口。
 * 校验器用它判「正文给出了未经审校的网址」。
 * 当前为空集，等价于**全文一个网址都不许出现**。
 */
export function allowedUrls(): string[] {
  return Object.values(CATALOG_FACTS)
    .filter((f) => f.reviewed && f.verifyUrl)
    .map((f) => f.verifyUrl);
}
