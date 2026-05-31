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

export const DEFAULT_TEMPLATE_ID = "shunshi-style";

export function getDefaultTemplateId(): string {
  return DEFAULT_TEMPLATE_ID;
}

/** PR-G: 主版本模板轮换 — 无显式选择时在已注册模板间随机, 避免内容全是默认 shunshi 一个样。 */
export function pickRotatingTemplateId(random: () => number = Math.random): string {
  const ts = listTemplates();
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
