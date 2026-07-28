/**
 * 期刊 prompt「字段契约」—— 阶段1-C Prompt 治理的核心。
 *
 * ## 为什么有这个文件
 *
 * article-skill 的主 prompt 是 22 个 PR 层层 append 出来的 204 行模板字面量。
 * 同一个"字段"会在**四个互不知情的块**里被提到:
 *   ①##已知期刊数据##(能写什么)  ②##未公开字段##(禁止提)  ③##禁止字段##(黑名单)  ④密度要求(必须写)
 * 块与块之间零交叉校验, 于是同一类事故重复了 4 次(PR #228 / #225 / #233 / 7-28):
 *
 *   ##未公开字段##: "以下字段无数据, 文章中**完全不要提及**: 录用率、审稿周期…"
 *   密度要求:       "每 200 字至少 1 个具体数字(IF/两套分区/审稿周期/录用率/版面费)"
 *
 * LLM 同时收到"不许提"和"必须提"时, 理性选择是**编一个** → 被防编造闸拦下 → 转人工待审。
 * 这就是"国内刊文章少 / 待审堆积"的直接原因之一。
 *
 * 每次修复都是单点打补丁(7-28 只修了国内刊分支, 国际刊分支那条密度规则**至今还是手写死字符串**)。
 * 本文件把这四个块收口成**同一份数据结构 + 同一个生成函数**, 并加一条纯函数断言:
 *
 *   requiredFields(密度要求点名的) ∩ forbiddenFields(禁写的) === ∅
 *
 * ## 三条设计约定
 *
 * 1. **字段是枚举, 不是字符串**。`JournalPromptField` 是唯一的字段词表, 四个块全部按它渲染。
 * 2. **禁写永远压过要写**。冲突时以"禁"为准(少写一个数据点 < 编一个数据点)。
 * 3. **断言跑在最终契约上**。生成侧已经按规则消解过冲突, 断言是防"未来有人再加一个块"的护栏:
 *    开发/测试期抛错(把 bug 挡在 CI), 生产期记 incident + 自动修正(绝不因为 prompt 洁癖停产)。
 */

import { isDomesticKind, toJournalKind } from "../journals/journal-kind.js";
import { hasIntlSignal } from "../journals/intl-signal.js";

// ============ 字段词表 ============

/**
 * prompt 里会被"点名"的期刊字段。
 * 加新字段时必须同时补 FIELD_LABEL, 否则渲染出的块里会出现 undefined。
 */
export type JournalPromptField =
  | "discipline"       // 学科
  | "impactFactor"     // JCR/SCI 影响因子
  | "compositeIF"      // 复合影响因子(知网/万方口径, 国内指标)
  | "partition"        // 中科院分区 / JCR 分区
  | "partitionNew"     // 中科院新锐分区
  | "acceptanceRate"   // 录用率(精确 % 或 ablesci 定性词)
  | "reviewCycle"      // 审稿周期
  | "publisher"        // 出版商
  | "foundingYear"     // 创刊年
  | "country"          // 出版国
  | "apc"              // 版面费
  | "annualVolume"     // 年发文量
  | "indexStatus"      // 收录情况(WOS/核心目录)
  | "warningList";     // 中科院预警名单

export const FIELD_LABEL: Record<JournalPromptField, string> = {
  discipline: "学科",
  impactFactor: "影响因子",
  compositeIF: "复合影响因子",
  partition: "分区",
  partitionNew: "新锐分区",
  acceptanceRate: "录用率",
  reviewCycle: "审稿周期",
  publisher: "出版商",
  foundingYear: "创刊年",
  country: "出版国",
  apc: "版面费",
  annualVolume: "年发文量",
  indexStatus: "收录情况",
  warningList: "预警名单",
};

/**
 * 「硬数据」候选池 —— 密度要求只能从这里点名。
 *
 * 学科/收录情况/出版商是**定性信息**不是硬指标, 点名它们凑密度会诱导 LLM 把
 * "本刊属于医学领域"这种废话当数据点。故不入池。
 */
const DENSITY_CANDIDATES: readonly JournalPromptField[] = [
  "impactFactor", "compositeIF", "partition", "partitionNew",
  "reviewCycle", "acceptanceRate", "apc", "annualVolume",
] as const;

/**
 * 永久黑名单 —— 任何期刊、任何分支都不许写具体值。
 *
 * 依据两条独立事实:
 *   - PR #167 backfill 报告: 这两列 DB **0 源覆盖**(库里的值 100% 是 AI 编的)
 *   - PR #168 hotfix: in-memory 的 foundingYear/country 会被 `ensureJournalEnriched` 的
 *     AI 推测污染, validator 明确"不能拿它当 DB truth"
 *
 * 7-28 阶段1-C 修的第二个矛盾: 旧代码 `if (journal.foundingYear) knownFields.push("- 创刊年：X")`
 * 会把这个被污染的值塞进 ##已知期刊数据##(等于"这是真数据, 随便写"), 而 ##禁止字段## 块同时
 * **无条件**写着"禁止提具体年份" —— 又一处教 LLM 犯懵的自相矛盾。现在统一按"禁"处理:
 * 不进已知数据块, 不进密度要求, 只在 ##禁止字段## 里出现一次。
 */
