/**
 * ⚠️ 反编造相关的函数(checkTitleDataConsistency / findBodyFabrication /
 *    findBodyFabricationMulti / checkRoundupFabrication / checkBodyFabricationForPublish /
 *    fabricationPublishGate)是**四道反编造判据里的第 ①道**。
 *    四道分别管什么、在哪个环节生效、为什么不能互相替代 —— 见
 *    `services/compliance/fabrication-criteria.ts` 的文件头总纲。
 *    共享的正则 / 字段名清单 /「值为空」判定也都在那里, **不许在本文件再复制一份**。
 *
 * PR-Z3: 内容合规层 — 商业化前置防线。
 * 1. 违禁词检查: 硬词(发布即封号级风险)拦截; 软词(广告法/医疗宣传红线)警告放行并记 metadata。
 *    词库 = 内置基础库 + SYSTEM config.automationConfig.complianceWords {hard[], soft[]} 扩展。
 * 2. AI 生成标识: 按《生成式AI服务管理办法》/《深度合成管理规定》要求, 发布时文末追加标识
 *    (SYSTEM config.automationConfig.aiLabel: false 可关, 默认开)。
 * 注: 词库为技术兜底, 不构成法律意见; 客户行业(医学学术)广告法红线建议请专业人士复核扩充。
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../../models/db.js";
import { tenants } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { logger } from "../../config/logger.js";
import {
  TITLE_DATA_CLAIM,
  TITLE_IF_CLAIM,
  TITLE_PARTITION_CLAIM,
  IF_FACT_KEYS,
  PARTITION_FACT_KEYS,
  ALL_FACT_KEYS,
  hasDbFact,
  hasAnyFact,
  providesAnyKey,
} from "./fabrication-criteria.js";

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

// 6-19: 生成阶段自动净化 — 把"无歧义的"绝对化/医疗/投稿过度承诺词替换成合规说法,
// 让生成出来的内容/文案基本不带违规词(避免发布时才拦截 → 白烧 token + 白等生成)。
// 故意不动学术语境常见且合法的词(第一作者/国家级期刊/最佳论文奖), 那些靠 checkCompliance 软词警告人工判。
//
// 7-30 拆成两段(顺序与拼接后的原表完全一致, 规则之间互不影响):
//   COMPLIANCE_RULES = 真·违规词 → 也被 findUnambiguousViolations 当"红线词"用;
//   DIRT_RULES       = LLM 拼接脏点(学科名叠字), 不是违规, 绝不能拿去拦人。
// 拆开的原因: 文字稿直生要"命中就拒绝并明说哪个词", 需要复用这份**已经过筛的无歧义词表**,
//   而不是再造一份 —— 再造一份就意味着两份词表迟早不一致。
const COMPLIANCE_RULES: Array<[RegExp, string]> = [
  // 医疗红线
  [/根治/g, "改善"],
  [/治愈率/g, "有效率"],
  [/包治百病|包治/g, "有助于"],
  [/药到病除/g, "效果明显"],
  [/100\s*%\s*有效|百分之百有效|百分百有效/g, "效果显著"],
  [/完全无副作用|无任何副作用|绝无副作用/g, "副作用较小"],
  // 投稿/录用过度承诺
  [/保证录用|百分百中刊|百分之百录用|包过|保过|包录用|稳过|稳发|稳中|稳录|包中/g, "录用率较高"],
  [/包发表|保发表|保证发表/g, "较易发表"],
  // 7-03 ③: 投稿承诺性话术红线（老韩反馈"据xx查询…可放心投稿"式替读者拍板的承诺全禁）
  [/(?:可以|可)?放心投稿/g, "综合评估后再投稿"],
  [/闭眼[投冲]必中|投了?必中|必中无疑/g, "命中率相对较高"],
  // 赚钱类
  [/稳赚不赔|稳赚|躺赚/g, "有收益空间"],
  // 绝对化(无歧义)
  [/绝无仅有/g, "较为少见"],
  [/全球首创|全球首发|全球第一|世界第一/g, "较早"],
  [/世界级/g, "高水平"],
  [/极致/g, "出色"],
];

// 7-05 脏点清理: 大类学科名叠字(LLM 拼接 discipline+分区串致"医学医学2区TOP"). 限已知学科名, 不误伤合法叠词。
// ⚠️ 这不是违规词 —— 只做净化, 不参与任何拦截判断。
const DIRT_RULES: Array<[RegExp, string]> = [
  [/(医学|生物学|工程技术|化学|物理学|材料科学|环境科学与生态学|环境科学|数学|农林科学|地球科学|计算机科学|药学|管理科学|经济学|心理学|社会学)(TOP)?\1/g, "$1$2"],
];

const SANITIZE_MAP: Array<[RegExp, string]> = [...COMPLIANCE_RULES, ...DIRT_RULES];

export function sanitizeForCompliance(text: string | null | undefined): string {
  if (!text) return text ?? "";
  let out = String(text);
  for (const [re, rep] of SANITIZE_MAP) out = out.replace(re, rep);
  return out;
}

/** 命中的无歧义红线词 + 建议替换说法。 */
export interface UnambiguousViolation {
  /** 原文里实际出现的那个词(不是正则), 直接拿去给运营看 */
  word: string;
  /** 合规替换建议 = 生成侧净化时会换成的说法, 口径天然一致 */
  suggest: string;
}

