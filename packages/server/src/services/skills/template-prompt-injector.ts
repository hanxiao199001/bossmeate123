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
// PR Q.6 D5：emoji 强约束（5-7 D4 验收 4 套都 14 emoji 来源 shunshi 模板，但 LLM 输出
// 字段（title / scopeDescription / recommendation 等）不严格遵守。加强 mandatory 措辞。
const EMOJI_DESC: Record<string, string> = {
  none: "🚫 【严禁】使用任何 emoji / 表情符号 / 图标字符。LLM 输出含 emoji 视为格式错误必须重写",
  heavy: "✅ 【必须】≥8 个 emoji（标题至少 1-2 个 / 每段段首至少 1 个 / 数据强调处加 emoji），少于 8 个视为不达标",
  moderate: "🟡 【适度】3-5 个 emoji（标题 1-2 个 / 正文偶尔 2-3 个，超过 5 视为过度）",
  sparse: "⚠️ 【严控】0-1 个 emoji（仅关键数据点旁可加 1 处，多于 1 视为过度）",
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
  + `- 录用率 / 审稿周期 / APC 同理：只用 metadata 当前值，不夸大、不引未来预测。\n\n`
  + `### ❌ 标题反例（PR Q.6.1，5-8 D5 C 套实测违反）\n`
  + `- ❌ "IF从44飙升到98.4" / "IF 从 X 涨到 Y"（历史峰值作 hook）\n`
  + `- ❌ "近10年涨5倍" / "增长 X%"（推算历史增幅作 hook）\n`
  + `- ❌ "从未来跌到 Y" / "预计涨至 Z"（预测值作 hook）\n`
  + `- ✅ "IF 98.4 的医学顶刊" / "影响因子 98.4 + 录用率 5%"（仅当前值）\n\n`
  + `## 深度分析章节格式（PR Q.10.1，5-9 公众号草稿验收）\n`
  + `ifHistoryAnalysis / carRiskAnalysis / scopeAndCitations / submissionAdvice 4 章节必须：\n`
  + `1. 每段 ≤ 80 字（约 2-3 句），按句号或逻辑断段，禁止 500+ 字单段堆砌\n`
  + `2. 关键数字 / 趋势结论必须用 <strong>...</strong> 包裹：影响因子（<strong>98.4</strong>）/\n`
  + `   年份（<strong>2021 年</strong>）/ 百分比（<strong>5%</strong>）/ 区间（<strong>85-100</strong>）\n`
  + `3. 每段独立 <p>...</p>，禁止整章节合并到一个 <p>\n`
  + `4. 列表用 <li>...</li>，不合并到一段\n`
  + `### ✅ 正确：\n`
  + `<p>The Lancet 近 10 年 IF 呈剧烈波动。</p>\n`
  + `<p>从 <strong>2015 年 44.002</strong> 增至 <strong>2019 年 60.392</strong>。</p>\n`
  + `<p><strong>2021 年峰值 98.4</strong>（COVID 论文引用驱动）。</p>\n`
  + `<p><strong>趋势：未来 IF 维持 85-100 区间</strong>，除非重大公共卫生事件。</p>`;

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
}): Promise<{ suffix: string; styleTag: SampleStyleTag | null; templateName: string | null; chartConfig: unknown; sectionCount: number | null }> {
  const { templateId, tenantId, query } = args;
  if (!templateId) return { suffix: "", styleTag: null, templateName: null, chartConfig: null, sectionCount: null };
  const tpl = await loadTemplate(templateId);
  if (!tpl) return { suffix: "", styleTag: null, templateName: null, chartConfig: null, sectionCount: null };

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
    // PR Q.6 D5：section_count 控制 4 套区块数差异化
    sectionCount: tpl.sectionCount,
  };
}