const PERMANENT_BLACKLIST: readonly JournalPromptField[] = ["foundingYear", "country"] as const;

// ============ 契约类型 ============

export interface JournalFieldContract {
  /** 有真实数据、允许在正文引用的字段 */
  knownKeys: JournalPromptField[];
  /** 禁止在正文出现具体值的字段(无数据 + 黑名单 + 分支红线) */
  forbiddenKeys: JournalPromptField[];
  /** 密度要求**点名要求写**的字段。铁律: 必须 ⊆ knownKeys 且 ∩ forbiddenKeys = ∅ */
  densityKeys: JournalPromptField[];
  /** 有数据但被分支红线压掉的字段(如纯国内刊的 IF/分区) —— 供排查"为什么这个数没喂给 LLM" */
  suppressedKeys: JournalPromptField[];

  // ---- 渲染好的块(全部由上面的 key 集合生成, 不许手写字面量) ----
  /** ##已知期刊数据## 的逐行内容 */
  knownLines: string[];
  /** ##未公开字段## 块(无禁写字段时为空串) */
  unknownBlock: string;
  /** ##禁止字段## 黑名单块 */
  blacklistBlock: string;
  /** 「数据密度与卖点兑现」块的 1./2. 两条(国内/国际同源生成) */
  densityRule: string;

  // ---- 分支判定(透传, 供调用方拼别的块) ----
  isDomestic: boolean;
  isPureDomestic: boolean;
  /** 国内口径复合影响因子(有真 IF 时为 null) */
  compositeIF: number | null;
  /** 国内刊专属写作指引(非国内刊为空串) */
  domesticGuidance: string;
}

// ============ 国内刊判定 + 指引(7-28 从 article-skill 迁入, 与字段契约同源) ============

/**
 * 7-21 纯国内核心刊判定 — 决定是否注入"正文分区/IF 禁写"红线。
 *   纯国内刊 = 有中文核心标签(北大核心/CSSCI/CSSCI扩展/CSCD) 且 **不含 sci-core**。
 *   严格排除骑墙刊(含 sci-core): 它们分区可能是 enrichment 有据的(backlog-C), 禁写会误伤 ——
 *   这正是 6577b9a 全局禁写被回滚的原因。纯国内刊不在 SCI 分区体系, 禁写 100% 安全。
 */
const CN_CORE_TAGS = ["pku-core", "cssci", "cssci-ext", "cscd"];
export function isPureDomesticJournal(catalogs: string[] | null | undefined): boolean {
  const cats = catalogs || [];
  return cats.some((c) => CN_CORE_TAGS.includes(c)) && !cats.includes("sci-core");
}

/**
 * 7-28 (#2/#3): 国内刊分支判定 + 专属写作指引 — 纯函数, 单测可直接断言 prompt 组装结果。
 *
 * 判定口径与 title-generator.ts 统一: **有中文核心目录标签 且 无真实国际 IF(>0)** = 国内刊。
 * 修死代码: 旧式 `cats.length>0 && !(ifText && !ifText.includes("未知"))` 里 ifText 无 IF 时是
 * "N/A"(恒真值, 不含"未知") → 整个表达式恒 false → 7-21 改动3 的国内刊分支上线以来**从未走到过**。
 *
 * 复合影响因子(#3): 万方回填的 composite_impact_factor(447 本医学刊)接进生成 —— 国内刊无 JCR IF
 * 但有复合 IF 时作为国内口径指标给 LLM, 强制全称+口径标注, 防被简写成"影响因子 X"冒充 SCI 指标。
 * 字段双路径: collector 产出叫 compositeIF, batch 直查 DB 行(drizzle)叫 compositeImpactFactor。
 *
 * 禁写清单动态化: 旧文案硬说"没有精确录用率/审稿周期数据", 但 knownFields 一直会渲染 DB 里真实的
 * reviewCycle/acceptanceRate —— 两处自相矛盾会让 LLM 犯懵。现按"本刊真没有的字段"动态生成禁写项。
 */
