/**
 * 7-30 口播稿内容安全闸 —— 文字稿直生专用, 在 submit(=扣费) 之前拦。
 *
 * ## 为什么直生非要单开一道
 * 背景图有强制内容审核, 文本一直**什么都没有** —— 因为文章链路的文本是 AI 按红线 prompt
 * 生成的, 生成时还跑过 sanitizeForCompliance 自动净化, 发布前又有编造硬闸。运营手写的
 * 口播稿把这三道**全绕过去了**, 直接进阿里云出片。"包过/稳过/水刊" 这类词在学术服务行业
 * 是会出事的, 而视频一旦生成钱就花了、稿子也已经进了阿里云。
 *
 * ## 用了哪几个闸(三道, 都要)
 *   ① 敏感词 DFA 词库(work-wechat/sensitive-filter, AI 客服那条线的出站硬闸)
 *      → 政治/暴恐/违禁类。这是**法律底线**, 命中即拒。
 *   ② checkCompliance 的 hardHits → 封号级高危词(可被 SYSTEM 租户 config 扩词)。
 *   ③ findUnambiguousViolations → **行业红线**: 包过/保证录用/根治/世界级…
 *      ①②管的是"会被封号", ③管的是"学术服务行业会出事", 两类完全不重叠, 所以都要。
 *   软词(最佳/国家级/第一 这类在学术语境常合法的)**不拦**, 原样带回去落 metadata + 日志,
 *   与文章链路口径一致 —— 拦了就是天天误伤"第一作者""国家级期刊"。
 *
 * ## 命中词能不能回显给运营
 *   - ②③ 的词回显。是运营自己刚敲进去的字, 不回显他根本不知道要改哪儿。
 *   - ① 的词**不回显**, 只进服务端日志。sensitive-filter 的红线原文: "命中词只进服务端
 *     日志/落库打标, 绝不能出现在发给客户的任何文案里"。这里守住同一条线。
 */
import { logger } from "../../config/logger.js";
import { matchSensitive } from "../work-wechat/sensitive-filter.js";
import { checkCompliance, findUnambiguousViolations } from "../compliance/content-check.js";

export type NarrationBlockCode = "SENSITIVE_WORD" | "COMPLIANCE_HARD" | "COMPLIANCE_REDLINE";

export interface NarrationSafetyResult {
  ok: boolean;
  code?: NarrationBlockCode;
  /** 给运营看的文案(已按上面的回显规则处理过, 可直接回前端) */
  message?: string;
  /** 软词: 不拦, 落 metadata + 提示 */
  softHits: string[];
}

/**
 * 纯内存部分(无 DB): DFA 词库 + 行业红线词。
 * 单拆出来是给 /video/dvh-estimate 边打字边预检用的 —— 每次防抖都读一次 DB 不合适。
 */
export function checkNarrationSafetyPure(text: string, title?: string): NarrationSafetyResult {
  const full = [title ?? "", text].filter(Boolean).join("\n");

  // ① 敏感词库(政治/暴恐/违禁) —— 命中词只进日志
  const sens = matchSensitive(full);
  if (sens.hit) {
    logger.warn({ words: sens.words, chars: text.length }, "dvh.text.blocked_by_sensitive_lexicon");
    return {
      ok: false,
      code: "SENSITIVE_WORD",
      message: "口播稿命中敏感词库(政治/违禁类), 已拦截生成。请检查并改写文稿后重试; 具体命中词已记入服务端日志, 需要时可找管理员核对。",
      softHits: [],
    };
  }

  // ③ 行业红线(包过/根治/世界级…) —— 明说是哪个词 + 建议怎么改
  const violations = findUnambiguousViolations(full);
  if (violations.length > 0) {
    const detail = violations.slice(0, 6).map((v) => `「${v.word}」→ 建议改成「${v.suggest}」`).join("; ");
    return {
      ok: false,
      code: "COMPLIANCE_REDLINE",
      message: `口播稿命中行业红线词, 已拦截生成: ${detail}${violations.length > 6 ? " 等" : ""}。学术服务不能对录用/疗效做承诺, 也不能用绝对化用语, 请改写后重试。`,
      softHits: [],
    };
  }

  return { ok: true, softHits: [] };
}

/**
 * 完整检查(含 DB: SYSTEM 租户 config 里扩的词库)。生成路由用这个。
 * 顺序 = 先纯内存后 DB, 命中就短路, 不白查库。
 */
export async function checkNarrationSafety(text: string, title?: string): Promise<NarrationSafetyResult> {
  const pure = checkNarrationSafetyPure(text, title);
  if (!pure.ok) return pure;

  const full = [title ?? "", text].filter(Boolean).join("\n");
  const compliance = await checkCompliance(full);
  if (compliance.blocked) {
    return {
      ok: false,
      code: "COMPLIANCE_HARD",
      message: `口播稿命中高危违禁词: ${compliance.hardHits.slice(0, 6).map((w) => `「${w}」`).join("、")}。这类词发布即封号级风险, 请删除后重试。`,
      softHits: compliance.softHits,
    };
  }
  if (compliance.softHits.length > 0) {
    logger.info({ softHits: compliance.softHits }, "dvh.text.compliance_soft_hits — 放行但已记录");
  }
  return { ok: true, softHits: compliance.softHits };
}
