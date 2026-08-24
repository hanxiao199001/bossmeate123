/**
 * 检查器 code → 人话标签。**周报/简报里给运营看的唯一归宿。**
 *
 * ═══ 为什么单独一张表 ═══
 *
 * 8-24 首份带新内容的周报实测：证据区把内部标识符直接印给运营看 ——
 *
 * ```
 * output_health.title_placeholder  命中 2 / 已裁决 0
 * 另有 8 道闸本周零命中：body_truncated、placeholder_asset_in_body、ai_fallback_text…
 * ```
 *
 * 运营看不懂 `placeholder_asset_in_body`，也就无法判断这行跟自己有没有关系。
 * 而「看不懂的行」会被整段跳过 —— 连同它旁边那些看得懂的一起。
 *
 * ═══ 🔴 缺映射时不许静默显示原始 code ═══
 *
 * 显示 `未知检查项(xxx)` 而不是裸 code。理由：**缺失必须可见**。
 * 静默透传原始 code 的话，新增一个检查器却忘了加标签，
 * 表现和"这个检查器本来就叫这个名字"完全一样 —— 没人会发现该补。
 */

/** code → 运营能看懂的一句话。新增检查器时**必须**同步加一行。 */
const LABELS: Record<string, string> = {
  // 出稿健康闸
  "output_health.title_placeholder": "标题里有没替换掉的占位符",
  "output_health.body_too_short": "正文太短",
  "output_health.body_truncated": "正文被截断了",
  "output_health.placeholder_asset_in_body": "正文里混进了占位图",
  "output_health.ai_fallback_text": "正文里有 AI 的道歉话术（说明当时没生成出来）",
  "output_health.title_empty": "标题是空的",
  "output_health.template_residue": "正文里有模板没清干净的残留",
  "output_health.title_too_short": "标题太短",
  "output_health.fallback_phrase": "用了兜底套话（如「高影响力」这类没数据支撑的说法）",
  "output_health.body_repetition": "正文里有大段重复",
  // 内容红线
  title_data_fabricated: "标题里的数字正文查不到（疑编造）",
  title_body_inconsistent: "标题喊保录，而正文说这刊有风险",
  title_hard_banned: "标题用了禁用词（改标题即可）",
  body_fabrication: "正文里有无据的指标数字",
  output_unhealthy: "出稿健康闸拦下",
  six_dim_below_floor: "六维评分有维度低于地板线",
  ai_fabricated_journal: "这本刊本身是 AI 编出来的",
  quality_check_unavailable: "没评上分（评分服务当时不可用，不是内容差）",
  quality_gate_unavailable: "质检闸没能跑成",
};

/** 短 code 兜底：`output_health.body_too_short` 与 `body_too_short` 指同一件事 */
function normalize(code: string): string[] {
  const out = [code];
  if (!code.includes(".")) out.push(`output_health.${code}`);
  else out.push(code.split(".").slice(-1)[0]!);
  return out;
}

/**
 * 取人话标签。
 *
 * 🔴 缺映射时返回 `未知检查项(code)` —— **绝不静默透传原始 code**，
 * 否则"忘了加标签"和"它本来就叫这个"在页面上长得一模一样。
 */
export function checkerLabel(code: string): string {
  for (const k of normalize(code)) {
    const v = LABELS[k];
    if (v) return v;
  }
  return `未知检查项(${code})`;
}

/** 供守卫用：哪些 code 还没有标签（新增检查器时该报出来） */
export function missingLabels(codes: readonly string[]): string[] {
  return codes.filter((c) => normalize(c).every((k) => !LABELS[k]));
}
