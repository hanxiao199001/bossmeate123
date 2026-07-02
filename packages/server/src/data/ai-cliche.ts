/**
 * P0四件套③：中文 AI 腔黑名单（正则形式）
 *
 * 为什么要这张表：LLM 生成的中文有一批高频"套话开关词"（总之/综上所述/赋能/在当今…），
 * 读者一眼就能认出"这是 AI 写的"，直接拉低公众号文章的原创感与完读率。
 * 两个用途：
 *   1. 预防：生成 prompt 注入"禁用清单"（取前 20 个高频，见 buildClicheBanPrompt）
 *   2. 治理：decliche.ts 用整表做命中检测 + 段落级改写
 *
 * 收录原则：宁多勿漏，但避免误伤 —— 只收"几乎只在 AI 腔/官样文章里出现"的词式；
 * 正常学术表达（如"研究表明""结果显示"）不收。
 */

export interface ClichePattern {
  /** 模式名（用于命中报告与日志） */
  name: string;
  /** 正则源码字符串（运行时 new RegExp(source, "g")） */
  source: string;
}

/**
 * 黑名单主表（按大致出现频率排序，前 20 条会被注入生成 prompt 做预防）。
 * 注意：这里全是"单点命中即算"的模式；"首先/其次/最后连排"和"不仅…还…滥用"
 * 是跨句组合模式，在 decliche.ts 的 detectCliches 里单独实现。
 */
export const AI_CLICHE_PATTERNS: ClichePattern[] = [
  // ---- 高频总结套话 ----
  { name: "总之", source: "总之[，,]" },
  { name: "综上所述", source: "综上所述" },
  { name: "综上（独立成句）", source: "(?:^|[。！？\\n])综上[，,]" },
  { name: "总而言之", source: "总而言之" },
  { name: "一言以蔽之", source: "一言以蔽之" },
  { name: "由此可见", source: "由此可见" },
  // ---- 高频开头套话 ----
  { name: "在当今", source: "在当今" },
  { name: "在这个…的时代", source: "在这个[^，。]{2,12}的(?:时代|当下)" },
  { name: "随着…的发展", source: "随着[^，。]{2,16}的(?:发展|进步|普及|深入|不断发展)" },
  { name: "近年来，随着", source: "近年来[，,]随着" },
  { name: "众所周知", source: "众所周知" },
  // ---- 高频转折/引导套话 ----
  { name: "值得注意的是", source: "值得注意的是" },
  { name: "值得一提的是", source: "值得一提的是" },
  { name: "不难发现", source: "不难发现" },
  { name: "不难看出", source: "不难看出" },
  { name: "让我们", source: "让我们(?:一起|来|共同)?" },
  { name: "毋庸置疑", source: "毋庸置疑" },
  { name: "显而易见", source: "显而易见" },
  { name: "与此同时", source: "与此同时" },
  { name: "可以说（句首）", source: "(?:^|[。！？\\n])可以说[，,]" },
  // ---- 官样/商业黑话 ----
  { name: "赋能", source: "赋能" },
  { name: "助力", source: "助力" },
  { name: "抓手", source: "抓手" },
  { name: "底层逻辑", source: "底层逻辑" },
  { name: "深度融合", source: "深度融合" },
  { name: "形成闭环", source: "形成闭环" },
  { name: "提质增效", source: "提质增效" },
  { name: "保驾护航", source: "保驾护航" },
  { name: "添砖加瓦", source: "添砖加瓦" },
  { name: "迈上新台阶", source: "迈上新台阶" },
  { name: "谱写新篇章", source: "谱写(?:新篇章|华章)" },
  { name: "注入新动能", source: "注入(?:新动能|新活力|强劲动力)" },
  { name: "掀起热潮", source: "掀起[^，。]{0,8}热潮" },
  { name: "携手共进", source: "携手(?:共进|同行|并进)" },
  { name: "蓬勃发展", source: "蓬勃发展" },
  { name: "方兴未艾", source: "方兴未艾" },
  // ---- 空洞评价/程度套话 ----
  { name: "具有重要意义", source: "具有(?:十分)?重要(?:的)?(?:意义|价值|作用)" },
  { name: "发挥着重要作用", source: "发挥着?(?:重要|关键|不可替代)(?:的)?作用" },
  { name: "起到了…的作用", source: "起到了[^，。]{1,12}的作用" },
  { name: "不可或缺", source: "不可或缺" },
  { name: "日益增长", source: "日益(?:增长|凸显|重要)" },
  { name: "从某种意义上说", source: "从某种(?:意义|程度)上(?:来)?[说讲]" },
  { name: "究其原因", source: "究其原因" },
  { name: "干货满满", source: "干货满满" },
  { name: "敬请期待", source: "敬请期待" },
  { name: "全方位多层次", source: "全方位[、，]?多层次" },
  { name: "新质生产力式排比", source: "高质量发展的(?:必由之路|重要引擎)" },
];

/**
 * 取前 N 个高频模式的"人话名"，注入生成 prompt 做预防（默认 20 个）。
 * 为什么只注前 20：prompt 太长会稀释注意力，前 20 已覆盖 90% 命中场景，
 * 剩余长尾靠生成后的 decliche 清洗兜底。
 */
export function buildClicheBanPrompt(topN: number = 20): string {
  const names = AI_CLICHE_PATTERNS.slice(0, topN).map((p) => p.name.replace(/（[^）]*）/g, ""));
  return `\n【禁用 AI 腔词汇/句式】以下词汇句式一律禁用（用具体信息或口语替代，一句能说清的不用两句）：\n${names.join("、")}；此外禁止"首先/其次/最后"连排分点腔，禁止满篇"不仅…还…"。`;
}
