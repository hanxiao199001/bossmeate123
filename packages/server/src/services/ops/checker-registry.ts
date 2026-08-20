/**
 * 检查器注册处（8-14 方法论移植 Phase 1）。
 *
 * ## 这里放什么、不放什么
 *
 * **放不变的部分**：这个闸防什么、什么时候上线的、现在是主动还是影子、
 * 上线前的动机案例（回溯）。
 * **不放活数据**：命中率、真假阳性、去留建议 —— 那些从 `checker_ledger` 算，
 * 写进注释就会过期（PR-Q7 的「有硬伤，修好再放回」写了两个月，没人知道修好没；
 * 8-13 复核实测它点名的 data-card 近 14 天 0 失败，而白名单里的 shunshi 失败率最高）。
 *
 * ## 🔴 回溯案例与上线后统计**分开记**
 *
 * 排名闸「2 报 2 中」听着漂亮，严格说：该闸**存在之后**只命中 1 次；
 * 另 1 例是它诞生前从措辞闸的误报堆里翻出来的，正是催生它的那个 case。
 * 两例都是真的，但一个是回溯的。整套台账的目的是让系统能自己回答「证据是什么」，
 * 那么证据的时间归属从第一天起就得干净 —— 回溯案例混进上线后统计，
 * 第一条记录就在撒谎。
 */

/** 闸当前的作用方式 */
export type CheckerMode =
  /** 主动闸：命中会影响产物去向（拦下/标记/降级） */
  | "active"
  /** 影子：只记录，不影响任何判定 */
  | "shadow";

export interface MotivatingCase {
  /** 一句话：当时发生了什么 */
  what: string;
  /** 出处：日期 + 从哪儿翻出来的 */
  source: string;
}

/**
 * 🔴 零命中的守卫怎么判死活（老韩 8-20 立）：
 * **看的不是命中数，是触发条件在现实中可不可达。**
 *
 * 8-20 两个实例凑成一对 —— draft_only 能力过滤 0 命中（那个号真实存在 → 保留）
 * vs published_by_operator 探测 0 行（依赖的 wechat_stats 表根本没建过 → 死代码）。
 * 命中数一样，处置相反。
 *
 * 所以每个注册项应当能回答：**触发它需要什么？那件事现在能不能发生？**
 */
export interface CheckerDefinition {
  /** 唯一名。与 checker_ledger.checker_id、日志里的 checkerId 字段一致 */
  id: string;
  /** 给运营看的一句话：这个闸防什么 */
  guards: string;
  /** 上线日期 YYYY-MM-DD —— 台账统计的起点 */
  since: string;
  mode: CheckerMode;
  /**
   * 🔴 **上线前**的动机案例（回溯）。**不进 evaluated/hits**。
   * 它回答「当初为什么建这个闸」，不回答「它现在干得怎么样」。
   */
  motivatingCases?: MotivatingCase[];
  /** 降级/影子化的原因（mode==="shadow" 时必填），含日期与依据 */
  shadowReason?: { reason: string; date: string; promoteWhen: string };
}

const registry = new Map<string, CheckerDefinition>();

export function registerChecker(d: CheckerDefinition): void {
  registry.set(d.id, d);
}

export function getChecker(id: string): CheckerDefinition | null {
  return registry.get(id) ?? null;
}

export function listCheckers(): CheckerDefinition[] {
  return [...registry.values()];
}

// ══════════════════════════════════════════════════════════════════
// 第一批：**已在生产跑**的闸
// ══════════════════════════════════════════════════════════════════
//
// ⚠️ A2「学科定位」体裁的三道闸（数字白名单/排名/快照校验）**暂不接** ——
//   它尚未上线（等老板拍板换体裁），只在样例脚本里跑，不产生生产台账。
//   拍板通过后再注册，届时带着 motivatingCases 出生。

registerChecker({
  id: "fabrication_body",
  guards: "正文写了 DB 里没有的 IF / 分区 / 审稿数据（数值型编造）",
  since: "2026-07-20",
  mode: "active",
});

registerChecker({
  id: "output_health.ai_fallback_text",
  guards: "标题或正文混进了系统兜底文案（如「抱歉，AI暂时无法响应」）",
  since: "2026-07-27",
  mode: "active",
  motivatingCases: [
    {
      what: "title-generator 的「按行拆」兜底把「抱歉，AI暂时无法响应，请稍后重试。」当成标题落库",
      source: "7-27 事故；全库遗留 4 条，均已 archived（8-14 复核）",
    },
  ],
});

registerChecker({
  id: "output_health.body_too_short",
  guards: "正文过短（生成半途失败的典型形态）。当前线 300 字",
  since: "2026-07-27",
  mode: "active",
  motivatingCases: [
    {
      what: "近 30 天 214/928 篇（23.1%）正文 <800 字，但 300 字线一条都拦不到；六维分兜住了 205/214",
      source: "8-14 复核。线该不该提，等本台账的命中率/真假阳性数据（CC-待办 #17）",
    },
  ],
});

