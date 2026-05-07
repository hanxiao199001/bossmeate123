/**
 * PR Q.3：根据 selected template 把 prompt_overrides + structure_json 转为 LLM
 * system prompt 后缀，注入 article-skill 的 generateJournalRecommendation 调用。
 *
 * D2 范围：tone / sentence_length / emoji_use / number_emphasis / hook_style / cta_style 6 字段
 *         + few-shot 行业样板（来自 LanceDB industry_sample 仓）。
 * D3-D5 接 css_theme + chart_config + image_strategy。
 */
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contentTemplates } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import {
  retrieveSamples,
  formatSamplesForPrompt,
  type SampleStyleTag,
} from "../journals/few-shot-retrieval.js";

interface PromptOverrides {
  tone?: string;
  sentence_length?: "long" | "short" | "medium";
  emoji_use?: "none" | "heavy" | "moderate" | "sparse";
  number_emphasis?: "low" | "medium" | "high" | "extreme";
}
interface StructureJson {
  hook_style?: string;
  cta_style?: string;
  sections?: string[];
}

const TONE_DESC: Record<string, string> = {
  long: "段落较长，逻辑紧凑，每段 80-150 字",
  short: "段落极短，每段 1-3 句，强冲击",
  medium: "段落适中，每段 40-80 字",
};
const EMOJI_DESC: Record<string, string> = {
  none: "全文不使用任何 emoji 或装饰符号",
  heavy: "标题与段首大量使用 emoji（每段至少 1 个）",
  moderate: "适度使用 emoji（标题可 1-2 个，正文偶尔点缀）",
  sparse: "仅在关键数据点旁使用 emoji 强调（最多 3 处）",
};
const EMPHASIS_DESC: Record<string, string> = {
  low: "数据用普通字号，不加粗",
  medium: "关键数据加粗，标准字号",
  high: "关键数据加粗 + 颜色突出",
  extreme: "关键数据用 H2 大字号 + 颜色 + 加粗",
};

export async function loadTemplate(templateId: string): Promise<typeof contentTemplates.$inferSelect | null> {
  try {
    const [row] = await db.select().from(contentTemplates).where(eq(contentTemplates.id, templateId)).limit(1);
    return row ?? null;
  } catch (err) {
    logger.warn({ templateId, err: err instanceof Error ? err.message : err }, "Q.3 loadTemplate failed");
    return null;
  }
}

/** PR Q.5 task #54 数字幻觉硬约束（无条件加，4 套都有）。
 * marketing extreme 强调让 LLM 引用 ifHistory 历史峰值（如 IF 202 = 柳叶刀某年峰值）作 title。
 * 现强制：标题与正文中的"当前 IF / 录用率 / 审稿周期"必须用 metadata 提供的当前值。 */
const NUMBER_CONSTRAINT_SUFFIX =
  `\n\n## 数字真实性硬约束（task #54）\n`
  + `- 标题与正文中的"当前 IF"必须使用 metadata.impactFactor 当前值（如 The Lancet 应用 98.4），\n`
  + `  禁止引用 ifHistory 数组中的历史峰值（如 202、44 等）作为标题或正文宣传重点；\n`
  + `- 历史趋势仅可在 ifHistoryAnalysis 章节内说明（"近 X 年从 X 涨到 Y"），不可作 hook；\n`
  + `- 录用率 / 审稿周期 / APC 同理：只用 metadata 当前值，不夸大、不引未来预测。`;

/** 把 prompt_overrides + structure_json 转为 LLM system prompt 后缀文本。 */
export function buildPromptOverrideSuffix(template: { promptOverrides: unknown; structureJson: unknown; styleTag: string; displayName: string }): string {
  const po = (template.promptOverrides ?? {}) as PromptOverrides;
  const sj = (template.structureJson ?? {}) as StructureJson;
  const lines: string[] = [`\n## 模板风格约束（${template.displayName} · ${template.styleTag}）`];
  if (po.tone) lines.push(`- 整体语气：${po.tone}`);
  if (po.sentence_length) lines.push(`- 段落长度：${TONE_DESC[po.sentence_length] ?? po.sentence_length}`);
  if (po.emoji_use) lines.push(`- emoji 使用：${EMOJI_DESC[po.emoji_use] ?? po.emoji_use}`);
  if (po.number_emphasis) lines.push(`- 数据强调：${EMPHASIS_DESC[po.number_emphasis] ?? po.number_emphasis}`);
  if (sj.hook_style) lines.push(`- 开头风格（hook）：${sj.hook_style}`);
  if (sj.cta_style) lines.push(`- 结尾召唤（CTA）：${sj.cta_style}`);
  return lines.join("\n") + NUMBER_CONSTRAINT_SUFFIX;
}

/**
 * 主入口：给定 templateId + tenantId + 用户 query，返回 system prompt 后缀
 * （含 prompt_overrides 风格约束 + few-shot 样板参考）。模板缺失时静默 return ""。
 */
export async function buildTemplateAwarePromptSuffix(args: {
  templateId: string | null | undefined;
  tenantId: string;
  query: string;
}): Promise<{ suffix: string; styleTag: SampleStyleTag | null; templateName: string | null; chartConfig: unknown }> {
  const { templateId, tenantId, query } = args;
  if (!templateId) return { suffix: "", styleTag: null, templateName: null, chartConfig: null };
  const tpl = await loadTemplate(templateId);
  if (!tpl) return { suffix: "", styleTag: null, templateName: null, chartConfig: null };

  const styleTag = tpl.styleTag as SampleStyleTag;
  const overrideSuffix = buildPromptOverrideSuffix(tpl);
  const samples = await retrieveSamples({ tenantId, styleTag, query, topK: 3 });
  const fewShotSuffix = formatSamplesForPrompt(samples);

  return {
    suffix: `${overrideSuffix}${fewShotSuffix}`,
    styleTag,
    templateName: tpl.name,
    // PR Q.5 D4：chart_config jsonb 透传给 article-skill → htmlGenerator
    chartConfig: tpl.chartConfig,
  };
}