export function buildDomesticJournalGuidance(j: {
  catalogs?: string[] | null;
  impactFactor?: number | null;
  compositeIF?: number | null;           // collector 路径字段名
  compositeImpactFactor?: number | null; // DB 直查路径字段名
  reviewCycle?: string | null;
  acceptanceRate?: number | null;
  discipline?: string | null;
  // 7-28: journal_kind 判定要用的其余信号(全 optional, 传得到就用) —— 少了它们只会退回
  //   "catalogs 非空 && 无 IF" 的老口径, 不会误判成国内刊。
  partition?: string | null;
  casPartition?: string | null;
  catalogType?: string | null;
  cscdLevel?: string | null;
  pkuCoreLevel?: string | null;
  cnNumber?: string | null;
}): { isDomestic: boolean; guidance: string; compositeIF: number | null } {
  const cats = j.catalogs || [];
  const hasIF = j.impactFactor != null && j.impactFactor > 0; // PR #209: IF<=0 是占位值, 当"无 IF"
  // 7-28 (③b): 判定收口到 journal_kind 单一真相源(替换 `cats.length > 0` 这半条启发式)。
  //   `isDomesticKind` = kind 落 'cn'(纯国内)或 'both'(骑墙); 再叠加"无真实 IF"这一条不变 ——
  //   IF>0 就按国外刊写, IF<=0 是占位值当无 IF(PR #209)。
  //   相对老口径的唯一变化是**把裂缝刊捞回来**: 只写了 pku_core_level/cscd_level 而 catalogs
  //   为空的刊(enricher orchestrator:280-289 的产物), 老口径判它"不是国内刊" → 拿不到国内刊
  //   写作指引、被按 SCI 口径写。其余情形结果与老口径逐条一致。
  const isDomestic = isDomesticKind(toJournalKind(j)) && !hasIF;
  const cifRaw = j.compositeIF ?? j.compositeImpactFactor ?? null;
  const compositeIF = !hasIF && cifRaw != null && cifRaw > 0 ? cifRaw : null;
  if (!isDomestic) return { isDomestic, guidance: "", compositeIF };
  // 身份组合区分度: 三核心 > 北大+CSSCI > 纯 CSCD (与库内分布一致, 让 LLM 拿捏权威分量)
  const idTags: string[] = [];
  if (cats.includes("pku-core")) idTags.push("北大核心");
  if (cats.includes("cssci")) idTags.push("CSSCI（南大核心）来源期刊");
  if (cats.includes("cssci-ext")) idTags.push("CSSCI 扩展版来源期刊");
  if (cats.includes("cscd")) idTags.push("CSCD（中国科学引文数据库）");
  const idWeight = idTags.length >= 3 ? "三核心齐收（分量最重的一档国内核心）"
    : (cats.includes("pku-core") && cats.includes("cssci")) ? "北大核心 + CSSCI 双核心（国内社科顶配）"
    : cats.includes("pku-core") ? "北大核心（评职称/毕业最认的硬通货）"
    : "国内核心收录";
  // 禁写/缺失清单按真实数据动态生成: JCR IF/中科院分区/JCR 分区对国内刊恒禁; 录用率/审稿周期看 DB。
  const missing: string[] = ["JCR/SCI 影响因子(IF)", "中科院分区", "JCR 分区"];
  const forbidden: string[] = ["JCR/SCI 口径的 IF 数字", `"X区"/"中科院X区"/"JCR Qx" 等分区表述`];
  if (j.acceptanceRate == null) { missing.push("精确录用率"); forbidden.push("具体录用率百分比"); }
  if (!j.reviewCycle) { missing.push("精确审稿周期"); forbidden.push("具体审稿天数/周期"); }
  const haves: string[] = [];
  if (compositeIF != null) haves.push(`复合影响因子 ${compositeIF.toFixed(3)}（知网/万方口径，国内影响力指标）—— 可以写，但必须写全"复合影响因子"并注明国内口径，🚫 严禁写成"影响因子 ${compositeIF.toFixed(3)}"/"IF ${compositeIF.toFixed(3)}"冒充 SCI/JCR 指标`);
  if (j.reviewCycle) haves.push(`审稿周期 ${j.reviewCycle}（DB 真实数据，见##已知期刊数据##）—— 可如实写`);
  if (j.acceptanceRate != null) haves.push(`精确录用率（见##已知期刊数据##）—— 可如实写`);
  const guidance = `

## ⚠️ 本刊是【国内核心期刊】—— 按国内口径写，别套 SCI 那一套
**本刊没有：${missing.join("、")}。** 这不是数据缺失，是国内核心刊本来就不用这套 SCI 指标体系来衡量。
${haves.length ? `**本刊真实有的国内口径数据（只许用这些，别的数字一律不许出现）：**\n${haves.map((s) => `- ${s}`).join("\n")}\n` : ""}🚫 **绝对禁止**在标题或正文写：${forbidden.join("、")}。
   写了 = 编造 = 生成后校验会拦下转人工复核 = 这篇白写，还占了别人的产能。

**国内核心刊的卖点主线，按这个顺序写（这才是国内作者真正认的东西）：**
① 权威身份（最硬的卖点）：${idWeight}。收录情况：${idTags.join("、") || "国内核心"}。
   讲清"这是什么级别的刊、在评职称/毕业/项目结题里认不认" —— 这比 IF 对国内作者实在得多。
② 学科定位：${j.discipline || "见收录方向"}方向。说清它在这个学科里是什么位置、适合哪类研究主题。
③ 投稿方向：收什么类型稿件（论著/综述/实证/个案）、谁该投（硕博毕业/评职称/一线教师医生）、怎么投得中。

## 篇幅与密度（国内刊专属，破"无数据硬凑"死循环）
- **目标 600-800 字**，讲清"什么级别的刊 + 适合谁投 + 怎么投"即可，**不硬凑 1600 字**。
- 没有 SCI 数字不等于没有信息密度：身份组合、CSCD 核心/扩展库、学科分类、收录目录、
  投稿方向、适配人群、评职称/毕业适用性${compositeIF != null ? "、复合影响因子（国内口径）" : ""}${j.reviewCycle ? "、审稿周期" : ""} —— 这些都是国内作者要的实打实信息，写满它们密度天然够。
- **宁可短而实，不要长而空。** 通篇"认可度高/学术声誉好/值得一投"这类空话 = 不合格。
`;
  return { isDomestic, guidance, compositeIF };
}

