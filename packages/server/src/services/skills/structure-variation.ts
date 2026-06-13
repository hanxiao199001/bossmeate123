/**
 * PR-X1 + PR-FW(数据飞轮): 结构组合引擎。
 * 每次生成随机/加权抽: 标题公式 × 开头钩子 × 结尾CTA × 口播脚本风格。
 * 飞轮: 抽取记入 recipe → 落到 content.metadata → 效果回收后按"哪个配方阅读高"加权,
 *       好配方下次更常被抽中。无数据时退回均匀随机(冷启动安全)。
 */

// 每项带稳定 key (飞轮归因用 key, 不用文案防改文案丢历史)
const TITLE_FORMULAS: Array<[string, string]> = [
  ["num_impact", "数字冲击式: 用具体数字开头制造冲击"],
  ["question", "疑问悬念式: 用目标读者最关心的问题作标题"],
  ["contrast", "对比反差式: 「看起来A, 实际上B」"],
  ["warning", "避坑警告式: 「投稿前必须知道的…」「别再…」"],
  ["benefit", "结果导向式: 直接承诺读者收益"],
  ["list", "盘点清单式: 「N个/N本/N条」"],
  ["urgency", "时效紧迫式: 结合时间节点"],
  ["identity", "身份代入式: 直接点名目标人群"],
  ["counter", "反常识式: 挑战普遍认知"],
  ["experience", "经验自述式: 「过来人」口吻"],
];
const HOOK_STYLES: Array<[string, string]> = [
  ["suspense", "悬念钩子: 开头抛反直觉事实/数据, 不立即解释"],
  ["painpoint", "痛点钩子: 第一句直击读者当下最焦虑的场景"],
  ["story", "故事钩子: 用具体投稿小故事开场"],
  ["data", "数据钩子: 开头连甩2-3个硬数据建立专业感"],
  ["question", "提问钩子: 连续两个问题逼读者代入"],
  ["banter", "吐槽钩子: 轻吐槽行业现象再转正题"],
  ["conclusion", "结论先行钩子: 第一段直接给结论"],
  ["scene", "场景钩子: 描绘读者熟悉的具体场景"],
];
const CTA_STYLES: Array<[string, string]> = [
  ["follow", "关注引导"],
  ["save", "收藏引导"],
  ["comment", "互动提问引导评论"],
  ["preview", "下期预告"],
  ["dm", "私信/留言引导"],
  ["share", "转发引导"],
  ["tool", "工具/资料引导"],
  ["none", "无CTA, 干货收尾保持克制"],
];
const SCRIPT_STYLES: Array<[string, string]> = [
  ["hook", "钩子型口播: 前5秒必须有钩子句"],
  ["list", "盘点型口播: 「三个数字带你看懂」"],
  ["qa", "问答型口播: 自问自答"],
  ["counter", "反常识型口播: 「很多人以为…其实…」"],
  ["experience", "经验分享型口播: 第一人称过来人口吻"],
];

export interface VariationRecipe {
  titleFormula: string;
  hook: string;
  cta: string;
  scriptStyle: string;
}

/** 权重表: category → { key → 权重(>0) }。缺省/缺项按均匀。 */
export type RecipeWeights = Partial<Record<keyof VariationRecipe, Record<string, number>>>;

function weightedPick(options: Array<[string, string]>, weights?: Record<string, number>): [string, string] {
  if (!weights) return options[Math.floor(Math.random() * options.length)]!;
  // 权重 = max(基础0.5, 学到的权重), 保证低分项仍有探索机会
  const scored = options.map(([k, v]) => [k, v, Math.max(0.5, weights[k] ?? 1)] as [string, string, number]);
  const total = scored.reduce((s, x) => s + x[2], 0);
  let r = Math.random() * total;
  for (const [k, v, w] of scored) { r -= w; if (r <= 0) return [k, v]; }
  return [scored[0]![0], scored[0]![1]];
}

/** 抽一套配方 + prompt 后缀。传 weights 则按效果加权(飞轮)。 */
export function buildVariation(weights?: RecipeWeights): { suffix: string; recipe: VariationRecipe } {
  const [tk, tv] = weightedPick(TITLE_FORMULAS, weights?.titleFormula);
  const [hk, hv] = weightedPick(HOOK_STYLES, weights?.hook);
  const [ck, cv] = weightedPick(CTA_STYLES, weights?.cta);
  const [sk, sv] = weightedPick(SCRIPT_STYLES, weights?.scriptStyle);
  const suffix = `

【本篇结构变化指令 (防同质化, 必须遵守)】
- 标题采用「${tv}」
- 开头采用「${hv}」— 严禁与近期文章雷同的开头套路
- 结尾采用「${cv}」
- videoScript 采用「${sv}」
- 段落节奏在模板基础上自然变化, 不要每篇同样的小标题措辞`;
  return { suffix, recipe: { titleFormula: tk, hook: hk, cta: ck, scriptStyle: sk } };
}

/** 兼容旧调用: 只要后缀 */
export function buildVariationSuffix(weights?: RecipeWeights): string {
  return buildVariation(weights).suffix;
}

/** 账号人设 + 风格画像 → prompt 块 */
export function buildPersonaSuffix(persona?: string | null, styleProfile?: string | null): string {
  if (!persona && !styleProfile) return "";
  let out = "\n\n【账号人设 (本文以此身份写作, 优先级高于模板默认语气)】";
  if (persona) out += `\n${persona.trim().slice(0, 800)}`;
  if (styleProfile) out += `\n\n【账号风格画像 (从该账号范文提炼, 模仿其行文风格)】\n${styleProfile.trim().slice(0, 1200)}`;
  return out;
}
