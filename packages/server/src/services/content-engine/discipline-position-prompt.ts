/**
 * 「学科定位」体裁的 prompt（A2 第 5 步，8-10）。纯函数，无 IO。
 *
 * ## 为什么不走 content_templates 表
 *
 * ① 加一行 DB 记录 = 生产数据变更 = 事实上的上线，与「拍板前零上线」直接冲突；
 * ② `buildTemplateAwarePromptSuffix` 会捎带塞 `NUMBER_CONSTRAINT_SUFFIX`，那段专讲
 *    IF / 录用率怎么写 —— 对本体裁是纯噪声，还会**反向提示**模型这些东西可以写；
 * ③ 本体裁根本不经过 `generateJournalRecommendation`。
 *
 * ## 分块的意义不只是排版
 *
 * `sections` 被原样导出，单测据此做**位置断言**：「投稿 / 审稿 / 录用 / 影响因子 / 分区」
 * 这些词只允许出现在 `禁令` 块里。散落到别处就是在给模型反向暗示，
 * 而这正是 8-05 那 5/5 叙述型编造的来路。
 *
 * ## 数字纪律
 *
 * 事实清单是数字的**唯一**出口（见 `cohortPromptFacts`），校验器 `cohort-fact-check`
 * 从同一个函数抽白名单。所以这里反复强调的是同一件事：逐字取，不许算。
 * 派生量（占比）已由代码算好塞进清单 —— 一旦允许模型自己算 43/660，
 * 下一次它就会"算"一个没有依据的数。
 *
 * ## ⚠️ 为什么**没有**复用 `buildHookPromptBlock` 与 `buildVariation`
 *
 * 原计划要求复用这两个（红线 #11 复用>重写）。8-10 逐条读过库内容后放弃，理由是
 * 它们不是通用件，而是**为「选刊投稿决策」这个场景写的数据**：
 *
 *   8 个钩子模式无一例外绑投稿场景。「数字冲击」的结构说明原文是
 *   「开头第一句甩一个具体硬数字（IF/录用率/审稿天数/版面费）」，例句是
 *   「录用率接近 40%，IF 还在涨」；连最中性的「结果前置」例句也是
 *   「这本刊现在就值得投」—— 而本体裁禁一切评价性判断。
 *   `buildVariation` 的 HOOK_STYLES 同样含「避坑警告式：投稿前必须知道的…」。
 *
 * 把这些当**范例**塞进 prompt，等于一边禁写 IF / 录用率 / 评价，一边给模型示范怎么写。
 * 这正是 8-05 那 5/5 叙述型编造的来路，也是红线 #14 那类"看起来正常的坏产物"的源头。
 *
 * 复用的边界因此划在**逻辑**而不是**内容**上：
 *   · 轮换记账逻辑照用现成的 `usage-rotation`（同 scope 当天每模式限用 2 次）
 *   · 钩子与结构变体改用本体裁自己的一份，见 `GENRE_HOOKS` / `GENRE_STRUCTURES`
 *
 * 📌 若本体裁拍板上线，需要给飞轮（`getRecipeWeights`）加一个体裁维度，
 *   否则这套变体拿不到效果反馈。样例阶段不需要，先记在这里。
 */
import { buildClicheBanPrompt } from "../../data/ai-cliche.js";
import { buildPersonaSuffix } from "../skills/structure-variation.js";
import { exhaustedKeys, recordUsage, usageCount } from "./usage-rotation.js";
import { catalogFactBlock } from "../journals/catalog-facts.js";
import { cohortPromptFacts, usableSlices, type DisciplineCohort } from "../journals/discipline-cohort.js";
import { supplyPromptConstraints, type DataSupply } from "../journals/journal-data-supply.js";

/**
 * 输出 JSON 的字段。**刻意不复用 `AIGeneratedContent`** ——
 * 它的字段语义绑死「投稿指南」（submissionAdvice / ifPrediction / rating），
 * 把本体裁塞进去，下游的编造闸会按错误的语义去读这些字段。
 */
