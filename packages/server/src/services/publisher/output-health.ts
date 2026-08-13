/**
 * 7-27 出稿健康闸 —— "这篇明显是废稿, 不该发出去"的**确定性**判定。
 *
 * ═══ 事故背景 ═══
 * 7-27: 六维质检的 LLM 调用 60s 超时(v4-pro 是推理型模型, 3000 token 提示常超), 25 条内容
 *   里 20 条评分为 0 → 被红线剔除, 零进草稿箱。**同一天**, 一篇标题被占位文
 *   "抱歉，AI暂时无法响应，请稍后重试。" 覆盖的文章反而拿了六维 80 分、status=generated,
 *   一路溜进公众号草稿箱 —— 因为分发器对 generated **无条件放行**, 红线判据只对
 *   needs_review 生效。
 *
 * ═══ 定位 ═══
 * 与 compliance/content-check.ts 的 findBodyFabrication / checkTitleDataConsistency、
 * work-wechat/sensitive-filter.ts 的敏感词 DFA 同族: **纯字符串/规则判断, 零 LLM、零网络、零 DB**。
 * 区别在管的东西不同 —— 那两道管"内容说了假话/违禁话", 这道管"内容根本就是次品"
 * (占位文 / 空 / 截断 / 复读)。
 *
 * ═══ 铁律 ═══
 * ① **不看 status**: 接入点必须在 generated/needs_review 都会经过的地方, 否则就是这次事故的复刻。
 * ② **宁可漏, 不可误伤**: 每条判据都要求"正常内容几乎不可能命中"。凡是拿不准的
 *    (如"正文结尾没有句号"), 一律收紧到只抓最干净的信号(结尾是逗号/顿号/连接词)。
 * ③ **兜底文案不自己抄**: 判据引用 ai/fallback-messages.ts 的常量集, 加新兜底文案不会漏。
 */
import { findAiFallbackText } from "../ai/fallback-messages.js";

export type OutputHealthCode =
  | "ai_fallback_text"   // 标题/正文混进了系统兜底文案(本次事故的原型)
  | "title_empty"        // 标题空
  | "title_too_short"    // 标题过短
  | "title_placeholder"  // 标题含未替换的占位符(IF X.X / <真实分区> / {{...}})
  | "body_too_short"     // 正文过短(生成半途失败的典型形态)
  | "body_truncated"     // 正文明显截断(半句结束 / markdown 语法残留)
  | "body_repetition"    // 同一段落大量重复(LLM 退化)
  | "template_residue"   // 模板/变量残留([object Object] / undefined / {{IMG:...}})
  | "fallback_phrase"    // 8-06: 与真数据同形态的兜底文案(「高影响力」「权威期刊」这类)
  | "placeholder_asset_in_body"; // 8-13: body 指向占位/测试素材(dvh-fixtures 等), 见下方常量

/**
 * 🔴 占位/测试素材的路径特征 —— `contents.body` **永远不该**指向它们。
 *
 * 8-13 事故：DVH 失败时退占位样片, 于是内容工坊里躺着 10 条
 * 「标题是真实期刊、片子是固定占位样片(还烧着 IF6.2 和无关期刊封面)」的记录。
 * 降级分支已删, 理论上不会再犯 —— 这道闸是**不变式守卫**:
 * 「contents 的 body 永远不指向占位/测试素材」一条规则管全部,
 * 比"哪些该摘哪些该留"这种要人记住的分叉可靠。
 *
 * 自校验型判据: 素材路径是我们自己定的, 命中即矛盾, 不需要外部信息也不需要人看片。
 * checkerId 候选: `placeholder_asset_in_body`(Phase 1 台账的客户之一)。
 */
export const PLACEHOLDER_ASSET_MARKERS = ["dvh-fixtures/", "/placeholder-", "mock-fixture"] as const;

export interface OutputHealthIssue {
  code: OutputHealthCode;
  /** 人话说明 + 命中片段(≤120 字), 直接进 needs_review 原因与 ops_incidents */
  detail: string;
}

export interface OutputHealthResult {
  healthy: boolean;
  issues: OutputHealthIssue[];
  /** 命中的 code 列表(便于日志/落库聚合) */
  codes: OutputHealthCode[];
  /** 一句话汇总, 给 logger/异常消息用 */
  summary: string;
}

// ============ 阈值(每条都写清为什么这么定 + 误伤风险) ============

/**
 * 标题最短字数。任务方给的是 <6 字。
 * 依据: 本产品的标题 DNA 要求 30-45 字, 生产里最短的正常标题也在 15 字以上;
 * 6 字是"连一个期刊名都放不下"的水平, 只可能是生成半途失败。
 * 误伤风险: 极低。真要出现 5 字标题, 转人工也是对的。
 */
export const TITLE_MIN_CHARS = 6;