// ============ 契约生成 ============

/** buildJournalFieldContract 的入参 —— JournalInfo 的结构子集(纯函数, 好单测) */
export interface JournalFieldInput {
  discipline?: string | null;
  impactFactor?: number | null;
  compositeIF?: number | null;
  compositeImpactFactor?: number | null;
  partition?: string | null;
  casPartition?: string | null;
  casPartitionNew?: string | null;
  acceptanceRate?: number | null;
  acceptanceDifficulty?: string | null;
  reviewCycle?: string | null;
  publisher?: string | null;
  foundingYear?: number | null;
  country?: string | null;
  apcFee?: number | null;
  annualVolume?: number | null;
  isWarningList?: boolean | null;
  catalogs?: string[] | null;
  catalogType?: string | null;
  cscdLevel?: string | null;
  pkuCoreLevel?: string | null;
  cnNumber?: string | null;
  jcrFull?: unknown;
  promptJcrFull?: { wosLevel?: string } | null;
  promptPublicationCosts?: { apc?: number; currency?: string } | null;
}

/**
 * 由期刊真实数据生成 prompt 字段契约 —— **四个字段相关块的唯一生成入口**。
 *
 * 生成顺序(冲突消解规则, 按优先级从高到低):
 *   1. 永久黑名单(创刊年/出版国) → 恒禁, 不进已知数据
 *   2. 纯国内刊红线(IF/分区/新锐分区) → 恒禁, 即使 DB 有值也压掉(记 suppressedKeys)
 *   3. DB 无值 → 进 ##未公开字段##(禁提)
 *   4. 剩下的才是 knownKeys; 密度要求只从 knownKeys ∩ 硬数据候选池里点名
 */