export interface DisciplinePositionContent {
  title: string;
  /** 开头钩子，2-3 句 */
  openingHook: string;
  /** 学科坐标主叙事 */
  positioning: string;
  /** 横向盘子的解读（只描述，不评价） */
  cohortReading: string;
  /** 同类刊清单的引言（清单本身由模板渲染，不由模型写） */
  siblingNote: string;
  /** 怎么查证。目录常量未审校时模型只能写"查官方目录"式的一般说法，不得给网址 */
  verifySteps: string;
  closing: string;
}

export const DISCIPLINE_POSITION_JSON_KEYS: Array<keyof DisciplinePositionContent> = [
  "title",
  "openingHook",
  "positioning",
  "cohortReading",
  "siblingNote",
  "verifySteps",
  "closing",
];

/** 本体裁专属禁令。与 supplyPromptConstraints 互补：那边按缺什么禁，这边按体裁禁 */
const GENRE_BANS = [
  "本文是「学科定位」体裁，全文**不得**出现：投稿指南、审稿流程、审稿周期、初审速度、录用难度、录用率、编辑部偏好或选题倾向。",
  "全文**不得**出现：影响因子 / IF、分区 / Q1 / 中科院分区、创刊年份、出版周期、国别、版面费。",
  "**不得**给出任何网址、二维码、投稿系统入口或期刊官网 —— 一个都不许，即使你认为自己知道。",
  "**不得**出现任何评价性判断（权威、顶级、优质、含金量高、认可度高、难度大）。本体裁只陈述目录事实，不做优劣评价。",
  "**不得**声称本刊在某分类中的排名、位次或地位高低 —— 目录只给出成员资格，不给出排序。",
];

/**
 * 🔴 时态纪律。快照必然会旧 —— 句式要选那种**旧了也不会变成错话**的。
 *
 *   「本刊是北大核心期刊」        现在时断言，目录一更新就变成假话
 *   「本刊入选 2023 版北大核心」  陈述历史事实，永真
 *
 * 不是文风偏好，是正确性：`findMembershipClaimViolations` 按同一条判据检查产物。
 */
const WORDING_DISCIPLINE = [
  "凡提到目录成员资格，一律写成「入选 <版本年> 版 <目录名>」，**禁止**写成「是/属于 <目录名> 期刊」。",
  "理由：目录会更新。「入选 2023 版北大核心」是历史事实，永远为真；" +
    "「是北大核心期刊」是现在时断言，下一版目录调整后就变成假话。",
  "**每一个**提到目录名的句子，都必须在同一句里带上该目录的版本年 —— 不许只在开头交代一次。",
  "同理，分类归属写「在该版目录中被划入某分类」，不写「本刊属于某学科」。",
];

const NUMBER_DISCIPLINE = [
  "文中出现的每一个数字，必须**逐字**取自上面的事实清单。",
  "**禁止**任何加减、换算、取整、估算、约数（如「N 余本」「近 N 种」「超过 N 本」）。",
  "**禁止**自行计算百分比或比例 —— 需要的占比已在清单中给出，直接引用。",
  "**禁止**给出清单中没有的年份。清单里的版本年只能用于修饰它所属的那条数据。",
  "凡是引用本数或占比的句子，必须带上目录名与版本年，格式照事实清单里的写法。",
];

/**
 * 本体裁自己的开头钩子。共同点：**不做决策建议、不出现指标**，
 * 只从「位置/坐标/清单」这个角度切入 —— 这是本体裁唯一有据可写的角度。
 */
/**
 * ⚠️ 例句里**一个数字都不许有**。示例是给模型学句式的，它会连数字一起抄 ——
 * 而「43 本」对下一本刊就是错的。凡是要出现数字的位置一律写成「N」。
 * `discipline-position-prompt.test.ts` 有断言锁这条。
 */
