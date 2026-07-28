/**
 * 反编造判据 —— **共享判据 + 四道闸的适用范围总纲** (7-28, 阶段 1-A #6)。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 一、为什么这里放的是"共享件 + 总纲"而不是"合并成一个函数"
 * ══════════════════════════════════════════════════════════════════════════
 * 审计说"反编造判据分叉成 4 套"。查完代码, 结论是**这 4 套不该合并** —— 它们回答的是
 * 四个不同的问题, 合并会把其中三个问的问题弄丢:
 *
 *   ① 读取侧「DB 为空即编造」   —— "这个数字有源吗?"
 *   ② 读取侧「与 DB 不符」      —— "这个数字对吗?"
 *   ④ 写入侧「值本身不合理」    —— "这个数字能进库吗?"
 *   ⑤ 源头侧「这本刊可信吗」    —— "这个数字的来源刊本身核实过吗?"
 *
 * 真正的病不是"有四套", 是**四套各自复制了同一批底层判据**(三条正则、字段名清单、
 * "值为空"的定义), 复制出来的版本还互相不一致(见下面二.3 的 truthiness 陷阱)。
 * 所以本文件的职责是: **把可共享的底层判据收成唯一一份**, 让四道闸调用同一份;
 * 四道闸自身的语义各留各的位置, 由本注释说清各管什么、在哪生效、为什么不能互相替代。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 二、四道判据总纲
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ┌─ ① 读取侧 · 无源即编造 ──────────────────────────────────────────────┐
 * │ 位置   `services/compliance/content-check.ts`                            │
 * │        checkTitleDataConsistency / findBodyFabrication /                 │
 * │        findBodyFabricationMulti / checkRoundupFabrication /              │
 * │        checkBodyFabricationForPublish / fabricationPublishGate           │
 * │ 判据   DB 该字段**为空** = 该刊客观没有这个指标 = 文里出现的数字必然无源。│
 * │        用"键是否存在"决定要不要查(调用方没提供该字段就跳过, 不臆断);      │
 * │        用 hasDbFact() 判"值是不是空"(见下)。                             │
 * │ 生效   生成期(batch-worker / daily-cron / roundup) + 发布期              │
 * │        (draft-distributor 硬闸 / publishToAccounts 硬闸)。               │
 * │ 为什么不能被②替代: 国内刊 DB 里 IF/分区**本来就是空的**(2746 本国内核心刊 │
 * │        有 IF 的 213 本 = 7.8%), ② 的容差比对在"DB 无值"时根本无从比起,     │
 * │        而这恰恰是国内刊编造的**唯一形态**, 也是量最大的一类。              │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ② 读取侧 · 与 DB 不符(容差比对) ────────────────────────────────────┐
 * │ 位置   `services/skills/ai-content-validator.ts`                         │
 * │        extractClaimedFacts + verifyClaimsAgainstDb                       │
 * │ 判据   DB **有值**时, 把正文里说的数字与 DB 比: IF ±0.3 / 录用率 ±0.05 /  │
 * │        审稿周期字符串互含 / 版面费·创刊年全等 / 出版国互含。               │
 * │ 生效   仅生成期, 且仅 ArticleSkill 一条链路(article-skill.ts:1174)。       │
 * │        产出 severity=warning 的 ValidationIssue → 落 metadata.warnings,   │
 * │        推荐池 feed 过滤 hasWarnings 不展示。**不拦发布**。                 │
 * │ 结论   仍在被调用, 仍有独立价值, 保留。它管的是 ① 管不到的那一半:         │
 * │        DB 有 IF=2.6 而正文写 IF 14.7 —— 在 ① 眼里"DB 有值"就是有源, 放行。 │
 * │ 为什么不能被①替代: 见上。两者的定义域**互补**(① 管 DB 空, ② 管 DB 非空)。 │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ③ 评分侧 · 编造压分(不是第三套判据) ────────────────────────────────┐
 * │ 位置   `services/content-engine/quality-check-v2.ts` sixDimQualityCheck  │
 * │ 关系   它**调用 ① 的 findBodyFabrication**(通过 journalFacts 入参),        │
 * │        把命中结果换算成 dataAccuracy 的红线分。所以它不是独立判据,        │
 * │        是 ① 的**消费方**。列为"第三套"是审计的口径误差。                   │
 * │ 生效   评分, **不拦截**。理由: 评分器有降级路径(LLM 挂 → degraded), 让它   │
 * │        兼任拦截会把"评分器挂了"变成"内容有问题"(7-27 零产出事故的病根)。   │
 * │        拦截由 ① 在发布期的硬闸做 —— 那道闸零 LLM、零降级、只读 DB。        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ④ 写入侧 · 值本身不合理 ────────────────────────────────────────────┐
 * │ 位置   `services/crawler/trusted-facts-validator.ts` validateTrustedFacts│
 * │ 判据   不看 DB、不看文章, 只看**这个值本身像不像真的**:                    │
 * │        IF ∈ (0, 300) 且非年份型整数 / 分区格式 / 录用率 0-1 /             │
 * │        审稿周期能折算成 (0,1000) 天 / 导航文案特征(looksLikeNavText)。     │
 * │ 生效   enrichment 回写 journals 表**之前**。任一字段不合理 → 整条拒写。    │
 * │ 为什么必须独立存在: ①②⑤ **全部以 DB 为唯一真相源**。一旦脏值入库,        │
 * │        它们不但失效, 还会反过来给假数据背书(7-25「2026 逆天影响因子」事故: │
 * │        LetPub 改版 → 抓到年份 2026 当 IF → 回写 → 三道闸一致地信了它)。    │
 * │        ④ 是唯一一道**不依赖 DB** 的闸, 它守的是 DB 本身。                  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ ⑤ 源头侧 · 这本刊可信吗 ────────────────────────────────────────────┐
 * │ 位置   `services/journals/verification.ts` isVerifiedJournal /           │
 * │        isUnverifiedJournal(7-28 起是**分体系**门槛:                       │
 * │        国内刊看目录成员资格, 国际刊看 confidence>=70)                     │
 * │ 判据   不看数字对不对, 看**这本刊的记录本身核实过没有**。                  │
 * │        `dataSource='ai_fabricated'`(LLM 编出来的影子刊)在两个体系里都判未  │
 * │        核实 —— 它的 CN 刊号和主办方也是编的。                             │
 * │ 生效   生成期 batch-worker(标 needs_review/unverified_source_journal)、    │
 * │        客服播报护栏 kf-responder、选刊器 SQL 侧 verifiedJournalCondition。 │
 * │        7-28 补: 发布期 draft-distributor 也读了(见下方"缺口"一节)。        │
 * │ 为什么不能被①②④替代: 它们校的都是**数字**。一篇讲影子刊的文章可以每个     │
 * │        数字都"有源"(源就是那条假记录), 三道闸全绿, 而整本刊不存在。        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三、本文件提供的共享件(四道闸都从这里拿, 不许再复制)
 * ══════════════════════════════════════════════════════════════════════════
 * 3.1 三条声明正则  —— ①(标题四维/正文两维)与 ③ 共用同一份。
 * 3.2 字段名清单    —— "哪些列算 IF 证据 / 哪些列算分区证据"曾在 content-check.ts
 *                      里手抄 5 遍(findBodyFabrication ×2 / checkTitleDataConsistency ×2 /
 *                      mergeJournalFacts ×1), 加一列就要改 5 处。
 * 3.3 「值为空」判定 —— **这一条是本次收口的重点**, 详见 hasDbFact 的注释:
 *                      同一个文件里曾有三套写法(`== null` / truthiness `||` /
 *                      `!== ""`), 对同一行数据给出不同答案。
 */