export function buildJournalFieldContract(j: JournalFieldInput): JournalFieldContract {
  const hasIF = j.impactFactor != null && j.impactFactor > 0; // PR #209: IF<=0 是占位值
  const ifText = hasIF ? (j.impactFactor as number).toFixed(1) : "N/A";
  const cats = j.catalogs || [];
  const domesticParts = buildDomesticJournalGuidance(j);
  const isPureDomestic = isPureDomesticJournal(cats);

  // ---- 1) 逐字段判"有没有数据" + 渲染 ##已知期刊数据## 行 ----
  const rawKnown = new Map<JournalPromptField, string>();
  const noData: JournalPromptField[] = [];

  if (j.discipline) rawKnown.set("discipline", `- 学科：${j.discipline}`);
  else noData.push("discipline");

  // 7-28 修 "N/A" 恒真值(#2): 旧判断 `ifText && !ifText.includes("未知")` 对无 IF 的 "N/A" 恒真 →
  //   把"影响因子：N/A"塞进 ##已知期刊数据##(等于教 LLM 写 N/A 或自己编个数)。改判 hasIF(数值>0)。
  if (hasIF) rawKnown.set("impactFactor", `- 影响因子：${ifText}`);
  else noData.push("impactFactor");

  // 7-28 (#3): 复合影响因子(知网/万方口径) —— 无值时**静默缺席**(不进未公开清单, 免得点名反诱导)
  if (domesticParts.compositeIF != null) {
    const cifText = domesticParts.compositeIF.toFixed(3);
    rawKnown.set("compositeIF", `- 复合影响因子（知网/万方口径，国内影响力指标，**不是 JCR 影响因子/IF**）：${cifText}。正文提及必须写全"复合影响因子"并注明国内口径，🚫 严禁简写成"影响因子 ${cifText}"/"IF ${cifText}"冒充 SCI/JCR 指标`);
  }

  // PR #232 (5-23): 分区/新锐分区加 [原文搬运] 标记 — 防 AI 改数字(3→2)/改顺序。
  const partitionText = j.casPartition || j.partition;
  if (partitionText) rawKnown.set("partition", `- 分区 [必须原文搬运, 不得改字/改顺序/简化]：${partitionText}`);
  else noData.push("partition");
  // PR #229: 空也声明, 防 AI 编造
  if (j.casPartitionNew) rawKnown.set("partitionNew", `- 新锐分区 [必须原文搬运, 不得改字/改顺序/简化]：${j.casPartitionNew}`);
  else noData.push("partitionNew");

  // PR #235 (5-23): 录用率两路径 — LetPub 48 本给精确 %, ablesci ~2200 本给模糊词。
  if (j.acceptanceRate != null) {
    rawKnown.set("acceptanceRate", `- 录用率：${(j.acceptanceRate >= 1 ? j.acceptanceRate : j.acceptanceRate * 100).toFixed(0)}%`);
  } else if (j.acceptanceDifficulty) {
    rawKnown.set("acceptanceRate", `- 投稿难度：${j.acceptanceDifficulty}（ablesci 定性评价, 非精确录用率）`);
  } else {
    noData.push("acceptanceRate");
  }

  if (j.reviewCycle) rawKnown.set("reviewCycle", `- 审稿周期：${j.reviewCycle}`);
  else noData.push("reviewCycle");

  if (j.publisher) rawKnown.set("publisher", `- 出版商：${j.publisher}`);
  else noData.push("publisher");

  // 创刊年/出版国: 见 PERMANENT_BLACKLIST 注释 —— 不进已知、也不进"未公开"(它们的归宿是黑名单块)

  // PR #228 (5-23): APC 双路径合一 — apcFee 列空但 publicationCosts.apc(JSONB) 有值也算"已知"。
  const apcValue = j.apcFee ?? j.promptPublicationCosts?.apc ?? null;
  const apcCurrency = j.promptPublicationCosts?.currency || "USD";
  if (apcValue != null && apcValue > 0) rawKnown.set("apc", `- 版面费 (APC)：${apcCurrency} ${apcValue}`);
  else if (apcValue === 0) rawKnown.set("apc", `- 版面费 (APC)：免费 (无 APC)`);
  else noData.push("apc");

  // 7-03 B-①: 年发文量注入正文 — 无值时静默缺席(不点名, 免得诱导编造)
  if (j.annualVolume) rawKnown.set("annualVolume", `- 年发文量：约 ${j.annualVolume} 篇/年`);

  // 预警名单只覆盖国际(SCI)刊; 国内刊不在其适用范围, 不做"不在预警名单"的正面断言(避免误导)
  //
  // 7-28: 后半段原本自己拼了一遍"有没有国际指标"(impactFactor/partition/jcrFull), 又漏了
  //   casPartitionNew/casPartition —— 这是同一个坑当天踩的第三次(前两次见 intl-signal.ts 文件头病史)。
  //   漏判的后果: 有中科院分区但无 IF 的国际刊被判"不在预警适用范围", 于是连"不在预警名单中"
  //   这句正面背书都不写, 白丢一个卖点。
  //   拆法: isWarningList 是预警名单语义(保留), "有没有国际指标"换成单一真相源 hasIntlSignal。
  const inWarnScope = !!j.isWarningList || hasIntlSignal(j);
  if (j.isWarningList) rawKnown.set("warningList", "- ⚠️ 在中科院预警名单中");
  else if (inWarnScope) rawKnown.set("warningList", "- 不在中科院预警名单中");

  // PR #184 (5-20): 收录状态注入 — 严格按真实字段, 防止非 SCI 期刊被当 SCI 写
  rawKnown.set("indexStatus", buildIndexStatusLine(j, cats));

  // ---- 2) 禁写集合 ----
  //   顺序即优先级: 无数据 → 永久黑名单 → 纯国内刊红线
  const forbidden = new Set<JournalPromptField>(noData);
  for (const k of PERMANENT_BLACKLIST) forbidden.add(k);
  if (isPureDomestic) {
    // 7-21 纯国内核心刊(北大核心/CSSCI/CSCD, 非 SCI): 客观上没有中科院分区/JCR 分区/影响因子。
    //   这条红线原本只写在 prompt 尾部, 与 ##已知期刊数据##/密度要求零交叉校验 —— 现在进契约,
    //   DB 万一有值也一律压掉(见 suppressedKeys), 不再"一边给数一边说不许写"。
    forbidden.add("impactFactor");
    forbidden.add("partition");
    forbidden.add("partitionNew");
  }

  // ---- 3) 冲突消解: 禁写永远压过已知 ----
  const suppressedKeys: JournalPromptField[] = [];
  const knownKeys: JournalPromptField[] = [];
  const knownLines: string[] = [];
  for (const [key, line] of rawKnown) {
    if (forbidden.has(key)) { suppressedKeys.push(key); continue; }
    knownKeys.push(key);
    knownLines.push(line);
  }

  // ---- 4) 密度要求只从"真有数据且没被禁"的硬指标里点名 ----
  const densityKeys = DENSITY_CANDIDATES.filter((k) => knownKeys.includes(k));

  // ---- 5) 渲染四个块 ----
  //   ##未公开字段## 只列"真的没数据"的字段: 黑名单字段(创刊年/出版国)可能 DB 有值, 说它"无数据"
  //   是撒谎, 它们的归宿是 ##禁止字段## 块。
  const unknownLabels = noData.map((k) => FIELD_LABEL[k]);
  const unknownBlock = unknownLabels.length > 0
    ? `\n##未公开字段## (以下字段无数据, 文章中**完全不要提及这些字段**, 禁止出现"暂无/未公开/据公开资料尚无/由于缺乏...数据"等任何说法)：${unknownLabels.join("、")}\n`
    : "";

  const contract: JournalFieldContract = {
    knownKeys,
    forbiddenKeys: Array.from(forbidden),
    densityKeys,
    suppressedKeys,
    knownLines,
    unknownBlock,
    blacklistBlock: buildBlacklistBlock(forbidden),
    densityRule: buildDensityRule({
      densityKeys,
      isDomestic: domesticParts.isDomestic,
      discipline: j.discipline ?? null,
    }),
    isDomestic: domesticParts.isDomestic,
    isPureDomestic,
    compositeIF: domesticParts.compositeIF,
    domesticGuidance: domesticParts.guidance,
  };

  // ---- 6) 交叉校验(护栏): 生成侧已消解过冲突, 这里只挡"未来新增块又把矛盾写回来" ----
  return assertNoContradiction(contract, { stage: "buildJournalFieldContract" });
}