export const GENRE_HOOKS: Array<{ name: string; structure: string; example: string }> = [
  {
    name: "坐标开场",
    structure: "第一句直接给出本刊在目录中的位置（哪个目录、哪个分类、该分类共几本），第二句说明这个位置意味着能查到什么。",
    example: "在某目录（某版）里，这本刊被划在某分类下，同分类一共 N 本。",
  },
  {
    name: "集合视角",
    structure: "先说这一版目录整体有多大、分成多少类，再把本刊放进去定位。由大到小收拢。",
    example: "这一版目录收录 N 本，分成 M 个学科分类 —— 先看清盘子，再看这本刊落在哪一格。",
  },
  {
    name: "查证引导",
    structure: "第一句点明本文所有数字都可以对着官方目录逐条数出来，第二句给出本刊的分类位置。",
    example: "下面每一个数，你都能拿官方目录自己数一遍。先说结论：这本刊在某某分类里。",
  },
  {
    name: "同类并置",
    structure: "从「和它同一格的还有哪些刊」切入，用清单感开场，再回到本刊。",
    example: "和这本刊同属一个分类的，还有另外 N 本 —— 名单在下面，先看看你认得几本。",
  },
];

/** 本体裁的结构变体。刻意只有措辞层面的变化，不改事实与章节 */
export const GENRE_STRUCTURES: string[] = [
  "小标题用陈述句（如「它在该目录里的位置」），全文不用问句小标题。",
  "小标题用名词短语（如「分类与本数」「同类刊清单」），尽量短。",
  "不使用小标题，用自然段之间的过渡句衔接，段落略长。",
];

/** 结语落点。全部是「怎么查证 / 怎么用」，不含任何投稿建议 */
export const GENRE_CLOSINGS: string[] = [
  "结语落在「怎么自己核对这些数字」。",
  "结语落在「目录版本会更新，看数据要认版本年」。",
  "结语落在「同分类的其他刊也可以照这个方法定位」。",
];

/**
 * 按轮换记账挑一个候选：同 scope 当天每个 key 最多用 2 次。
 * 复用 `usage-rotation`，与钩子库那套是同一本账。
 */
function pickRotating<T>(items: T[], keyOf: (t: T) => string, scope: string | undefined, seedIndex: number): T {
  if (!scope) return items[seedIndex % items.length]!;
  const LIMIT = 2;
  const keys = items.map(keyOf);
  const banned = new Set(exhaustedKeys(scope, keys, LIMIT));
  const fresh = items.filter((t) => !banned.has(keyOf(t)) && usageCount(scope, keyOf(t)) < LIMIT);
  const pool = fresh.length > 0 ? fresh : items;
  const picked = pool[seedIndex % pool.length]!;
  recordUsage(scope, keyOf(picked));
  return picked;
}

export interface DisciplinePositionPromptInput {
  cohort: DisciplineCohort;
  supply: DataSupply;
  persona?: string | null;
  styleProfile?: string | null;
  /** 钩子轮换范围键（同 scope 当天每模式限用 2 次） */
  rotationScope?: string;
  /**
   * 变体选择的种子。**刻意不用 Math.random** —— 样例脚本需要「同一本刊两次生成
   * 拿到同样的结构」才能把 LLM 的随机性与变体的随机性分开看。
   * 生产可传自增序号或 journalId 的哈希。
   */
  variantSeed?: number;
}

export interface DisciplinePositionPrompt {
  system: string;
  user: string;
  /** 逐块导出，供单测做位置断言 */
  sections: Record<string, string>;
  /** 本篇实际选中的变体，落 metadata 供事后复核 */
  recipe: { hook: string; structure: string; closing: string };
}