/**
 * 7-30 找出文本里的"无歧义红线词"(医疗承诺 / 投稿保过 / 绝对化用语)。
 *
 * 与 checkCompliance 的分工:
 *   - checkCompliance.hardHits = 政治高危词 → 封号级, 拦。
 *   - checkCompliance.softHits = **有歧义**的绝对化词("第一""国家级""最佳"), 在学术语境里
 *     大量合法(第一作者/国家级期刊/最佳论文奖) → 只警告, 拦了全是误伤。
 *   - 本函数 = COMPLIANCE_RULES 那份**已经过筛的无歧义**词表 → 出现即违规, 可以放心拦。
 *
 * 为什么直生链路要用它: 文章链路的正文是 AI 按红线 prompt 写的、生成时还跑了
 *   sanitizeForCompliance 自动净化; 运营手写的口播稿这两道全绕过去了。
 */
export function findUnambiguousViolations(text: string | null | undefined): UnambiguousViolation[] {
  if (!text) return [];
  const plain = String(text).replace(/<[^>]+>/g, "");
  const out = new Map<string, string>(); // word → suggest, 天然去重
  for (const [re, suggest] of COMPLIANCE_RULES) {
    // 正则都带 g, 但 lastIndex 是有状态的 —— 每次新建一个, 别在模块级共享实例上 match
    for (const m of plain.matchAll(new RegExp(re.source, re.flags))) {
      if (m[0] && !out.has(m[0])) out.set(m[0], suggest);
    }
  }
  return [...out].map(([word, suggest]) => ({ word, suggest }));
}

// 7-03 标题-正文一致性检查（行7 教训: 标题喊"稳发", 正文却"CAR 高风险, 建议避开" = 信任事故）。
// 规则级、零 LLM、极便宜: 只在正文出现高风险/预警/退稿信号时, 才禁止标题的"稳发/稳过/闭眼冲/放心/沾边就收"类保录承诺。
// (无风险信号时这些狠话由 rotation 限量放行, 不在此拦; 命中即转 needs_review, 标题需人工/重生修正)
/**
 * 🔴 8-23 修否定误伤。**正则看得见词，看不见否定。**
 *
 * 原判据里 `预警名单` 是裸词，于是这句话被判成风险信号：
 *
 * ```
 * 「该刊不在中科院预警名单中，投稿风险较低」
 *              ↑ /预警名单/ 命中 → 判为「正文有风险」
 * ```
 *
 * 实测（8-23，全时段 348 例命中）：
 *
 * ```
 * 预警名单   230 例  →  225 例是「不在/未列入预警名单」   真在预警名单的只有 4 例
 * 谨慎评估    81 例  →   80 例是模板固定小标题「谨慎评估：经费有限的团队…」
 *                        80 例上下文是版面费，与期刊风险无关
 * ─────────────────────────────────────────────
 * 合计       305/348 = 87.6% 是误伤
 * ```
 *
 * ## 🔴 修法用「要求正面证据」，不是「排除已知反例」
 *
 * 第一版我写的是排除法：`(?<!不在|未列入|…)预警名单`。它**当场漏掉了第三种形态** ——
 *
 * ```
 * ✅ 预警名单✅ 中科院《国际期刊预警名单》：不在预警名单中。
 *    ↑ 模板小标题，前面没有否定词（否定在后面），排除法看不见它
 * ```
 *
 * 重跑实测：排除法只把命中从 358 降到 190，而预期是 ~43。
 *
 * **排除法永远会漏掉下一种形态**，因为反例集合是开放的、而你只能列举已知的那些。
 * 改成白名单：**必须出现肯定断言**（已列入/列入/进入/位列/属于/在 + 预警名单），
 * 且前面不是「不」。这样新的表述形态默认不命中，而不是默认命中。
 *
 * ▎ 判据要求正面证据时，未知形态默认放行；
 * ▎ 判据排除已知反例时，未知形态默认命中 —— 而未知形态总是更多。
 *
 * ## 同一条原则的另外两处应用（8-23 迭代到第三版才收敛）
 *
 * **① 间隔里不许夹否定**：`[^。；\n不未非没无]{0,8}` ——
 * 这个否定字集**改了两轮才收敛**（先漏「不」在间隔里，再漏「没」）——
 * 又一次印证：**列举永远列不全**。这里能用列举是因为中文否定词是**闭集**（不/未/非/没/无），
 * 换成开放集合（比如「哪些措辞算风险」）就必须回到正面证据那条路。
 *
 * **③ 否定要加在每一个入口上**：`(?<![不没未非无])上了?预警` ——
 * 「没**上预警**名单」被 `上了?预警` 这条**另一个分支**命中了。
 * 我给 `预警名单` 那条加了否定守卫，却漏了同一语义的另一个入口。
 *
 * ▎ 一个语义在正则里有几个入口，否定守卫就要加几次。
 * ▎ 只守住最显眼的那个入口，等于没守 —— 漏的那个会安静地继续误报。
 * 第二版写成 `[^。；\n]{0,8}`，于是「在它**不**在预警名单」命中了
 * （`在` 起头、间隔吞掉「它不」、接上「预警名单」）。
 * 前瞻 `(?<!不)` 只看紧邻一个字，管不住间隔里的否定。
 *
 * **② 删掉 `谨慎评估`**：它在本产品里是模板固定小标题
 * （「👥 适合人群 / 适合投：… / 谨慎评估：经费有限的团队（版面费偏高）」），
 * 说的是**读者要不要谨慎**，不是**期刊有没有风险**。
 * 第二版加了 `(?![：:])` 想放过小标题，但正文里这个词出现两次，
 * 第一次带冒号被跳过、匹配落到后面那次 —— **局部排除挡不住重复出现**。
 * 真正的风险表述由 `建议谨慎` 覆盖，删掉它不损失召回。
 *
 * **这类误伤是系统性且单向的**：所有「不在 X」都被读成「在 X」，
 * 没有反方向的错误来抵消。所以它的误报率**不会随样本增大而回归**，
 * 而是稳定地错在同一个方向 —— 一个 bug、一个方向、229 篇。
 *
 * 后果不只是误报，是**归因错误**：因为两侧都「命中」，被判为信任事故
 * （标题喊保录 + 正文有风险），而实际只有标题侧是真的。
 * 分类决定处置，而处置不可逆（归档 vs 重写）。
 */