/** PR #184/#207/#225/#230/#233: 收录状态行 —— 有证据按证据写, 没证据保持中性(既不假称也不否认) */
function buildIndexStatusLine(j: JournalFieldInput, cats: string[]): string {
  const indexStatuses: string[] = [];
  const wosLevel = j.promptJcrFull?.wosLevel;
  if (wosLevel) indexStatuses.push(`WOS ${wosLevel}`); // SCIE / SSCI / ESCI / AHCI
  if (cats.includes("cssci")) indexStatuses.push("CSSCI（南大核心）");
  if (cats.includes("pku-core")) indexStatuses.push("北大核心");
  if (cats.includes("cscd")) indexStatuses.push("CSCD（中国科学引文数据库）");
  if (j.catalogType === "sci" || j.catalogType === "sci-core") {
    if (!wosLevel) indexStatuses.push("SCI 收录");
  }
  if (indexStatuses.length === 0) {
    // PR #225 (5-23): 软化 — wosLevel 字段空≠真未被收录(LetPub 数据可能未覆盖到该刊)。
    //   原文案"严禁称 SCI"导致 AI 主动写"未被 SCI 收录"误导用户。改为中性: 不假称 + 不主动否认.
    return `- 收录情况：本系统未明确记录该刊的 WOS/核心收录等级（**不代表未收录**, 可能仅是数据未覆盖）。文章中**绝对不要**主动声称该刊"未被 SCI 收录"/"未被 SSCI 收录"/"非 SCI 期刊"等否定性表述；如确需提及收录,请用中性说法(如"相关数据库收录情况以期刊官网为准")。**也不得**主动声称其为"SCI 期刊"/"SSCI 期刊"/"核心期刊"/"顶刊"（避免拔高）。`;
  }
  // PR #233 (5-23): 双收录场景 (wosLevel="SCIE, SSCI") 之前只匹配首个=SCIE, 漏掉 SSCI 标签
  //   导致 AI 误以为 SSCI 是"未明确"标签, 写出"未被 SSCI 收录". 改 matchAll 列全所有命中等级.
  const wosAllMatches = Array.from(indexStatuses.join(" ").matchAll(/\b(SCIE|SSCI|AHCI|ESCI)\b/gi));
  const wosTags = Array.from(new Set(wosAllMatches.map((m) => m[1].toUpperCase())));
  const wosTagsJoin = wosTags.join("/");
  const scieNote = wosTags.length > 0
    ? `（**关键约束**：该刊被 ${wosTagsJoin} 收录(WoS 等级官方证据)。文章正文**绝对禁止**写"未被 SCI 收录"/"未被 SSCI 收录"/"非 SCI 期刊"/"非 SSCI 期刊"/"目前没有被 SCI/SSCI 收录"等任何否定收录的句子, 也禁止写"投稿前请确认单位/学校是否认可此类期刊"这类暗示未收录的话术。${wosTags.includes("SCIE") ? "另: SCIE 是 SCI 的现行官方名称, 二者同义。" : ""}${wosTags.length > 1 ? `该刊为多重收录(${wosTagsJoin}), 文中可如实表述为"${wosTagsJoin} 双重/多重收录"。` : ""}）`
    : "";
  return `- 收录情况：${indexStatuses.join("、")}（文章中描述收录情况必须严格按此, 不得拔高）${scieNote}`;
}

/**
 * ##禁止字段## 块 —— 5-23 PR #167 的 4 字段黑名单, 改为按契约动态生成。
 *
 * 旧版是写死字符串, 录用率/审稿周期两条带着"(除非 ##已知期刊数据## 给了 X 字段)"的行内例外。
 * 那个例外就是矛盾的温床: 读到这句的 LLM 得自己去别处核对, 核对错了就编。
 * 现在: 该字段有真数据 → 这条 bullet 根本不出现(已知数据块里已经给了它); 没数据 → 才禁。
 */