/**
 * 正文最短纯文本字数(剥 HTML/SVG 后)。
 * 依据: article 链路的目标字数最低档是"小红书 600-800 字", 公众号 1000-1500 字;
 *   六维质检的 justification 里生产实测普遍报"全文约 1800 字"。300 字连一节都写不完,
 *   属于"生成中途断了"而不是"写得短"。
 * 误伤风险: 低, 但**video 类型内容的 body 存的是 mp4 URL**(见 publisher/index.ts 的
 *   videoUrl 提取), 所以 type=video 时本项与截断/复读项一律跳过, 见 checkOutputHealth。
 */
export const BODY_MIN_PLAIN_CHARS = 300;

/**
 * 重复判据: 长度 ≥ 该值的段落出现 ≥ REPEAT_MIN_TIMES 次 = LLM 退化。
 * 依据: 20 字以下的短句(如"点击关注""数据来源: 期刊官网""投稿建议")在模板里合法重复;
 *   ≥20 字的整段一字不差出现 3 次, 正常写作不会发生。
 * 误伤风险: 低。另加一条"重复字符占比"兜底(见 REPEAT_DUP_RATIO), 抓 2 次重复但篇幅巨大的退化。
 */
export const REPEAT_MIN_SEGMENT_CHARS = 20;
export const REPEAT_MIN_TIMES = 3;
/** 重复段落吃掉全文 35% 以上 = 退化(留足余量, 正常图文的重复率实测个位数%) */
export const REPEAT_DUP_RATIO = 0.35;

/**
 * 截断判据: 正文纯文本结尾落在这些"半句"字符上。
 * 为什么不用"结尾没有句号"这种宽判据: 模板正文结尾常是数据卡/表格里的短语
 * (如"数据来源：期刊官网"), 根本不带句号, 宽判据会大面积误伤。
 * 这里只抓**明确的半句信号**: 结尾是逗号/顿号/冒号/分号/破折号, 或结尾是连接词。
 */
const DANGLING_TAIL_RE = /[，,、：:；;\-—…]$/;
const DANGLING_WORD_RE = /(?:的|和|与|而|但|以及|因为|所以|如果|虽然|不仅|例如|比如|包括|其中|同时|另外|首先|其次|由于|对于|关于)$/;

/**
 * 标题占位符。与 content-engine/title-generator.ts 的 PLACEHOLDER_RE **同一份**
 * (那边 import 本常量, 不再各写一套 —— 7-20 那道闸只在生成期生效, 出稿期这道是兜底)。
 * 只查标题: 标题短且必然指向本刊, "X区""N天"必是占位符; 正文里出现 "X 区" 可能是正常行文, 不查。
 */
export const TITLE_PLACEHOLDER_RE =
  /(?:IF|影响因子)\s*[:：]?\s*[XxNn](?:\.[XxNn])?|[XxNn]\s*(?:天|个月|月|%|区)|\$\s*[XxNn]|<[^>]{0,8}(?:分区|真实|数值)[^>]{0,8}>/;

/**
 * 8-06 **兜底文案词表** —— 与真数据同形态的模糊断言。
 *
 * 由来: 扫四个内容模板发现 `journal.impactFactor ? \`IF ${x}\` : "高影响力"` 这类写法 ——
 *   没数据时正文写成「一本叫 X 的**权威期刊**（**高影响力**）」, 措辞自信、看不出是兜底。
 *   模板侧已改成「整句不出现」或「明确标注无数据」(见 field-slot-guard.ts 文件头),
 *   **但 LLM 自己也会写出同样的话** —— 模板修完只解决一半, 所以这里再拦一道。
 *
 * ⚠️ 只在**该刊确实没有对应数据**时才算违规 —— 有 IF 的刊说「高影响力」是正常行文。
 *   所以判定需要 journalFacts, 见 checkOutputHealth 的 opts.noMetricFacts。
 *   (拿不到 facts 时**不判**, 宁可漏报也不误杀 —— 这条不是安全闸, 是质量闸。)
 */
const FALLBACK_PHRASE_PATTERNS: Array<[RegExp, string]> = [
  [/高影响力/, "「高影响力」—— 无 IF 数据时的兜底形容"],
  [/权威期刊|知名期刊|顶级期刊|优质期刊/, "「权威/知名/顶级/优质期刊」—— 无分区数据时的兜底形容"],
  [/影响因子(?:较|颇|很)?高|IF\s*(?:较|颇|很)?高/, "「影响因子较高」—— 用形容替代数值"],
  [/排版上线/, "「排版上线」—— 无刊期数据时的兜底"],
];