const BODY_RISK_SIGNAL = /高风险|(?<!不)(?:已列入|列入|进入|位列|属于|在)[^。；\n不未非没无]{0,8}预警名单|已列入预警|(?<![不没未非无])上了?预警|建议(?:谨慎|避开|回避|绕行)|已被\s*SCI\s*除名|被踢出|剔除出|拒稿率(?:高|偏高)|退稿率(?:高|偏高)|自引率[^。]{0,8}(?:高风险|偏高|过高)/;
/**
 * 🔴 8-23 拆成两类。**原来一个词表混了两种性质完全相反的词。**
 *
 * ```
 * 硬禁类   稳发/稳过/包过/包录/必中/无脑冲/放心投  —— 在 COMMON_BANNED 里，任何情况都不该出现
 * 限量类   闭眼冲/闭眼投/沾边就收                  —— AGGRESSIVE_TITLE_TAGS，老韩 8-23 确认保留，
 *                                                     由 usage-rotation 限额轮换
 * ```
 *
 * 混在一起的后果：限量类（实测占标题命中的 99%，448/452）一旦碰上正文侧误伤，
 * 就被判成与硬禁类同级的「信任事故·永不进池」——
 * **一个被设计允许的钩子话术，因为另一侧的 bug，被当成不可修复的红线。**
 */
const TITLE_HARD_BANNED = /稳发|稳过|稳中|稳录|放心[投冲发]|包过|包录|必中|无脑冲/g;
const TITLE_RATE_LIMITED = /闭眼[投冲]|沾边就收|有手就发|灌水神刊/g;

/**
 * 判定档位。**分类决定处置，而处置不可逆** —— 所以分类必须比 ok/not-ok 细。
 *
 * 原来只有一个布尔：不 ok 就是 `title_body_inconsistent`（红线类·永不进池）。
 * 于是三种性质完全不同的情况被压成一种，其中两种的正确处置是「改标题」或「放行」。
 */
export type TitleBodyVerdict =
  | "ok"                    // 放行
  | "hard_banned_title"     // 标题含硬禁词 —— 与正文无关，改标题
  | "trust_incident";       // 标题喊保录 + 正文真有风险 —— 7-03 那次事故的形态，归档

/**
 * 标题-正文一致性。8-23 重写：**拆判据 + 修否定误伤**。
 *
 * ## 🔴 为什么必须拆：复合判据的分类由最弱的一项决定
 *
 * 实测两侧可靠性相差 20 倍：
 *
 * ```
 * 标题侧  448/452 全真   ← 生成侧确实在写「闭眼冲」
 * 正文侧  305/348 全假   ← 否定句 + 模板小标题误伤
 * 判据    标题 ∧ 正文
 * ```
 *
 * AND 连接了两个可靠性差 20 倍的信号，结果的可靠性由弱的那侧决定 ——
 * **而它的「分类」也由弱的那侧决定，后者后果更大**：
 * 因为两侧都「命中」，被判为信任事故（不可修复、永不进池），
 * 而实际只有标题侧是真的，真实性质是「标题用词」（改一句话就好）。
 *
 * 44% 的产出、138 篇（全时段 348 篇），大部分是这个形态。
 *
 * ## 三档怎么分
 *
 * ```
 * 标题含硬禁词(稳发/包过/必中…)              → hard_banned_title  改标题，与正文无关
 * 标题含限量词(闭眼冲…) ∧ 正文真有风险        → trust_incident     归档（7-03 事故形态）
 * 标题含限量词 ∧ 正文无真风险                 → ok                 **合法** —— 老韩 8-23
 *                                                                   确认保留该类话术，
 *                                                                   额度由 usage-rotation 管
 * 正文真有风险 ∧ 标题无承诺                   → ok                 诚实报告风险，不是问题
 * ```
 *
 * ⚠️ 第三档是**有意放行**，不是漏判。原设计注释写着「无风险信号时这些狠话由
 * rotation 限量放行，不在此拦」—— 拆判据是为了让这句话真正成立，
 * 而不是被正文侧的 bug 连坐。
 */