function buildBlacklistBlock(forbidden: Set<JournalPromptField>): string {
  const bullets: string[] = [];
  if (forbidden.has("foundingYear")) {
    bullets.push(`- **创刊年 / founded in / 创办于**: 禁止提具体年份, 禁止"可追溯至 XXXX"、"创办于 XXXX"。若必须提及, 用"历史悠久的"或"近年新创"等模糊词`);
  }
  if (forbidden.has("country")) {
    bullets.push(`- **出版国 / 出版地 / based in / country**: 禁止具体国家名 (如"瑞士"、"美国"、"英国"). 若必须提及, 用"国际期刊"或"业内"等中性词`);
  }
  if (forbidden.has("acceptanceRate")) {
    bullets.push(`- **录用率**: 仅允许"较高 / 较低 / 适中 / 相对宽松 / 难度较大"等模糊词. **禁止具体百分比**`);
  }
  if (forbidden.has("reviewCycle")) {
    bullets.push(`- **审稿周期**: 仅允许"较快 / 较慢 / 标准 / 周期合理"等模糊词. **禁止具体周数**`);
  }
  if (forbidden.has("impactFactor")) {
    bullets.push(`- **影响因子 / IF**: 禁止出现任何 IF 数字 (本刊 DB 无 JCR 影响因子)`);
  }
  if (forbidden.has("partition") || forbidden.has("partitionNew")) {
    bullets.push(`- **分区 / Q几 / TOP**: 禁止"X区"/"中科院X区"/"JCR Qx"/"X区顶刊"等任何分区表述 (本刊 DB 无分区数据)`);
  }
  if (bullets.length === 0) return "";
  return `
##禁止字段## (BossMate database 缺失数据, 严禁虚构以下具体值)
${bullets.join("\n")}

违反任一 → validator 拦截 → 文章排除推荐池 (无效产出, 浪费 token).
`;
}

/**
 * 「数据密度与卖点兑现」块 —— **国内刊与国际刊同源生成**(7-28 阶段1-C 修的实际 bug)。
 *
 * 修前: 国内刊分支 7-28 已经改成动态的, 国际刊分支那条却还是手写死字符串
 *   "数据密度约每 200 字至少 1 个具体数字/指标(IF/两套分区/审稿周期/录用率/版面费/年发文量)"
 * —— 无论这本刊 DB 里到底有没有这些字段, 一律照点名。于是:
 *   ##未公开字段##: "录用率、审稿周期、版面费 —— 完全不要提及"
 *   密度要求:       "每 200 字至少 1 个具体数字(…审稿周期/录用率/版面费…)"
 * 同一份 prompt 里既禁又要, LLM 只能编。这就是那 4 次事故的机制。
 *
 * 修后: 点名的字段 = densityKeys(= 真有数据 ∩ 没被禁), 一个都不多点。
 * 一个硬指标都没有时(常见于国内刊/冷门刊), 改成显式的"别硬凑"指令 —— 破死循环。
 */
function buildDensityRule(p: {
  densityKeys: JournalPromptField[];
  isDomestic: boolean;
  discipline: string | null;
}): string {
  const labels = p.densityKeys.map((k) => FIELD_LABEL[k]);
  if (p.isDomestic) {
    const cnExtra = labels.length > 0
      ? `, 以及 ##已知期刊数据## 里真实有的国内字段(${labels.join("/")})`
      : "";
    return `1. 【密度—国内刊口径】把上方"国内核心刊卖点主线"的信息(身份组合/CSCD等级/学科分类/收录目录/投稿方向/适配人群)写扎实, 每 200 字有一个实打实的信息点(身份/学科/投稿方向${cnExtra}; **JCR IF/中科院分区一律不写**——本刊没有)。
2. 【卖点兑现—国内刊口径】核心卖点是权威身份, 不是 SCI 数字。开头首段用"什么级别的刊+适合谁"切入(如"评职称还差一篇北大核心? 这本${p.discipline || ""}方向的双核心刊值得看"), 严禁用 JCR IF/分区做噱头; 无据的录用率/审稿天数也不许编来当噱头。`;
  }
  if (labels.length === 0) {
    // 本刊一个硬指标都没有 —— 旧版会照样要求"每 200 字 1 个数字", 那是在逼 LLM 编。
    return `1. 【密度】本刊 ##已知期刊数据## 里**没有任何可引用的硬指标数字**(IF/分区/审稿周期/录用率/版面费全缺)。
   → **不要为了凑数据密度编任何数字**。密度靠"学科定位 / 收稿方向 / 适配人群 / 投稿门槛判断"这类真实信息点撑起来, 每 200 字给一个具体、可操作的判断即可。
2. 【卖点兑现】没有硬数据就不要在开头承诺数据型噱头(如"审稿 X 周""录用率 X%")。开头首段改用"这本刊适合谁、什么情况下值得考虑"切入, 正文逐条兑现。**严禁标题/开头承诺一个正文给不出的数字。**`;
  }
  return `1. 【密度】各分析章节必须把 ##已知期刊数据## 里的硬指标自然写进正文, 数据密度约每 200 字至少 1 个具体数字/指标(${labels.join("/")}), 少写空泛评价、多用真数字支撑。**只许点名这几项——上面没列的指标本刊没有数据, 一个字都不许提。**
2. 【卖点兑现】上述数据里的亮点(审稿快 / 分区高 / 免版面费 / 录用友好等)是本文核心卖点, 也是标题会挑来做噱头的点。开头首段必须挑最亮的 1-2 个做痛点承诺切入(如"还在为审稿半年发愁? 这本 X 周就出结果"), 正文再逐一兑现展开。**凡开头/标题承诺的数字, 正文必须出现并给出场景, 严禁承诺了不兑现(标题吹的数正文一定要有)。**`;
}

// ============ 矛盾检测 ============