export function buildDisciplinePositionPrompt(input: DisciplinePositionPromptInput): DisciplinePositionPrompt {
  const { cohort, supply } = input;
  const seed = input.variantSeed ?? 0;
  const hook = pickRotating(GENRE_HOOKS, (h) => h.name, input.rotationScope, seed);
  const structure = GENRE_STRUCTURES[seed % GENRE_STRUCTURES.length]!;
  const closing = GENRE_CLOSINGS[seed % GENRE_CLOSINGS.length]!;

  const facts = cohortPromptFacts(cohort);
  const catalogTags = [...usableSlices(cohort).map((s) => s.catalog), ...cohort.badges.map((b) => b.catalog)];
  const catalogBlock = catalogFactBlock(catalogTags);

  const sections: Record<string, string> = {};

  sections["本篇唯一可用事实"] =
    "以下是本篇**全部**可用的期刊事实。清单之外的任何期刊属性都不存在，不得引入：\n" +
    facts.map((f, i) => `${i + 1}. ${f}`).join("\n");

  // 未审校时 catalogBlock 为空 → 整块不出现（第 6 章自然缺席，见 catalog-facts 文件头）
  if (catalogBlock) {
    sections["目录说明(照抄不得改写)"] =
      "以下关于目录本身的说明，**只能照抄或压缩，不得改写、不得扩写、不得补充**：\n" + catalogBlock;
  }

  // 🔴「投稿/审稿/录用/影响因子/分区」这些词**只允许**出现在本块
  sections["严禁书写"] = [...supplyPromptConstraints(supply), ...GENRE_BANS].map((l) => `· ${l}`).join("\n");

  sections["数字纪律"] = NUMBER_DISCIPLINE.map((l) => `· ${l}`).join("\n");
  sections["措辞纪律"] = WORDING_DISCIPLINE.map((l) => `· ${l}`).join("\n");

  sections["写作要求"] = [
    "全文 800-1200 字。素材本就不多，**宁可短，不许灌水** —— 不许用形容词、感叹和排比撑长度。",
    "语气克制、信息密度优先。读者要的是「这本刊在目录里处在什么位置」这一件事。",
    "同类刊清单由系统渲染，你只写引出它的一两句话，**不要自己列刊名**。",
    "「怎么查证」一节只说方法（去哪类官方目录、按什么字段核对），不得给出网址或机构名称。",
    // 8-10 首轮实测 10 篇里有 2 篇直接把刊名原样返回当标题(「教育研究」4 字), 被出稿健康闸判 title_too_short。
    "标题**不得**只写刊名。必须点出本文讲的是「它在哪个目录、哪个分类、这个分类有多大」，" +
      "长度 12-30 字。只有刊名等于没写标题。",
  ]
    .map((l) => `· ${l}`)
    .join("\n");

  sections["开头钩子"] =
    `采用「${hook.name}」写开头（前两句必须完成钩子）：${hook.structure}\n` +
    `示例（只学句式，不要抄内容）：${hook.example}\n` +
    "🚫 禁止平铺直叙介绍背景，禁止「随着…的发展」式开场。";
  sections["防套话"] = buildClicheBanPrompt(20);
  sections["结构变化"] = `· ${structure}\n· ${closing}\n· 段落节奏自然变化，不要每篇同样的小标题措辞。`;

  const persona = buildPersonaSuffix(input.persona, input.styleProfile);
  if (persona) sections["账号人设"] = persona.trim();

  sections["输出 JSON"] =
    "只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码围栏。字段：\n" +
    DISCIPLINE_POSITION_JSON_KEYS.map((k) => `  "${k}": string`).join("\n");

  const user = Object.entries(sections)
    .map(([k, v]) => `##${k}##\n${v}`)
    .join("\n\n");

  const system =
    "你是学术期刊领域的资料编辑。你的职责是把**给定的目录事实**组织成通顺的中文短文，" +
    "而不是补充你所知道的期刊背景知识。" +
    "你对这本期刊的全部了解，仅限于用户消息中「本篇唯一可用事实」一节列出的内容 —— " +
    "任何超出该清单的期刊属性，无论你多有把握，都视为不存在。" +
    "宁可少写一段，也不要写一句无据的话。";

  return { system, user, sections, recipe: { hook: hook.name, structure, closing } };
}