export function checkTitleBodyConsistency(
  title: string | null | undefined,
  body: string | null | undefined,
): { ok: boolean; verdict: TitleBodyVerdict; titleHits: string[]; riskSignal: string | null } {
  const t = title || "";
  const hardHits = [...new Set(t.match(TITLE_HARD_BANNED) || [])];
  const rateHits = [...new Set(t.match(TITLE_RATE_LIMITED) || [])];
  const plainBody = (body || "").replace(/<[^>]+>/g, "");
  const risk = plainBody.match(BODY_RISK_SIGNAL);

  /**
   * 🔴 **必须先看正文，硬禁词不许短路。**
   *
   * 第一版把硬禁词判定放在最前面直接 return —— 于是「标题喊稳发 + 正文说 CAR 高风险」
   * 这个**行7 原始事故**再也走不到信任事故那一档，被降级成「可修复·非红线」。
   * 而它正是这道闸存在的理由。
   *
   * 基线闸当场抓住了这条（`title-body-consistency.test.ts` 的行7 用例）——
   * 一次**真回归**，不是漂移。
   *
   * ▎ 重构判据时，最容易弄丢的恰好是它最初为之而建的那个 case ——
   * ▎ 因为新分类是照着「现在看到的数据」划的，而那个 case 早已不在数据里
   * ▎ （它被修好之后就不再发生了）。
   */
  if (risk && (hardHits.length > 0 || rateHits.length > 0)) {
    return { ok: false, verdict: "trust_incident", titleHits: [...hardHits, ...rateHits], riskSignal: risk[0] };
  }
  // 正文无真风险时：硬禁词仍然违规（与正文无关），但属可修复档
  if (hardHits.length > 0) {
    return { ok: false, verdict: "hard_banned_title", titleHits: hardHits, riskSignal: null };
  }
  // 限量话术 + 正文干净 = 合法（老韩 8-23 确认保留，额度归 usage-rotation 管）
  return { ok: true, verdict: "ok", titleHits: [], riskSignal: risk ? risk[0] : null };
}

// 7-05 脏点清理(行1 教训): 标题的"审稿周期/录用率"具体数字必须在正文复现。
// 正文由核验过的期刊库派生 → 正文没有 = DB 没有 = 标题编造(行1 标题"审稿60天/录用率35%", DB两者皆空, 正文写"3-4个月/较低")。
//
// 7-20 补 IF/分区两维(信任红线)。原注释写"IF/分区等几乎必复现, 不查以免误伤" ——
//   这个前提**只对国际刊成立**: 国际刊 DB 有 IF, LLM 写的数字正文能复现, 所以不查没事;
//   国内刊 DB 根本没有 IF/分区(2746 本国内核心刊中 有IF 213 本=7.8%、有分区 8 本=0.3%),
//   LLM 只能凭空编, 而校验对它完全睁眼瞎。
//   生产实测(近30天): 国内刊 185 篇里 57 篇(31%)标题写了 DB 没有的 IF, 其中 40 篇 status=generated
//   可发布、6 篇已推送草稿/已发出。故补这两维, 走与审稿/录用率完全相同的机制, 不新造闸门。
//
// 7-28 (#6) 收口: 三条正则 + 字段名清单 + "值为空"判定已移到 fabrication-criteria.ts
//   (本文件顶部 import)。原来它们只在本文件定义, 但字段名清单在本文件内就手抄了 5 遍,
//   "值为空"更是三套写法并存(见 hasDbFact 的注释)。
/**
 * 7-20 正文编造检测（评分器用）。
 *
 * 缺口背景: 今早补了**标题**编造校验(无据数字 → needs_review), 但**正文**编造无人管,
 *   而六维评分器反而在**奖励**它 —— 实测重打分时, 一篇标题写"IF9.0+1个月光速审稿、管理学报1区"
 *   的国内刊文章拿到 78 分(全样本第二高), 正因为编出来的数字让"数据准确/信息密度"看起来达标。
 *   → 校验拦它转人工, 评分器却给它高分, 闭环是漏的。本函数补上正文这一侧。
 *
 * 判据与标题侧**完全一致**(复用同三条正则 + 同一套 DB 有无判断, 不新造标准):
 *   DB 该字段为空 = 该刊客观没有这个指标 = 正文里出现的数字必然无源。
 *   同样用"键是否存在"决定要不要查, 调用方没提供该字段就跳过, 不臆断。
 *
 * ⚠️ 只查 IF / 分区 两类。**刻意不查正文里的审稿周期/录用率数字** ——
 *   正文常有"中文核心审稿普遍 6-12 个月"这类**行业通论**(不是对本刊的断言), 查了会大量误伤;
 *   而 IF / 分区 是刊级专属指标, 正文里出现就是在说这本刊, 无源即编造, 判定干净。
 *   标题侧仍然全查四类(标题短、必然指向本刊, 无此歧义)。
 */