/** 模板/变量残留: 这些字符串出现在成稿里一定是 bug, 不是内容 */
const TEMPLATE_RESIDUE_PATTERNS: Array<[RegExp, string]> = [
  [/\{\{[^}]{0,40}\}\}/, "未替换的模板变量 {{...}}"],
  [/\[object Object\]/i, "JS 对象拼串泄漏 [object Object]"],
  [/(?:^|[\s>，。、])undefined(?:[\s<，。、]|$)/, "字面量 undefined"],
  [/(?:^|[\s>，。、])NaN(?:[\s<，。、]|$)/, "字面量 NaN"],
];

// ============ 工具 ============

/** 剥掉 SVG/style/script/注释/标签, 取可读纯文本(与 quality-check-v2 的 scorerView 同思路) */
export function toPlainText(html: string | null | undefined): string {
  if (!html) return "";
  return String(html)
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 纯文本字数(不含空白) */
function visibleLength(plain: string): number {
  return plain.replace(/\s+/g, "").length;
}

function snippet(s: string, n = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

// ============ 主闸 ============

/**
 * 出稿健康检查。**纯函数**: 无 LLM / 无网络 / 无 DB, 毫秒级, 可随便在热路径上调。
 *
 * @param input.type 内容类型。"video" 的 body 是 mp4 URL, 只查标题类判据。
 */
/**
 * 🔴 台账记账钩子（8-14 Phase 1）。**默认关闭，由调用方显式打开。**
 *
 * 为什么不在 `checkOutputHealth` 里直接写库：本函数是**纯函数**（无 LLM/网络/DB，
 * 毫秒级，可随便在热路径上调），这是它现在被到处调用的前提。塞进 DB 写入会毁掉这条契约。
 * 所以记账做成可选回调，由**真正的生产调用点**（draft-distributor / publisher）打开，
 * 单测与脚本里的调用不记账 —— 否则台账里混进测试数据，第一条记录就不可信。
 */
export type HealthLedgerHook = (codes: OutputHealthCode[]) => void;
let ledgerHook: HealthLedgerHook | null = null;
export function setHealthLedgerHook(h: HealthLedgerHook | null): void {
  ledgerHook = h;
}

export function checkOutputHealth(input: {
  title?: string | null;
  body?: string | null;
  type?: string | null;
  /**
   * 8-06: 该刊**确实没有** IF/分区数据(由 journal-data-supply 的 has 派生)。
   * 只有为 true 时才查兜底文案 —— 有 IF 的刊说「高影响力」是正常行文, 不是编造。
   * 不传 = 不判(拿不到期刊事实时宁可漏报, 这条是质量闸不是安全闸)。
   */
  noMetricFacts?: boolean;
}): OutputHealthResult {
  const issues: OutputHealthIssue[] = [];
  const title = (input.title ?? "").trim();
  const isVideo = input.type === "video";
  const plain = isVideo ? "" : toPlainText(input.body);

  // ① 占位文/错误话术 —— 标题与正文都查(判据来自 ai/fallback-messages 常量集)
  const titleFallback = findAiFallbackText(title);
  if (titleFallback) {
    issues.push({ code: "ai_fallback_text", detail: `标题是系统兜底文案「${titleFallback}」(AI 当时没返回内容)` });
  }
  const bodyFallback = findAiFallbackText(plain);
  if (bodyFallback) {
    issues.push({ code: "ai_fallback_text", detail: `正文混入系统兜底文案「${bodyFallback}」` });
  }

  // ② 空 / 异常短的标题
  if (!title) {
    issues.push({ code: "title_empty", detail: "标题为空" });
  } else if (title.replace(/\s+/g, "").length < TITLE_MIN_CHARS) {
    issues.push({ code: "title_too_short", detail: `标题仅 ${title.replace(/\s+/g, "").length} 字(<${TITLE_MIN_CHARS}): 「${snippet(title, 40)}」` });
  }

  // ③ 标题占位符(7-20 那道生成期闸的出稿期兜底)
  if (title) {
    const m = title.match(TITLE_PLACEHOLDER_RE);
    if (m) issues.push({ code: "title_placeholder", detail: `标题含未替换占位符「${m[0]}」: 「${snippet(title, 40)}」` });
  }

  // 8-13 占位/测试素材 —— 视频的 body 是 URL, 图文的 body 里也可能嵌到这类地址
  {
    const hay = `${input.title ?? ""}\n${input.body ?? ""}`;
    const marker = PLACEHOLDER_ASSET_MARKERS.find((mk) => hay.includes(mk));
    if (marker) {
      issues.push({
        code: "placeholder_asset_in_body",
        detail: `内容指向占位/测试素材(命中「${marker}」) —— 这不是真产物, 不得当成品用: 「${snippet(input.body ?? "", 60)}」`,
      });
    }
  }

  // ④ 模板/变量残留(标题 + 正文)
  const residueTarget = `${title}\n${plain}`;
  // 8-06 兜底文案(仅当该刊确实无指标数据时才判, 见 noMetricFacts 注释)
  if (input.noMetricFacts) {
    for (const [re, label] of FALLBACK_PHRASE_PATTERNS) {
      const hay = `${input.title ?? ""}\n${plain}`;
      const m = hay.match(re);
      if (m) {
        issues.push({ code: "fallback_phrase", detail: `${label}: 「${snippet(m[0], 30)}」` });
        break;
      }
    }
  }

  for (const [re, label] of TEMPLATE_RESIDUE_PATTERNS) {
    const m = residueTarget.match(re);
    if (m) {
      issues.push({ code: "template_residue", detail: `${label}: 「${snippet(m[0], 60)}」` });
      break; // 一条足够说明问题, 不刷屏
    }
  }

  if (!isVideo) {
    const len = visibleLength(plain);
    // ⑤ 正文过短
    if (len < BODY_MIN_PLAIN_CHARS) {
      issues.push({ code: "body_too_short", detail: `正文仅 ${len} 字(<${BODY_MIN_PLAIN_CHARS}), 疑生成中断: 「${snippet(plain, 60)}」` });
    } else {
      // ⑥ 明显截断(短稿已由 ⑤ 拦下, 不重复报)
      const trunc = detectTruncation(plain, input.body ?? "");
      if (trunc) issues.push({ code: "body_truncated", detail: trunc });

      // ⑦ 异常重复
      const rep = detectRepetition(plain);
      if (rep) issues.push({ code: "body_repetition", detail: rep });
    }
  }

  const codes = [...new Set(issues.map((i) => i.code))];
  // 台账记账（8-14 Phase 1）。默认无钩子 = 零行为变化; 记账失败绝不影响判定结果。
  try {
    ledgerHook?.(codes);
  } catch {
    /* 台账挂了不该让出稿跟着挂 */
  }
  return {
    healthy: issues.length === 0,
    issues,
    codes,
    summary: issues.map((i) => i.detail).join("; ").slice(0, 500),
  };
}

/** 截断检测: 只抓"明确的半句信号", 见 DANGLING_TAIL_RE 注释里的取舍。 */
export function detectTruncation(plain: string, rawBody: string): string | null {
  const tail = plain.replace(/\s+$/, "");
  if (!tail) return null;
  const last120 = tail.slice(-120);

  if (DANGLING_TAIL_RE.test(tail)) {
    return `正文以半句结束(结尾是「${tail.slice(-1)}」): 「…${snippet(last120, 60)}」`;
  }
  if (DANGLING_WORD_RE.test(tail)) {
    const m = tail.match(DANGLING_WORD_RE);
    return `正文以连接词「${m?.[0]}」结束, 疑句子未写完: 「…${snippet(last120, 60)}」`;
  }
  // markdown 语法残留: 未闭合代码块 / 结尾停在 ** 或 ## 上
  const fences = (rawBody.match(/```/g) || []).length;
  if (fences % 2 === 1) return "正文含未闭合的 ``` 代码块(markdown 语法残留)";
  if (/(\*\*|##+|\|)\s*$/.test(rawBody.trimEnd())) {
    return `正文以 markdown 语法残留结尾: 「${snippet(rawBody.trimEnd().slice(-40), 40)}」`;
  }
  return null;
}

/** 重复检测: 段落级一字不差重复。判据与阈值见文件头常量注释。 */
export function detectRepetition(plain: string): string | null {
  const segs = plain
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, "").trim())
    .filter((s) => s.length >= REPEAT_MIN_SEGMENT_CHARS);
  if (segs.length < 3) return null;

  const counts = new Map<string, number>();
  for (const s of segs) counts.set(s, (counts.get(s) ?? 0) + 1);

  let dupChars = 0;
  let worst: { seg: string; times: number } | null = null;
  for (const [seg, times] of counts) {
    if (times < 2) continue;
    dupChars += seg.length * (times - 1); // 只算"多出来的"那几遍
    if (!worst || times > worst.times) worst = { seg, times };
  }
  if (!worst) return null;

  const total = segs.reduce((n, s) => n + s.length, 0);
  const ratio = total > 0 ? dupChars / total : 0;
  if (worst.times >= REPEAT_MIN_TIMES) {
    return `同一段落重复 ${worst.times} 次(LLM 退化): 「${snippet(worst.seg, 60)}」`;
  }
  if (ratio >= REPEAT_DUP_RATIO) {
    return `重复段落占正文 ${Math.round(ratio * 100)}%(LLM 退化): 「${snippet(worst.seg, 60)}」`;
  }
  return null;
}

/** 落进 contents.metadata 的原因码 —— 与 needsReviewReason 单点对齐, 别各处写字符串 */
export const OUTPUT_UNHEALTHY_REASON = "output_unhealthy";