registerChecker({
  id: "output_health.title_placeholder",
  guards: "标题含未替换占位符（IF X.X / <真实分区> / {{...}}）",
  since: "2026-07-20",
  mode: "active",
});

registerChecker({
  id: "output_health.fallback_phrase",
  guards: "无指标数据时用「高影响力」「权威期刊」这类与真数据同形态的兜底形容",
  since: "2026-08-06",
  mode: "active",
});

registerChecker({
  id: "output_health.template_residue",
  guards: "模板/变量残留（[object Object] / undefined / {{IMG:...}}）",
  since: "2026-07-20",
  mode: "active",
});

registerChecker({
  id: "output_health.body_truncated",
  guards: "正文明显截断（半句结束 / markdown 语法残留）",
  since: "2026-07-20",
  mode: "active",
});

registerChecker({
  id: "output_health.body_repetition",
  guards: "同一段落大量重复（LLM 退化）",
  since: "2026-07-20",
  mode: "active",
});

registerChecker({
  id: "output_health.title_empty",
  guards: "标题为空",
  since: "2026-07-20",
  mode: "active",
});

registerChecker({
  id: "output_health.title_too_short",
  guards: "标题过短（<6 字，典型形态是模型把刊名原样返回）",
  since: "2026-07-20",
  mode: "active",
});

registerChecker({
  // ⚠️ 必须带 output_health. 前缀 —— 它是出稿健康闸的一个 code, 接线按前缀过滤。
  //   8-14 首版写成裸名, 接线时 codes 只有 9 个(闸实际有 10 个 code), 它永远不会记账。
  id: "output_health.placeholder_asset_in_body",
  guards: "内容指向占位/测试素材（dvh-fixtures 等）—— 这不是真产物",
  since: "2026-08-13",
  mode: "active",
  motivatingCases: [
    {
      what: "DVH 失败退占位样片，内容工坊里躺着 10 条「标题是真实期刊、片子是固定占位样片」的记录（片中烧着 IF6.2 与无关期刊封面）",
      source: "8-13 老韩截图 + 全量扫描；10 条已全部摘除 body，发布/分发记录 0",
    },
  ],
});

registerChecker({
  id: "dvh_bg_resolution_rejected",
  guards: "数字人背景图分辨率与输出不一致（阿里云判 10010002 且照常扣费）—— 在提交前拦下",
  since: "2026-08-13",
  mode: "active",
  motivatingCases: [
    {
      what: "近 14 天带背景图的 DVH 任务 5/5 全失败、0 成功；不带背景图 15/15 全成功。肇事图 1600×2848，比例合规但分辨率不合规",
      source: "8-13 凭 taskUuid 直查阿里云的只读探针",
    },
  ],
});

registerChecker({
  id: "subtitle_occlusion",
  guards: "字幕/字卡渲染框与数字人人物区重叠（合成前的纯几何判定）",
  since: "2026-08-12",
  mode: "active",
  motivatingCases: [
    {
      what: "env 原参数下文字框落在 54.0%~70.8%，与人物区重叠 95.1%",
      source: "8-12 版面解算实测；修正后 70.1%~85.1%，重叠 0.5%",
    },
  ],
});

registerChecker({
  id: "membership_wording",
  guards: "目录成员资格断言没锚定版本年（「是北大核心期刊」这类会随目录更新变假的话）",
  since: "2026-08-11",
  mode: "shadow",
  shadowReason: {
    reason:
      "约 30 篇实测产物上累计报出 37 条、真阳性 0 条，为此收窄了三次。" +
      "按项目自己的判据这就是零判别力检查器，再计入拍板指标就是用噪声污染决策数字。",
    date: "2026-08-11",
    promoteWhen: "连续出现真阳性 ≥ 2 例（人工确认过的、确实会随目录更新变假的句子）",
  },
  motivatingCases: [
    {
      what: "「本刊是北大核心期刊」这类现在时断言，目录一更新就变成假话",
      source: "8-11 老板定的时态纪律。注：该闸至今未在真实产物上命中过",
    },
  ],
});

registerChecker({
  id: "ranking_claim",
  guards: "文中出现名次断言（第X/位列X/排名X）—— 目录只给成员资格，不给排序",
  since: "2026-08-11",
  mode: "active",
  motivatingCases: [
    {
      what: "「教育学分类在 CSSCI 扩展版中收录本数位列第三」——中文数字，当时的数字闸只认阿拉伯数字",
      source: "8-11 从措辞闸的误报堆里翻出，正是催生本闸的那个 case（回溯，不计入上线后统计）",
    },
  ],
});
