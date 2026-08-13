/**
 * 文章模板注册中心（T4-3-1）
 *
 * 用途：把"AI 生成期刊推荐文章"的 HTML 渲染层从硬编码单一模板，抽象为可注册的多模板形态。
 *
 * 关键决策：
 * - htmlGenerator 是契约的核心 — 接收 (journal, aiContent, abstracts)，返回完整 HTML 字符串
 * - aiPromptHints 留给后续模板（T4-3-2/3）：不同模板可能需要不同风格的 AI 文案（如对比型需要表格、故事型需要场景）
 * - DEFAULT_TEMPLATE_ID = 'shunshi-style'（task #11 V7 e2e 验证后切换；之前 'data-card'）：
 *   shunshi-style 是唯一渲染 V7 4 个深度分析章节的模板，让 prompt 升级在所有新文章默认生效。
 *   data-card / storytelling / listicle 仍可显式 templateId 选用，向后兼容不破坏。
 *
 * 不在本 PR 范围：
 * - 模板 B/C 的实现 → T4-3-2 / T4-3-3
 * - variants 选不同模板 → T4-3-4
 * - 前端模板标识展示 → T4-3-5
 */

import type { JournalInfo, CollectionResult } from "../data-collection/journal-content-collector.js";
import type { AIGeneratedContent } from "./journal-template.js";
import { generateWechatJournalArticleHtml } from "../publisher/adapters/wechat-article-template.js";
import { generateStorytellingHtml } from "../publisher/adapters/storytelling-template.js";
import { generateListicleHtml } from "../publisher/adapters/listicle-template.js";
import { generateShunshiStyleHtml } from "../publisher/adapters/shunshi-style-template.js";
import { logger } from "../../config/logger.js";

export interface TemplateDefinition {
  /** 唯一 ID，存 DB / API / metadata 用 */
  id: string;
  /** 中文展示名（前端列表项） */
  name: string;
  /** 一句话风格描述（前端模板选择器副标题） */
  description: string;
  /** 可选 emoji 图标 */
  icon?: string;
  /**
   * HTML 生成函数（核心契约）。
   *
   * tenant 参数（task #35）：可选，目前仅 shunshi-style 用于区块 21 联系信息渲染；
   * 其他模板忽略此参数（保持向后兼容）。未传 tenant 时模板走 hardcoded fallback。
   */
  htmlGenerator: (
    journal: JournalInfo,
    aiContent: AIGeneratedContent,
    abstracts?: CollectionResult["abstracts"],
    tenant?: { contactMeta?: unknown } | null,
    /** PR Q.5 D4：chart_config jsonb（types[] + colors）控制渲染哪些 chart + 主题色。 */
    chartConfig?: unknown,
    /** PR Q.6 D5：section_count 控制 4 套区块数差异化（A=23 / B=15 / C=18 / E=25）。 */
    sectionCount?: number,
  ) => Promise<string>;
  /** 给 AI 生成 title/scope/recommendation 时附加的风格提示（可选，后续模板使用） */
  aiPromptHints?: string;
  /**
   * 🔴 是否参与**自动轮换**（8-13）。这是「能不能被自动挑中」的**唯一归宿**。
   *
   * 缺省视为 `true`。置 `false` 必须同时给出 `rotationDisabled` 三件套 ——
   * 没有日期与依据的关闭，两个月后就是下一条没人敢动的过期注释
   * （PR-Q7 的「有硬伤，修好再放回」正是这样过期的：8-13 复核实测，
   *   它点名的 data-card 近 14 天 27 篇 **0 失败**，而白名单里的 shunshi-style
   *   308 篇 16 失败，失败率反而最高）。
   *
   * ⚠️ 关闭轮换 ≠ 注销模板：存量内容的详情页/编辑/重渲染都要 `getTemplate(id)` 非空，
   *   显式 API 指定也照常可用。
   */
  rotationEnabled?: boolean;
  /** `rotationEnabled: false` 时必填 —— 三件套缺一不可 */
  rotationDisabled?: {
    /** 为什么关（一句话，写清现象不是结论） */
    reason: string;
    /** 决定日期 YYYY-MM-DD —— 过期复核的锚点 */
    date: string;
    /** 谁定的：人名 / 事故编号 / PR 号 */
    by: string;
  };
}

