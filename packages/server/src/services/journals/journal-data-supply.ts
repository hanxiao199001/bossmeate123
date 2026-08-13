/**
 * 「这本刊的数据够写什么体裁」—— 数据供给分级，单一真相源（8-06）。
 *
 * ## 为什么需要这个文件
 *
 * 8-05 编造排查取样 5 篇「DB 里没有 IF」的内容，**5/5 全部出现叙述型编造**：
 *   「审稿流程严谨」「实证研究稿件更受青睐」「初审反馈较快」「优先公共馆或高校馆的实证研究」
 * 这些断言 DB 里**一个字都没有**（`review_cycle` / `acceptance_rate` 全 NULL）。
 *
 * 病根不是闸判错，是**任务本身无解**：模板固定要写"投稿指南"，而这本刊除了名字和目录
 * 什么都没有。要求 LLM 写一篇它没有素材的稿子，它只能编 —— 加闸只能让它闭嘴，不能让它有话说。
 *
 * 所以体裁应当**由数据供给决定**，而不是由模板决定。这个文件回答"供给到什么程度"，
 * 体裁路由据此选题材。
 *
 * ## 实测规模（近 14 天 587 篇，8-06）
 *
 *   sparse 57.6% ｜ medium 26.1% ｜ rich 10.9% ｜ 无关联刊 5.5%
 *
 * 也就是说**只有约一成内容真有素材写投稿指南**。这个数字是本文件存在的全部理由 ——
 * 改判据救不了它，只能换体裁。
 *
 * ## ⚠️ 判据依据与前提（照 intl-signal.ts 的规矩：判据必须有出处）
 *
 * 1. **"字段有没有"一律走 `fabrication-criteria.ts` 的 `hasDbFact`**，不在这里另发明一套。
 *    这个项目已经因为判据分叉栽过多次（见 intl-signal.ts 文件头列的两次）。
 *
 * 2. **`hasDbFact` 的语义是 `!== null && !== undefined` —— 空串算"有数据"**。
 *    本文件依赖一个**当前成立、但需要保持**的前提：`journals` 表里这些列**没有空串**。
 *    8-06 实测：`partition / cas_partition / cas_partition_new / review_cycle` 空串行 = **0**。
 *    ⚠️ 如果哪天写入侧又写回空串，分级会把"抓取失败留下的空壳"误判成 rich/medium，
 *      于是又开始给没数据的刊派"投稿指南"。防线在写入侧（归一化 + DB 约束），不在这里 ——
 *      不要为了兜空串去改 hasDbFact 的判据，那会让发布闸的口径跟着变（见该文件长注释）。
 *
 * 3. **指标列取哪些**：IF 取 `impactFactor` ∪ `compositeImpactFactor`（国内刊只有复合影响因子），
 *    分区取 `partition` ∪ `casPartitionNew`。**刻意不取 `casPartition`** —— 该列实测整列为空
 *    （0 行），把它算进来等于凭空多一个永远不成立的信号（intl-signal.ts 记过这个坑）。
 *
 * 4. **流程类字段**（`reviewCycle` / `acceptanceRate`）是"能不能写投稿指南"的**决定性字段**：
 *    5/5 编造样本编的全是这一类。没有它们就一律不许写审稿流程 —— 见 supplyPromptConstraints()。
 */
import { hasDbFact } from "../compliance/fabrication-criteria.js";

/** 分级结果。sparse 最常见（约六成），不是异常情况。 */
export type DataSupplyLevel = "rich" | "medium" | "sparse";

/** 分级只读这些字段 —— 与 journals 表列名对齐，调用方直接传行即可 */
export interface JournalSupplyInput {
  impactFactor?: unknown;
  compositeImpactFactor?: unknown;
  partition?: unknown;
  casPartitionNew?: unknown;
  reviewCycle?: unknown;
  acceptanceRate?: unknown;
  catalogs?: unknown;
  cscdLevel?: unknown;
  pkuCoreLevel?: unknown;
  disciplineCode?: unknown;
  publisher?: unknown;
}

export interface DataSupply {
  level: DataSupplyLevel;
  /** 有哪些类别的事实（供 prompt 渲染与事实密度统计复用，别在别处重算） */
  has: {
    impactFactor: boolean;
    partition: boolean;
    /** 审稿周期 / 录用率 —— 决定能不能写投稿流程 */
    submissionFlow: boolean;
    /** 目录成员资格（CSSCI / 北大核心 / CSCD…） */
    catalog: boolean;
    discipline: boolean;
    publisher: boolean;
  };
  /** 人话解释，落 metadata 供排查（"为什么这篇被判 sparse"） */
  reason: string;
}

/** 目录成员资格：catalogs 数组非空，或 cscd/北大核心层级字段有值 */
function hasCatalogMembership(j: JournalSupplyInput): boolean {
  if (Array.isArray(j.catalogs) && j.catalogs.length > 0) return true;
  return hasDbFact(j.cscdLevel) || hasDbFact(j.pkuCoreLevel);
}