import { INTL_SIGNAL_FIELDS, type IntlSignalField } from "../journals/intl-signal.js";

// ══════════════════════════════════════════════════════════════════════════
// 3.1 声明正则(唯一定义处)
// ══════════════════════════════════════════════════════════════════════════
//
// ⚠️ 这四条都带 /g。JS 里带 g 的正则**有状态**(lastIndex):
//    · `str.match(re)` 与 `str.matchAll(re)` 安全(前者内部重置 lastIndex, 后者用克隆);
//    · `re.test(str)` **不安全**(会推进 lastIndex, 下次调用从中间开始)。
//    现有调用方全部走 match/matchAll。新加调用方若要用 test(), 必须先 `re.lastIndex = 0`
//    或自己 new RegExp(re.source, re.flags)。

/**
 * 标题里的"审稿周期 / 录用率"具体数字。
 * 例: "审稿60天" / "外审仅3周" / "录用率35%" / "命中率约 40%"
 */

export const TITLE_DATA_CLAIM = /(?:审稿|外审|见刊|接收|录用率|命中率)[约仅低于\s]*\d+(?:\.\d+)?\s*(?:天|周|个月|月|%)/g;

/**
 * 影响因子声明。例: "IF 2.0+" / "影响因子 3.5" / "IF：2.3" / "impact factor 4.1"
 *
 * ⚠️ 与 ai-content-validator 的 IF 正则**刻意不共用**: 那一条要 capture 出数值做容差比对,
 *    且经 PR#171 调精度(排除 "Q1" / "近10年" / SVG 坐标 等假阳性), 契约不同 ——
 *    这一条只需回答"出现了没有", 宽一点是对的(宁可多查一个候选, 由 DB 有无来定性)。
 *    共用会把两边的调参耦死。字段名清单和"值为空"判定是共用的(那两样两边语义完全相同)。
 */