export interface PromptContradiction {
  /** 冲突类型: required_forbidden = 既要求写又禁止写; known_forbidden = 既当已知数据给出又禁止写 */
  kind: "required_forbidden" | "known_forbidden" | "density_not_known";
  field: JournalPromptField;
  message: string;
}

export class PromptContradictionError extends Error {
  readonly contradictions: PromptContradiction[];
  constructor(contradictions: PromptContradiction[], stage: string) {
    super(
      `prompt 自相矛盾(${stage}): ${contradictions.map((c) => c.message).join("; ")}`,
    );
    this.name = "PromptContradictionError";
    this.contradictions = contradictions;
  }
}

/** 纯函数: 找出契约里所有"既要求又禁止"的字段。零 IO, 可直接单测。 */
export function findContradictions(c: JournalFieldContract): PromptContradiction[] {
  const forbidden = new Set(c.forbiddenKeys);
  const known = new Set(c.knownKeys);
  const out: PromptContradiction[] = [];
  for (const f of c.densityKeys) {
    if (forbidden.has(f)) {
      out.push({
        kind: "required_forbidden",
        field: f,
        message: `「${FIELD_LABEL[f]}」既被密度要求点名(必须写), 又在禁写清单里(不许写) —— LLM 的理性选择是编一个`,
      });
    } else if (!known.has(f)) {
      out.push({
        kind: "density_not_known",
        field: f,
        message: `「${FIELD_LABEL[f]}」被密度要求点名, 但不在 ##已知期刊数据## 里 —— 等于让 LLM 凭空写`,
      });
    }
  }
  for (const f of c.knownKeys) {
    if (forbidden.has(f)) {
      out.push({
        kind: "known_forbidden",
        field: f,
        message: `「${FIELD_LABEL[f]}」既出现在 ##已知期刊数据##(这是真值, 可以写), 又出现在禁写清单里`,
      });
    }
  }
  return out;
}

/** 开发/测试期抛错, 生产期记 incident + 自动修正。生产环境判据与 env.NODE_ENV 一致。 */
function shouldThrowOnContradiction(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * 断言 prompt 不自相矛盾: `densityKeys ∩ forbiddenKeys === ∅` 且 `knownKeys ∩ forbiddenKeys === ∅`。
 *
 * - **开发/测试期**: 直接抛 `PromptContradictionError` —— 把这类 bug 挡在 CI, 别再等生产里
 *   靠"待审堆积 + 人工复盘"发现第 5 次。
 * - **生产期**: 落一条 `prompt_contradiction` incident, 然后**自动修正**并继续出稿。
 *   修正策略 = 从密度要求里剔除被禁写的字段 + 从已知数据里剔除被禁写的字段, 即"禁写压过要写"。
 *   为什么不是抛错停产: prompt 有点冗余 ≠ 内容不能发, 停产的代价远大于少写一个数据点
 *   (7-27 质检超时把全线打死的教训)。为什么不是静默修正: 静默 = 又一个没人知道的补丁。
 */
export function assertNoContradiction(
  c: JournalFieldContract,
  ctx?: { stage?: string; tenantId?: string | null; journalName?: string },
): JournalFieldContract {
  const contradictions = findContradictions(c);
  if (contradictions.length === 0) return c;

  const stage = ctx?.stage ?? "unknown";
  if (shouldThrowOnContradiction()) {
    throw new PromptContradictionError(contradictions, stage);
  }

  reportPromptContradiction(contradictions, stage, ctx);

  // 自动修正: 禁写压过要写
  const forbidden = new Set(c.forbiddenKeys);
  const knownKeys = c.knownKeys.filter((k) => !forbidden.has(k));
  const dropped = c.knownKeys.filter((k) => forbidden.has(k));
  const knownIdx = new Map(c.knownKeys.map((k, i) => [k, i]));
  return {
    ...c,
    knownKeys,
    knownLines: c.knownLines.filter((_, i) => !dropped.some((d) => knownIdx.get(d) === i)),
    densityKeys: c.densityKeys.filter((k) => !forbidden.has(k) && knownKeys.includes(k)),
    suppressedKeys: [...c.suppressedKeys, ...dropped],
  };
}

/** 落 incident(旁路, 绝不抛错/绝不阻塞出稿)。动态 import 保持本模块纯净, 单测不用 mock db。 */
function reportPromptContradiction(
  contradictions: PromptContradiction[],
  stage: string,
  ctx?: { tenantId?: string | null; journalName?: string },
): void {
  void (async () => {
    try {
      const { recordIncidentThrottled } = await import("../ops/incidents.js");
      await recordIncidentThrottled({
        kind: "prompt_contradiction",
        severity: "warn",
        tenantId: ctx?.tenantId ?? null,
        message: `prompt 指令自相矛盾(${stage}): ${contradictions.map((x) => x.message).join("; ")}`.slice(0, 480),
        detail: {
          stage,
          journalName: ctx?.journalName ?? null,
          fields: contradictions.map((x) => ({ kind: x.kind, field: x.field })),
        },
      }, { key: `prompt_contradiction:${stage}` });
    } catch {
      /* 告警链路自己挂了不能反过来搞挂生成 */
    }
  })();
}