const registry = new Map<string, TemplateDefinition>();

export function registerTemplate(t: TemplateDefinition): void {
  if (registry.has(t.id)) {
    logger.warn({ templateId: t.id }, "Template already registered, overwriting");
  }
  registry.set(t.id, t);
}

export function getTemplate(id: string): TemplateDefinition | null {
  return registry.get(id) ?? null;
}

export function listTemplates(): TemplateDefinition[] {
  return Array.from(registry.values());
}

/**
 * 🔴 `templateId` 合法性校验（8-13）—— 数据链最上游的闸。
 *
 * ## 这个字段五步之后变成了决策层的毒数据
 *
 * `batch-worker.mapTemplateLetter` 把**数字人主播人设字母**（A/B/C/E，形象+音色）
 * 映射成了「渲染模板名」，而其中 B/C/E 指向的三个名字 —— `marketing-conversion` /
 * `popular-science` / `industry-vertical` —— **从来没有过实现**。于是：
 *
 * ```
 * 虚构模板名 → getTemplate() 返 null → 静默 fallback 到默认模板
 *   → 103 篇内容标着假 templateId（实际全是 shunshi 渲染）
 *   → 模板分布统计失真（真实单一化 73%，账面 55%）
 *   → 效果账本把 shunshi 的阅读数记在两个虚构 key 名下
 *   → 差点污染刚收口的轮换加权决策
 * ```
 *
 * 一个**没有合法性校验的字段**，五步之后成了决策层的毒数据。
 * 写入侧校验不是防御性编程的洁癖，是数据链最上游的闸。
 */
/**
 * 🔴 **刻意不进 registry 的独立体裁** —— 它们有自己的生成器与 adapter，
 * `metadata.templateId` 只作标签用，`getTemplate()` 对它们返回 null 是**预期行为**。
 *
 * 为什么不注册：registry 的 `htmlGenerator` 契约是
 * `(journal, aiContent, abstracts, tenant, chartConfig, sectionCount) => Promise<string>`，
 * 而这些体裁的入参完全不同（如 roundup 吃的是多刊 `RoundupData`）。
 * 硬塞进 registry 只会让契约变成"看情况"。
 *
 * ⚠️ 加成员前先确认它**真有独立渲染器**；否则它就是下一个 `popular-science`
 * （虚构模板名 → 静默 fallback → 统计失真）。
 */
export const NON_REGISTRY_GENRES: ReadonlySet<string> = new Set([
  // daily-cron 的多刊盘点 → services/publisher/adapters/journal-roundup-template.ts
  "journal-roundup",
]);

/**
 * templateId 是否对应**一个真实存在的渲染器**（registry 已注册 ∪ 独立体裁）。
 *
 * 判据刻意不是"在 registry 里" —— 8-13 首版就是那么写的，把 109 条合法的
 * `journal-roundup` 报成了违规。**判据要表达真实不变式（有没有东西真的渲染了它），
 * 不是表达某一种实现方式。**
 */
export function isRegisteredTemplateId(id: unknown): id is string {
  return typeof id === "string" && (registry.has(id) || NON_REGISTRY_GENRES.has(id));
}

/**
 * 落库前校验。非法值**拒绝**而不是静默改写 ——
 * 静默改写会让「传错了」和「传对了」在下游同样看不出来（红线 #14）。
 */
export function assertRegisteredTemplateId(id: unknown, where: string): string {
  if (isRegisteredTemplateId(id)) return id;
  throw new Error(
    `INVALID_TEMPLATE_ID: ${where} 收到未注册的 templateId「${String(id)}」。` +
      `已注册: ${[...registry.keys()].join(" / ")}。` +
      `若这是数字人主播人设(A/B/C/E)，它属于 personaLetter，不是渲染模板。`,
  );
}