export function findBodyFabrication(
  body: string | null | undefined,
  db?: TitleDataDbFields,
): string[] {
  if (!db || !body) return [];
  const plain = body.replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ");
  // 7-28 (#6): 原来这两段一个用 `== null`、一个用 truthiness `||` —— 同一个文件里两套
  //   "值为空"口径, 对 `partition = ''` / `impactFactor = 0` 给出相反答案。
  //   统一走 fabrication-criteria.ts 的 hasAnyFact(== null 口径, 理由见那里的长注释)。
  const hits: string[] = [];
  if (providesAnyKey(db, IF_FACT_KEYS) && !hasAnyFact(db, IF_FACT_KEYS)) {
    for (const c of [...new Set(plain.match(TITLE_IF_CLAIM) || [])]) hits.push(`${c.trim()}(DB无影响因子)`);
  }
  if (providesAnyKey(db, PARTITION_FACT_KEYS) && !hasAnyFact(db, PARTITION_FACT_KEYS)) {
    for (const c of [...new Set(plain.match(TITLE_PARTITION_CLAIM) || [])]) hits.push(`${c.trim()}(DB无分区)`);
  }
  return hits;
}

/**
 * 7-25 多刊事实并集 —— roundup(多刊盘点)编造检测用。
 *
 * 语义: 把 N 本刊的 DB 事实压成"一本虚拟刊", 再交给 findBodyFabrication 判 ——
 *   **不新造判据**, 完全复用单刊那套(与全系统一致的"键存在才查, 值为空才算编造")。
 *
 * 两条规则:
 *   ① **键的存在性取并集**: 只要有一本刊提供了该键, 结果就带这个键(=可以查);
 *      没有任何一本提供 → 键缺席 → 校验跳过(不臆断)。
 *   ② **值取"任一非空"**: 只要有一本刊有真 IF/分区, 并集就算"有" → 正文里的
 *      IF/分区数字视为有源, 放行。
 *
 * 为什么是"任一"而不是"逐刊就近匹配": 盘点正文里"XX刊 IF 3.2"与刊名的绑定关系,
 *   经 LLM 改写 + HTML 模板重排后已不可靠(刊名被 《》 包裹/简称/改写), 就近匹配会产生
 *   大量误判 —— 而误判正是 6577b9a 被回滚的原因。"任一"是保守侧: 绝不新增误伤,
 *   只抓最高危也最干净的一类 —— **全部相关刊都没有 IF/分区, 正文却写了数字**
 *   (纯国内刊盘点的典型编造形态)。代价是混合刊单里针对某一本的编造抓不到(见已知限制)。
 */
