/**
 * 数据卡「格子」的确定性校验 —— 四个模板共用的唯一归宿（8-06）。
 *
 * ## 病症一：LLM 把非数字塞进 IF 槽
 *
 * 8-06 扫近 30 天 116 篇带 IF 槽的内容: 数字 63 / 占位符 44 / **非法 8（6.9%）**。
 * 八条非法值原样如下 —— 注意它们的形态:
 *
 *     0.917（复合影响因子）        2023年复合IF约1.2         同类1区约5-6
 *     复合影响因子 0.694（2023版）  新刊或暂无公开IF          暂无IF数据
 *     CSSCI来源期刊                暂无数据（该刊为中文核心，暂无JCR影响因子）
 *
 * **带括号、带解释、带"约"** —— 这是 LLM 在写句子, 不是代码把 A 字段赋给了 B 字段。
 * (逐条排查过: AI 造刊路径有 `typeof === "number"` 守卫、enrichment 不赋 impactFactor、
 *  title-generator 的 idTags 只喂标题 prompt。渲染器本身写的是 `x ? ... : "—"`, 也是对的。)
 * 所以拦截点只能在**渲染层**: LLM 想怎么写是它的事, 但写进格子的必须是合法值。
 *
 * ## 病症二：满卡「暂无」= 空洞
 *
 * 一格暂无是诚实, 满卡暂无是空洞 —— 后者正是老板说的「数据太少/空洞」。
 * 所以给标注设上限: **超过半数格子无数据 → 整张卡不出现**(与 P0-A 的
 * 「没有的板块整块不出现」同一条逻辑)。
 *
 * ## 关于「兜底文案」的正确形态（CLAUDE.md 红线 #14）
 *
 * 兜底**不许产出与真数据同形态的文案**。两种正确写法, 本项目都有现成范例:
 *
 *   ① 整句不出现 —— 适合嵌在叙述句里的
 *      范例: storytelling-template.ts 的 qualifier(8-06 由「权威期刊（高影响力）」改成)
 *   ② 明确标注无数据 —— 适合数据卡格子(格子不能空)
 *      范例: shunshi-style-template.ts:415「未分区」/ :417「JCR 分区数据未公布」
 *            / :517「近年 CAR 指数暂未公布」  ← 这三条是**正确做法的样板, 别动它们**
 *
 * ❌ 错误写法: 无 IF 写「高影响力」、无分区写「权威期刊」、无刊期写「排版上线」。
 *   它们看起来和真数据一模一样, 读者与下游都无从分辨。
 */

/** 无数据时格子里显示什么 —— 全项目统一, 别各写各的 */
export const SLOT_EMPTY = "—";

export interface SlotCheck {
  /** 能不能渲染进格子 */
  ok: boolean;
  /** 通过时的规范化值; 未通过为 SLOT_EMPTY */
  value: string;
  /** 未通过的原因(落 metadata 供统计串位率) */
  reject?: string;
}

const ok = (value: string): SlotCheck => ({ ok: true, value });
const bad = (reject: string): SlotCheck => ({ ok: false, value: SLOT_EMPTY, reject });

/** 是不是"明确标注无数据"的占位(这类不算非法, 但也不算有值) */
export function isEmptyMarker(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return s === "" || s === SLOT_EMPTY || s === "-" || /^(暂无|未知|待评估|N\/A)/.test(s);
}

/**
 * IF 槽：只收数字。
 * 上界 300 与 crawler/trusted-facts-validator 同源 —— 真 IF 不会超过它,
 * 而 2026 这类**年份**是抓取错位的典型形态(7-25 LetPub 改版事故)。
 */
export function checkImpactFactorSlot(v: unknown): SlotCheck {
  if (v == null || isEmptyMarker(v)) return bad("empty");
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0 || v > 300) return bad(`out_of_range:${v}`);
    return ok(String(v));
  }
  const s = String(v).trim();
  // 刻意**不做**"从句子里抠数字" —— 「2023年复合IF约1.2」抠出 1.2 会把一句话
  //   降级成一个看起来精确的数, 那是把编造洗成事实。非数字就是没有。
  if (!/^\d+(\.\d+)?$/.test(s)) return bad(`not_numeric:${s.slice(0, 40)}`);
  const n = Number(s);
  if (n <= 0 || n > 300) return bad(`out_of_range:${s}`);
  return ok(s);
}

/**
 * 分区槽：只收合法分区格式。
 * 「北大核心」「CSSCI来源期刊」是**目录成员资格**不是分区 —— 塞进分区槽属结构性错位。
 */
const PARTITION_RE = /^(Q[1-4]|[1-4]区|[一二三四]区|[^\s]{1,10}[1-4]区(TOP)?|中科院[1-4]区(TOP)?)$/i;
export function checkPartitionSlot(v: unknown): SlotCheck {
  if (v == null || isEmptyMarker(v)) return bad("empty");
  const s = String(v).trim();
  if (!PARTITION_RE.test(s)) return bad(`not_partition:${s.slice(0, 40)}`);
  return ok(s);
}

/** 录用率槽：只收百分数或 0-1 比值 */
export function checkAcceptanceRateSlot(v: unknown): SlotCheck {
  if (v == null || isEmptyMarker(v)) return bad("empty");
  const n = typeof v === "number" ? v : Number(String(v).replace(/%$/, "").trim());
  if (!Number.isFinite(n) || n <= 0) return bad(`not_rate:${String(v).slice(0, 40)}`);
  const pct = n <= 1 ? n * 100 : n;
  if (pct > 100) return bad(`out_of_range:${String(v).slice(0, 40)}`);
  return ok(`${pct.toFixed(0)}%`);
}

/**
 * 满卡「暂无」判定 —— 超过半数格子无数据就别渲染这张卡了。
 * 一格暂无是诚实, 满卡暂无是空洞。
 */
export const CARD_EMPTY_RATIO_LIMIT = 0.5;

export function shouldHideCard(slots: Array<{ ok: boolean }>): boolean {
  if (slots.length === 0) return true;
  const empty = slots.filter((s) => !s.ok).length;
  return empty / slots.length > CARD_EMPTY_RATIO_LIMIT;
}

/** 把一组校验结果里的拒绝原因收集起来, 落 metadata 供统计串位率随 prompt 改进的变化 */
export function collectSlotRejects(slots: Record<string, SlotCheck>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(slots)) {
    // empty 是正常的"没数据", 不算串位, 不记
    if (!v.ok && v.reject && v.reject !== "empty") out[k] = v.reject;
  }
  return out;
}