export const TITLE_IF_CLAIM = /(?:IF|影响因子|impact\s*factor)\s*[:：]?\s*[约仅低于＜<]?\s*\d+(?:\.\d+)?\s*\+?/gi;

/** 分区声明。例: "中科院1区" / "JCR Q2" / "Q1" / "一区" / "3区" */
export const TITLE_PARTITION_CLAIM = /(?:中科院\s*|JCR\s*)?(?:Q\s*[1-4]|[1-4一二三四]\s*区)/gi;

// ══════════════════════════════════════════════════════════════════════════
// 3.2 字段名清单(唯一定义处)
// ══════════════════════════════════════════════════════════════════════════

/** 算"有影响因子证据"的列。任一非空 = 该刊有 IF, 文里的 IF 数字视为有源。 */
export const IF_FACT_KEYS = ["impactFactor", "compositeImpactFactor"] as const;

/**
 * 算"有分区证据"的列 —— **从 `journals/intl-signal.ts` 的列清单派生**, 不在这里另立一份。
 *
 * ⚠️ 实测(7-20)真正有数据的是 casPartitionNew(2203 本)与 jcrFull(4229 本);
 *    partition 仅 40 本、casPartition **整列为空(0 行)** —— 只查前两者会把大量国际刊误判编造。
 *    这个坑 7-28 在 journal-kind.ts 的 hasIntlSignal 上又踩了一次(它挑的三列里有一列恒为空),
 *    所以 7-29 把"哪些列承载国际指标证据"钉死在 intl-signal.ts, 各判据只许从那份清单取子集。
 *
 * 本判据取的是**分区那一支**: 比 intl-signal 的全集少一个 impactFactor —— IF 归 IF_FACT_KEYS
 * 单独管(标题里"IF 7.4"和"1区"是两种承诺, 证据来源也不同), 不是漏。
 */
export const PARTITION_FACT_KEYS = INTL_SIGNAL_FIELDS.filter(
  (k): k is Exclude<IntlSignalField, "impactFactor"> => k !== "impactFactor",
);

/** 标题四维校验会读到的全部列(= IF + 分区 + 审稿周期 + 录用率), 供多刊并集等场景遍历。 */
export const ALL_FACT_KEYS = [
  "reviewCycle", "acceptanceRate", ...IF_FACT_KEYS, ...PARTITION_FACT_KEYS,
] as const;