export function mergeJournalFacts(
  facts: Array<TitleDataDbFields | null | undefined>,
): TitleDataDbFields | undefined {
  const list = facts.filter((f): f is TitleDataDbFields => !!f);
  if (list.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  // 7-28 (#6): 字段清单改用 ALL_FACT_KEYS(唯一定义处), "值为空"改用 hasDbFact ——
  //   原来这里是本文件的**第三套**判空写法(`!== null && !== undefined && !== ""`),
  //   与上面两处都不一样。三套口径混用 = 同一行数据在不同函数里得到不同结论。
  for (const k of ALL_FACT_KEYS) {
    const provided = list.filter((f) => k in f);
    if (provided.length === 0) continue; // 无人提供该键 → 保持缺席, 校验跳过
    const hit = provided.find((f) => hasDbFact((f as Record<string, unknown>)[k]));
    out[k] = hit ? (hit as Record<string, unknown>)[k] : null;
  }
  return out as TitleDataDbFields;
}

/** 多刊版正文编造检测(roundup)。等价于"把 N 本刊并成一本"后跑 findBodyFabrication。 */
export function findBodyFabricationMulti(
  body: string | null | undefined,
  facts: Array<TitleDataDbFields | null | undefined>,
): string[] {
  return findBodyFabrication(body, mergeJournalFacts(facts));
}

const CN_CORE_TAGS_GATE = ["pku-core", "cssci", "cssci-ext", "cscd"];

/** 纯国内刊判定(与 article-skill 的 isPureDomesticJournal 同口径): 有中文核心标签且不含 sci-core。 */
function isPureDomesticCatalogs(catalogs: unknown): boolean {
  const cats = (catalogs as string[] | null) || [];
  return cats.some((c) => CN_CORE_TAGS_GATE.includes(c)) && !cats.includes("sci-core");
}

/**
 * 7-21 发布前编造硬闸(确定性兜底) — draft-distributor / publishToAccounts 共用。
 *
 * 定位: "prompt 降低 + 确定性兜底"里的确定性那半。生成侧 prompt 已把纯国内刊正文编造从 56% 压到
 *   ~13%, 但 prompt 有天花板(LLM 在卖点诱导下仍偶尔编 IF/分区)。这道闸让漏网的 13% 即使
 *   分数侥幸过线, 也**发不出去** —— 对外零编造。
 *
 * 只对**纯国内刊 + DB 无 IF/分区**生效:
 *   - 骑墙刊(catalogs 含 sci-core)**豁免** —— 它们分区可能是 enrichment 从 LetPub 抓的真数据(backlog-C),
 *     误挡有据内容正是 6577b9a 被回滚的原因。
 *   - 无中文核心标签的国际刊也不进(它们本就该有 IF/分区)。
 *   复用 findBodyFabrication(同一套判断), 不新写检测逻辑。
 *
 * 7-25 扩多刊(roundup 多刊盘点): 传 journalIds 即可。语义是单刊那套的保守推广 ——
 *   ① 只要**任一**相关刊不是纯国内刊(骑墙/国际) → 整篇豁免(沿用骑墙豁免, 绝不新增误挡);
 *   ② 全是纯国内刊时, 用 mergeJournalFacts 并集判(任一刊有真 IF/分区就放行)。
 *   单刊调用行为与 7-21 完全一致(rows 只有一行时 every === 原 isPureDomestic 判定)。
 *
 * @returns 命中的无据指标列表; 空 = 放行。调用方据此决定是否拦下 + 标 needs_review/body_fabrication。
 */
export async function checkBodyFabricationForPublish(content: {
  body?: string | null;
  journalId?: string | null;
  /** 7-25 多刊盘点(roundup): 本篇涉及的全部刊。与 journalId 可同时传, 内部去重。 */
  journalIds?: string[] | null;
}): Promise<string[]> {
  return (await checkPublishJournalGate(content)).fabrication;
}

/**
 * 7-28 (#6) 发布期期刊侧总闸 —— **一次查库, 同时给出判据 ① 与判据 ⑤ 的结论**。
 *
 * ## 为什么把 ⑤(期刊可信度)也接进发布链路
 * 审计发现的缺口: `verification.ts` 的 `isUnverifiedJournal` 只有三个消费方 ——
 *   生成期 batch-worker(标 needs_review/unverified_source_journal)、客服播报护栏、
 *   选刊器 SQL —— **发布链路三道闸一道都没读它**。后果:
 *   ① batch-worker 那道只在 `tenantId === SYSTEM 租户` 时才判, 租户自己触发的生成完全不查;
 *   ② roundup 根本不走 batch-worker, 整条链路对源刊可信度失明;
 *   ③ 就算标上了 `unverified_source_journal`, 它既不在 RED_LINE_REASONS(会被剔除)
 *      也不在 TAIL_REASONS(会排队尾) —— 于是**与完全核实过的内容平起平坐抢名额**。
 *   而 ①②④ 三道判据校的都是**数字**: 一篇讲 LLM 编出来的影子刊的文章, 每个数字都能在
 *   那条假记录里找到"源", 三道闸全绿, 而整本刊不存在。这是最贵的一类信任事故。
 *
 * ## 分两档处理(刻意不是一刀切拦截)
 *   · **硬红线 = `dataSource === 'ai_fabricated'`**: LLM 自己编出来的影子刊, 刊名/CN 刊号/
 *     主办方全是假的。这是**确定性事实**(一个字段值, 零推断), 误判率结构上为 0, 所以拦得起。
 *   · **软降级 = 未通过分体系可信门槛**: 拦不得。7-28 刚把国内刊改成目录成员资格判定,
 *     但目录字段(catalogs/cscd_level/…)本身还有回填缺口, 现在一刀切拦截 = 复刻 7-27 的
 *     零产出事故。改为**排队尾**: 核实过的内容先占名额, 不够时它们才顶上, 运营在草稿箱里
 *     还能看到 needs_review 标。零停产风险, 又确实改变了推什么。
 *
 * @returns fabrication 沿用原语义(命中的无据指标, 空=放行); 另加两个期刊侧信号。
 */
export interface PublishJournalGateResult {
  /** 判据①: 正文里无据的 IF/分区。空 = 放行。 */
  fabrication: string[];
  /** 判据⑤ 硬红线: 本篇关联到 LLM 编出来的影子刊(dataSource='ai_fabricated')。 */
  aiFabricatedJournal: boolean;
  /** 判据⑤ 软信号: 关联刊未过分体系可信门槛(见 verification.ts)。调用方应排队尾, **不要拦**。 */
  unverifiedJournal: boolean;
  /** 实际查到的关联刊数。0 = 无期刊可判, 上面三项一律空/false。 */
  journalCount: number;
}

const EMPTY_GATE: PublishJournalGateResult = {
  fabrication: [], aiFabricatedJournal: false, unverifiedJournal: false, journalCount: 0,
};

export async function checkPublishJournalGate(content: {
  body?: string | null;
  journalId?: string | null;
  journalIds?: string[] | null;
}): Promise<PublishJournalGateResult> {
  const ids = [...new Set([
    ...(Array.isArray(content.journalIds) ? content.journalIds : []),
    ...(content.journalId ? [content.journalId] : []),
  ].filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (ids.length === 0) return EMPTY_GATE;
  const { journals } = await import("../../models/schema.js");
  // ⚠️ 投影必须覆盖 isUnverifiedJournal 读的**全部**字段 —— 少投影一列, 国内刊会落回
  //   国际刊那把尺子(isIntlVerified), 88% 被误判未核实(batch-worker:325 踩过同一个坑)。
  const rows = await db
    .select({
      catalogs: journals.catalogs,
      impactFactor: journals.impactFactor,
      compositeImpactFactor: journals.compositeImpactFactor,
      partition: journals.partition,
      casPartition: journals.casPartition,
      casPartitionNew: journals.casPartitionNew,
      jcrFull: journals.jcrFull,
      confidence: journals.confidence,
      dataSource: journals.dataSource,
      cscdLevel: journals.cscdLevel,
      pkuCoreLevel: journals.pkuCoreLevel,
      catalogType: journals.catalogType,
      cnNumber: journals.cnNumber,
      publisher: journals.publisher,
    })
    .from(journals)
    .where(inArray(journals.id, ids));
  if (rows.length === 0) return EMPTY_GATE;

  const { isUnverifiedJournal } = await import("../journals/verification.js");
  const aiFabricatedJournal = rows.some((r) => r.dataSource === "ai_fabricated");
  const unverifiedJournal = rows.some((r) => isUnverifiedJournal(r));

  // 判据①: 骑墙豁免 + 只管纯国内刊(多刊: 有一本骑墙/国际就整篇豁免)
  const fabrication = content.body && rows.every((r) => isPureDomesticCatalogs(r.catalogs))
    ? findBodyFabricationMulti(content.body, rows.map((j) => ({
        impactFactor: j.impactFactor, compositeImpactFactor: j.compositeImpactFactor,
        partition: j.partition, casPartition: j.casPartition, casPartitionNew: j.casPartitionNew, jcrFull: j.jcrFull,
      })))
    : [];

  return { fabrication, aiFabricatedJournal, unverifiedJournal, journalCount: rows.length };
}

/**
 * 标题的审稿周期/录用率具体数字校验。两道:
 *  ① DB 硬校验(最强): 传 db 时, 审稿数字要求 db.reviewCycle 非空、录用率数字要求 db.acceptanceRate 非空;
 *     字段 DB 为空 = 该数字必是编造(行4: 标题+正文都写"审稿60天/录用率35%"一致编造, 但 DB 两者皆空)。
 *  ② 正文复现(兜底, 未传 db 时): 标题数字须在正文出现(治标题-正文脱节, 行1)。
 */
/** 标题数字校验用的 DB 字段。7-20 扩 IF/分区两维(原仅 reviewCycle/acceptanceRate)。 */
export interface TitleDataDbFields {
  reviewCycle?: string | null;
  acceptanceRate?: number | null;
  impactFactor?: number | null;
  compositeImpactFactor?: number | null;
  /** 分区证据。⚠️ 实测(7-20)真正有数据的是 casPartitionNew(国际刊 2182 本)与 jcrFull(4158 本);
   *  partition 仅 32 本、casPartition **整列为空(0 行)** —— 只查前两者会把大量国际刊误判编造。 */
  partition?: string | null;
  casPartition?: string | null;
  casPartitionNew?: string | null;
  jcrFull?: unknown;
}

export function checkTitleDataConsistency(
  title: string | null | undefined,
  body: string | null | undefined,
  db?: TitleDataDbFields,
): { ok: boolean; mismatches: string[] } {
  const plainBody = (body || "").replace(/<[^>]+>/g, "");
  const claims = [...new Set((title || "").match(TITLE_DATA_CLAIM) || [])];
  const mismatches: string[] = [];
  for (const c of claims) {
    const m = c.match(/(\d+(?:\.\d+)?)\s*(天|周|个月|月|%)/);
    if (!m) continue;
    const [, num, unit] = m;
    const isAcceptance = unit === "%";
    // ① DB 硬校验: 字段空 → 编造
    // 7-28 (#6): 审稿周期原来用 `!db.reviewCycle` 的 truthiness, 录用率用 `== null` ——
    //   同一个 if 里两套口径。统一走 hasDbFact。
    if (db) {
      if (isAcceptance && !hasDbFact(db.acceptanceRate)) { mismatches.push(`${c}(DB无录用率数据)`); continue; }
      if (!isAcceptance && !hasDbFact(db.reviewCycle)) { mismatches.push(`${c}(DB无审稿周期数据)`); continue; }
    }
    // ② 正文复现
    const unitAlt = unit === "月" || unit === "个月" ? "(?:个月|月)" : unit === "%" ? "%" : unit;
    if (!new RegExp(num.replace(".", "\\.") + "\\s*" + unitAlt).test(plainBody)) mismatches.push(`${c}(正文未复现)`);
  }

  // 7-20 IF/分区两维: **只做 DB 有无校验, 不做正文复现**。
  //   理由: 一致编造(标题正文都写 IF 2.0)对国内刊是常态 —— 正文本身就是 LLM 写的, 复现校验拦不住;
  //   而 DB 空 = 该刊客观没有这个指标 = 标题里的数字必然无源。不传 db 时跳过(退化为原行为, 不误伤)。
  //   ⚠️ 用"键是否存在"而非"值是否为 null"决定要不要查 —— 调用方若只传了
  //   { reviewCycle, acceptanceRate }（IF 字段整个缺席），说明它没提供 IF 信息，
  //   此时必须跳过，不能当成"DB 无 IF"去判编造，否则会把所有带 IF 的标题全误伤。
  //   (这些字段类型上都是可选的，TS 拦不住漏传；显式 in 判断是唯一可靠护栏。)
  if (db) {
    if (providesAnyKey(db, IF_FACT_KEYS) && !hasAnyFact(db, IF_FACT_KEYS)) {
      for (const c of [...new Set((title || "").match(TITLE_IF_CLAIM) || [])]) {
        mismatches.push(`${c.trim()}(DB无影响因子数据)`);
      }
    }
    if (providesAnyKey(db, PARTITION_FACT_KEYS) && !hasAnyFact(db, PARTITION_FACT_KEYS)) {
      for (const c of [...new Set((title || "").match(TITLE_PARTITION_CLAIM) || [])]) {
        mismatches.push(`${c.trim()}(DB无分区数据)`);
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * 7-25 多刊盘点(roundup)编造检测 —— 生成期用。
 *
 * 缺口: roundup 不走 batch-worker / quality-pipeline(那两处才有 journalId → journalFacts 的接线),
 *   于是三道编造闸对它**全部空转**: findBodyFabrication 无 facts 直接 return []、
 *   checkTitleDataConsistency 无 dbFields 退化成"正文复现"(而正文也是同一个 LLM 写的, 拦不住
 *   一致编造)、发布期硬闸查不到 journalId 直接放行。而 roundup 每天在产, 一篇说 3 本刊,
 *   是编 IF/分区风险最高的形态之一。
 *
 * 判定 = 单刊那套的多刊保守推广, **不新造标准**:
 *   ① 骑墙豁免(与发布硬闸同口径): 任一相关刊不是纯国内刊 → 整篇跳过。
 *      roundup 选刊直接读 DB、**不跑 enrichment**, 所以骑墙刊在这里必然是"DB 空但实际有数据",
 *      查了就是 6577b9a 的覆辙(把有据当编造)。宁可漏, 不可误伤。
 *   ② 全纯国内刊时: 用 mergeJournalFacts 并集 → 复用 checkTitleDataConsistency(标题四维)
 *      + findBodyFabrication(正文 IF/分区两维)。
 */
export async function checkRoundupFabrication(content: {
  title?: string | null;
  body?: string | null;
  journalIds?: string[] | null;
}): Promise<{ ok: boolean; mismatches: string[]; checked: boolean }> {
  const ids = [...new Set((content.journalIds ?? []).filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (ids.length === 0 || !content.body) return { ok: true, mismatches: [], checked: false };
  try {
    const { journals } = await import("../../models/schema.js");
    const rows = await db
      .select({
        catalogs: journals.catalogs,
        reviewCycle: journals.reviewCycle,
        acceptanceRate: journals.acceptanceRate,
        impactFactor: journals.impactFactor,
        compositeImpactFactor: journals.compositeImpactFactor,
        partition: journals.partition,
        casPartition: journals.casPartition,
        casPartitionNew: journals.casPartitionNew,
        jcrFull: journals.jcrFull,
      })
      .from(journals)
      .where(inArray(journals.id, ids));
    if (rows.length === 0) return { ok: true, mismatches: [], checked: false };
    // ① 骑墙豁免
    if (!rows.every((r) => isPureDomesticCatalogs(r.catalogs))) return { ok: true, mismatches: [], checked: false };
    // ② 并集判定
    const facts = rows.map((r) => ({
      reviewCycle: r.reviewCycle, acceptanceRate: r.acceptanceRate,
      impactFactor: r.impactFactor, compositeImpactFactor: r.compositeImpactFactor,
      partition: r.partition, casPartition: r.casPartition, casPartitionNew: r.casPartitionNew, jcrFull: r.jcrFull,
    }));
    const merged = mergeJournalFacts(facts);
    const mismatches = [
      ...checkTitleDataConsistency(content.title, content.body, merged).mismatches,
      ...findBodyFabrication(content.body, merged),
    ];
    return { ok: mismatches.length === 0, mismatches: [...new Set(mismatches)], checked: true };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "roundup 编造检测异常, 放行(不阻塞每日生成)");
    return { ok: true, mismatches: [], checked: false };
  }
}

/**
 * 发布期数据编造硬闸决策（纯函数，复用 checkTitleDataConsistency）。
 * 仅对生成期已标 needs_review / hasWarnings 的内容生效；标题审稿周期/录用率数字无 DB 支撑 = 编造。
 * 同客服线 findUnsourcedNumbers 哲学：LLM 嘴里的数字必须有源。DB 查询留调用方（本函数纯）。
 * @returns action: pass(放行) | block(拒发) | override(forceOverride 强发, 调用方须落审计); mismatches 列无源数字
 */
export function fabricationPublishGate(opts: {
  status?: string | null;
  hasWarnings?: boolean;
  title?: string | null;
  body?: string | null;
  dbFields?: TitleDataDbFields;
  forceOverride?: boolean;
}): { action: "pass" | "block" | "override"; mismatches: string[] } {
  const flagged = opts.status === "needs_review" || opts.hasWarnings === true;
  if (!flagged) return { action: "pass", mismatches: [] }; // 正常内容零触发, 保证零回归
  const td = checkTitleDataConsistency(opts.title, opts.body, opts.dbFields);
  if (td.ok) return { action: "pass", mismatches: [] };
  return { action: opts.forceOverride ? "override" : "block", mismatches: td.mismatches };
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