/**
 * 纯函数：这本刊的数据够写什么。无 IO，直接单测。
 *
 * rich   = 有指标(IF 或分区) **且** 有流程数据(审稿周期/录用率) → 投稿指南这类什么都能写
 * medium = 有指标, 但没有流程数据                              → 指标照写, 流程板块整块不出现
 * sparse = 连指标都没有, 只剩刊名/目录/学科                     → 换体裁, 写不依赖指标的题材
 *
 * ⚠️ 判据只在这里定义一次。别在调用方写 `if (j.impactFactor)` 之类的旁路 ——
 *   扫描守卫 journal-data-supply-guard.test.ts 会拦。
 */
export function classifyDataSupply(j: JournalSupplyInput | null | undefined): DataSupply {
  const has = {
    impactFactor: !!j && (hasDbFact(j.impactFactor) || hasDbFact(j.compositeImpactFactor)),
    partition: !!j && (hasDbFact(j.partition) || hasDbFact(j.casPartitionNew)),
    submissionFlow: !!j && (hasDbFact(j.reviewCycle) || hasDbFact(j.acceptanceRate)),
    catalog: !!j && hasCatalogMembership(j),
    discipline: !!j && hasDbFact(j.disciplineCode),
    publisher: !!j && hasDbFact(j.publisher),
  };
  const hasMetric = has.impactFactor || has.partition;

  if (hasMetric && has.submissionFlow) {
    return { level: "rich", has, reason: "有指标(IF/分区) + 有流程数据(审稿周期/录用率)" };
  }
  if (hasMetric) {
    return { level: "medium", has, reason: "有指标但无审稿周期/录用率 —— 流程类板块不得出现" };
  }
  return {
    level: "sparse",
    has,
    reason: j
      ? "无 IF 无分区 —— 只能写不依赖指标的体裁(学科定位/目录地位/选题方向)"
      : "没有关联期刊 —— 无任何期刊事实可用",
  };
}

/**
 * 「这本刊一条指标事实都没有」—— 即 sparse 那条线的判据本身。
 *
 * 存在的理由只有一个：**判据不许在调用方重写**。
 * `checkOutputHealth({ noMetricFacts })`、A2 体裁的准入、模板的槽位裁剪都要问这句话，
 * 各自写 `!s.has.impactFactor && !s.has.partition` 就是三份会各自漂移的判据 ——
 * 而且会当场踩中扫描守卫（`journal-data-supply.test.ts` 那条禁布尔组合的规则）。
 *
 * 注意它**不等价于** `level === "sparse"` 的字面判断，尽管当前二者同值：
 * 语义上这里问的是"有没有指标"，而 level 还承载着流程数据那一维。
 * 将来若加入第四档，这个函数仍然只答指标那一问。
 */
export function hasNoMetricFacts(s: DataSupply): boolean {
  return !s.has.impactFactor && !s.has.partition;
}

/**
 * 按供给等级产出 **prompt 禁令**（治叙述型编造）。
 *
 * 为什么禁令要在这里而不是各 prompt 里手写: 8-05 排查发现同一件事在
 * title-generator / topic-skill / roundup-generator / format-generators / article-skill
 * 五处各写各的，其中三处压根没有反编造文案。判据分叉过一次就会分叉第二次。
 *
 * ⚠️ 措辞刻意针对**叙述型断言**而不只是数字：
 *   数值型编造已有四道闸管着（8-05 取样 0/5 证明有效），叙述型是全裸的 ——
 *   "审稿流程严谨"里没有一个数字，任何数值校验都抓不到。
 */
export function supplyPromptConstraints(s: DataSupply): string[] {
  const out: string[] = [];
  if (!s.has.impactFactor) {
    out.push("本刊无影响因子数据。严禁书写任何 IF / 影响因子数值，也不得用「影响因子较高」「IF 可观」等形容替代。");
  }
  if (!s.has.partition) {
    out.push("本刊无分区数据。严禁书写「X 区」「QX」「中科院 X 区」「TOP 期刊」等分区表述。");
  }
  if (!s.has.submissionFlow) {
    out.push(
      "本刊无审稿周期、录用率数据。严禁书写任何关于审稿流程、初审速度、录用难度、" +
      "编辑部偏好的表述（例如「审稿流程严谨」「初审反馈较快」「实证研究稿件更受青睐」" +
      "「优先某类选题」）—— 这些都属于无据编造，即使听起来像常识也不许写。",
    );
  }
  if (s.level === "sparse") {
    out.push(
      "本刊仅有刊名、主办方、所属目录与学科信息。全文只能基于这些**已给出的事实**展开，" +
      "不得引入任何未在数据块中出现的期刊属性。",
    );
  }
  return out;
}

/** 落 metadata 的精简形态（排查时能一眼看出"这篇当时被判成什么") */
export function supplyMetadata(s: DataSupply): Record<string, unknown> {
  return { dataSupply: s.level, dataSupplyReason: s.reason, dataSupplyHas: s.has };
}