// ══════════════════════════════════════════════════════════════════════════
// 3.3 「值为空」/「字段是否提供」判定(唯一定义处)
// ══════════════════════════════════════════════════════════════════════════

/**
 * **DB 里有没有这个事实** —— 判据 ①②⑤ 的读取侧统一用这一条。
 *
 * ## 为什么要单拎出来: 同一个文件里曾有三套互不相同的写法
 * `content-check.ts` 里(收口前):
 *   · L149  `db.impactFactor == null && db.compositeImpactFactor == null`   ← 严谨
 *   · L154  `!(db.partition || db.casPartition || db.casPartitionNew || db.jcrFull)` ← truthiness 陷阱
 *   · L194  `v !== null && v !== undefined && v !== ""`(mergeJournalFacts)  ← 第三套
 * `ai-content-validator.ts` 里:
 *   · L735  `dbValue == null || dbValue === ""`                              ← 第四套
 *
 * 三/四套对同一行数据会给出**不同答案**:
 *   · `partition = ""`      → L149 口径判"有", L154/L194 判"无"
 *   · `impactFactor = 0`    → L149 判"有", 若照 L154 的 truthiness 写就判"无"
 * 而这个答案直接决定"发不发得出去"。判据分叉在这种地方就是随机拦人。
 *
 * ## 统一到 `== null` 口径(只有 null/undefined 算没有)
 * 理由:
 *   ① **数字侧必须这么判**。`impactFactor = 0` / `acceptanceRate = 0` 是真值不是空值,
 *      truthiness 会把它们判成"DB 无数据" → 正文写任何 IF 都算编造 → 误挡有据内容。
 *      而"误挡有据内容"正是 6577b9a 被回滚的原因, 代价已实测。
 *   ② **空串是数据质量问题, 不该由发布闸来兜**。`partition = ''` 说明写入侧漏了归一化
 *      (该写 NULL 写成了空串)。让发布闸去猜"空串大概是没有吧", 等于把脏数据的成本转嫁给
 *      内容产出, 而且这个猜测永远不会被人发现和修正。正确的修法是把空串洗成 NULL +
 *      加 DB 约束(阶段 3 的活儿), 判据这一侧保持简单可预测。
 *   ③ 与本项目一贯的"宁可漏, 不可误伤"一致(trusted-facts-validator 文件头铁律②)。
 *
 * ⚠️ 已知代价 + 交接项: 若 journals 表里确实存在 `partition = ''` / `review_cycle = ''`
 *    的行, 这类刊的编造检测会静默放行。**上线前跑一次**:
 *      SELECT count(*) FROM journals WHERE partition='' OR cas_partition=''
 *             OR cas_partition_new='' OR review_cycle='';
 *    非 0 就洗成 NULL(而不是回头改这个判据 —— 判据只该有一个口径)。
 */
export function hasDbFact(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/**
 * **上游给没给这个字段** —— 判据 ④(写入侧/抓取侧)用这一条。
 *
 * 与 hasDbFact 语义**不同, 刻意不合并**: 这里问的是"这次抓取有没有解析出这一格",
 * 而抓取失败的典型表现就是给回空串(选择器命中了空节点)。空串在这一侧必须算"没抓到",
 * 否则会拿空串去跑格式校验、报一堆无意义的 bad_format。
 */
export function wasProvided(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

/** 调用方**提供了**这些键中的任意一个(键存在即可, 值可以是 null)。 */
export function providesAnyKey(obj: object | null | undefined, keys: readonly string[]): boolean {
  if (!obj) return false;
  return keys.some((k) => k in obj);
}

/** 这些键里**至少有一个有值**(用 hasDbFact 口径)。 */
export function hasAnyFact(obj: object | null | undefined, keys: readonly string[]): boolean {
  if (!obj) return false;
  const rec = obj as Record<string, unknown>;
  return keys.some((k) => hasDbFact(rec[k]));
}
