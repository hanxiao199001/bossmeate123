/**
 * PR-Z3: 内容合规层 — 商业化前置防线。
 * 1. 违禁词检查: 硬词(发布即封号级风险)拦截; 软词(广告法/医疗宣传红线)警告放行并记 metadata。
 *    词库 = 内置基础库 + SYSTEM config.automationConfig.complianceWords {hard[], soft[]} 扩展。
 * 2. AI 生成标识: 按《生成式AI服务管理办法》/《深度合成管理规定》要求, 发布时文末追加标识
 *    (SYSTEM config.automationConfig.aiLabel: false 可关, 默认开)。
 * 注: 词库为技术兜底, 不构成法律意见; 客户行业(医学学术)广告法红线建议请专业人士复核扩充。
 */
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { tenants } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { logger } from "../../config/logger.js";

// 硬词: 命中即拦截 (政治敏感类客户自行扩充; 此处放公认高危词根)
const HARD_WORDS = [
  "法轮", "六四", "台独", "藏独", "疆独", "颠覆国家", "暴恐",
];

// 软词: 广告法绝对化用语 + 医疗宣传红线 (命中警告, 不拦截)
const SOFT_WORDS = [
  "最佳", "最优", "第一", "顶级", "国家级", "全球首", "世界级", "极致", "绝无仅有",
  "100%有效", "根治", "治愈率", "包治", "药到病除", "完全无副作用", "保证录用", "包发表", "百分百中刊",
  "稳赚", "躺赚", "保过",
];

export interface ComplianceResult {
  blocked: boolean;
  hardHits: string[];
  softHits: string[];
}

async function loadExtraWords(): Promise<{ hard: string[]; soft: string[] }> {
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    const cw = ((t?.config as any)?.automationConfig?.complianceWords) ?? {};
    return {
      hard: Array.isArray(cw.hard) ? cw.hard.map(String) : [],
      soft: Array.isArray(cw.soft) ? cw.soft.map(String) : [],
    };
  } catch {
    return { hard: [], soft: [] };
  }
}

/** 文本合规检查 (标题+正文拼一起传入) */
export async function checkCompliance(text: string): Promise<ComplianceResult> {
  const extra = await loadExtraWords();
  const plain = text.replace(/<[^>]+>/g, "");
  const hardHits = [...new Set([...HARD_WORDS, ...extra.hard].filter((w) => w && plain.includes(w)))];
  const softHits = [...new Set([...SOFT_WORDS, ...extra.soft].filter((w) => w && plain.includes(w)))];
  if (hardHits.length > 0 || softHits.length > 0) {
    logger.warn({ hardHits, softHits }, "PR-Z3 合规检查命中");
  }
  return { blocked: hardHits.length > 0, hardHits, softHits };
}

const AI_LABEL_HTML = `<p style="color:#999;font-size:12px;margin-top:24px;">本文由 AI 辅助生成，内容仅供参考。</p>`;

/** 发布时给正文追加 AI 生成标识 (config aiLabel=false 可关; 已含标识不重复加) */
export async function appendAiLabel(body: string): Promise<string> {
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    if (((t?.config as any)?.automationConfig?.aiLabel) === false) return body;
  } catch { /* 默认开 */ }
  if (body.includes("AI 辅助生成") || body.includes("AI辅助生成")) return body;
  return body + AI_LABEL_HTML;
}