export const DEFAULT_TEMPLATE_ID = "shunshi-style";

export function getDefaultTemplateId(): string {
  return DEFAULT_TEMPLATE_ID;
}

/**
 * 可参与自动轮换的模板 —— **全仓唯一的"能不能被自动挑中"判据**。
 *
 * 8-13 收口：此前有两处各判各的 ——
 *   · `article-skill` 走 `pickRotatingTemplateId()`，从**全部已注册模板**里挑
 *   · `daily-cron` 走自己的 `LAYOUT_TEMPLATES = ["shunshi-style","storytelling"]`（PR-Q7）
 * 两条链路谁也不知道谁：PR-Q7 那条限制**只管住了 daily-cron**，而占比更大的
 * article-skill 链路从未受它约束（近 14 天 130 篇 popular-science/industry-vertical/data-card
 * 就是从那里出来的）。在任一处关掉一个模板，另一处随时会把它捞回来。
 */
export function listRotatableTemplates(): TemplateDefinition[] {
  return listTemplates().filter((t) => t.rotationEnabled !== false);
}

/** PR-G: 主版本模板轮换 — 无显式选择时在**可轮换**模板间随机, 避免内容全是默认 shunshi 一个样。 */
export function pickRotatingTemplateId(random: () => number = Math.random): string {
  const ts = listRotatableTemplates();
  if (ts.length === 0) return DEFAULT_TEMPLATE_ID;
  return ts[Math.floor(random() * ts.length)]!.id;
}

// === 注册内置模板 ===

registerTemplate({
  id: "data-card",
  name: "数据卡片型",
  description: "IF / 分区 / 录用率 / 审稿周期 大数据卡 + 章节式正文。数据驱动决策风格。",
  icon: "📊",
  htmlGenerator: generateWechatJournalArticleHtml,
});

registerTemplate({
  id: "storytelling",
  name: "故事叙述型",
  description: "痛点开场 → 案例分析 → 投稿建议 → 行动号召。叙事驱动，适合新手投稿者。",
  icon: "📖",
  htmlGenerator: generateStorytellingHtml,
  aiPromptHints: "标题可加痛点钩子（'博士不愁了！'/'投稿避雷指南：'），recommendation 偏向 actionable 建议清单",
});

registerTemplate({
  /**
   * 🔻 8-13 下线轮换（老韩拍板）。**注册保留** —— 存量 44 篇的详情页/编辑/重渲染要 getTemplate 非空。
   * 显式 API 指定仍可用（向后兼容）。
   */
  rotationEnabled: false,
  rotationDisabled: {
    reason: "老板认为清单点评型的碎片条目观感差（如「但注意，纯电化教育」这类半句），且字段数据可疑",
    date: "2026-08-13",
    by: "老韩拍板",
  },
  id: "listicle",
  name: "清单点评型",
  description: "5 大优势 + 3 个避雷 + 适合人群清单。扫读友好，决策导向。",
  icon: "📋",
  htmlGenerator: generateListicleHtml,
  aiPromptHints: "标题用'X 期刊：5 大优势 + 3 个避雷'结构。recommendation 偏向条目化、对比化、决策导向。",
});

registerTemplate({
  id: "shunshi-style",
  name: "顺仕美途风格",
  description: "标准期刊推荐排版：13 区块结构 + 数据可视化 + 红蓝白配色。视觉权威感最强。",
  icon: "📰",
  htmlGenerator: generateShunshiStyleHtml,
  aiPromptHints: "标题用「影响因子X，今年预测涨至Y，N区TOP，国人友好」类钩子句式。recommendation 偏权威总结。",
});

logger.info({ count: registry.size, ids: Array.from(registry.keys()) }, "template registry initialized");
