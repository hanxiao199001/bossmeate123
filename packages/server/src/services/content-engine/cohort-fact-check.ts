/**
 * 「学科定位」体裁的数字校验（A2 第 5 步，8-10）。
 *
 * ## 与现有编造闸的分工
 *
 * `findBodyFabrication` 问的是「正文写了 IF / 分区，而 DB 没有」—— 它按**字段**查。
 * 本体裁的正文里根本不该出现 IF 和分区，那道闸依然管用，但它管不到本体裁的主要风险：
 *
 *   把「CSSCI 教育学 43 本」写成「教育学核心期刊 430 余种」；
 *   把横向盘子里别的分类的数安到本刊头上；
 *   顺手补一个「创刊于 1985 年」（DB 里创刊年 0/154 有值）。
 *
 * 这些都是**数量断言**，字段级的闸看不见。所以这里换一种问法：
 * **正文里每一个数量断言，都必须逐字出现在事实清单里。** 白名单闭集，宁可误伤不许漏。
 *
 * ## 白名单与事实清单同源
 *
 * 白名单不是另写一份常量，而是直接从 `cohortPromptFacts(cohort)` 的输出里抽数字 ——
 * 也就是**喂给 LLM 的那份清单本身**。两边同源意味着：想让 LLM 能写某个数，
 * 只能去 `cohortPromptFacts` 加一行；不可能出现"prompt 给了但校验不认"的自相矛盾。
 * （这个项目已经因为判据分叉栽过多次，见 intl-signal.ts / fact-density.ts 文件头。）
 *
 * ## 只查「数量断言」，不查所有数字
 *
 * 全量查数字会把「三个步骤」「第 2 点」这类行文数字全部误报，
 * 而误报多了人就不看告警了（8-08 扫描守卫三次收窄的教训）。
 * 所以只认这几种形态：
 *   · 数字 + 量词（本 / 种 / 份 / 篇 / 家）—— 期刊计数
 *   · 百分比
 *   · 四位数 + 年 —— 创刊年/版本年，本体裁除目录版本年外一律不许出现
 *   · 「共 N」「收录 N」「排名第 N」
 * 「3 个步骤」的量词是「个」，不在表内 → 不误报。
 */
import type { DisciplineCohort } from "../../services/journals/discipline-cohort.js";
import { cohortPromptFacts } from "../../services/journals/discipline-cohort.js";
import { allowedUrls } from "../../services/journals/catalog-facts.js";

export interface CohortNumberViolation {
  kind:
    | "number_not_in_facts"
    | "approximation_not_allowed"
    | "url_not_allowed"
    | "membership_not_time_anchored"
    | "ranking_not_allowed";
  /** 命中的原文片段 */
  matched: string;
  /** 整句原文，便于人工复核 */
  sentence: string;
}

/** 期刊计数的量词。刻意**不含「个」** —— 「3 个步骤」是行文，不是数量断言 */
const COUNT_UNITS = "本|种|份|篇|家";

/**
 * 约数措辞。**与白名单无关，出现即违规** ——
 * 「近 43 本」里的 43 虽在白名单里，但目录给的是精确值，加个「近」就把可查证的数
 * 变成了不可查证的估计。8-10 单测撞出来的：原先只按数字查，「40 余本」因为
 * 「余」夹在数字与量词之间，两条正则都不命中，直接漏网。
 */
const APPROX_RE = /(?:近|约|大约|将近|超过|逾|不足|至少|多达)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:余|多|来)\s*(?:本|种|份|篇|家)/g;

const PATTERNS: RegExp[] = [
  // 量词前允许夹约数字（40 余本 / 700 多种）—— 否则整类估算表述从缝里漏过去
  new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:余|多|几|来)?\\s*(?:${COUNT_UNITS})`, "g"),
  /\d+(?:\.\d+)?\s*[%％]/g,
  /\d{4}\s*年/g,
  /(?:共|收录|合计|总计)\s*\d+(?:\.\d+)?/g,
  /(?:排名|位列|名列)\s*第?\s*\d+/g,
];

/**
 * 版本年锚点。⚠️ 必须认「2023年版」——8-10 实测模型爱写
 * 「《中文核心期刊要目总览》（2023年版）」，第一版正则只认「2023 版」把它误判成违规。
 */
const VERSION_YEAR = /\d{4}(?:\s*[-—]\s*\d{4})?\s*年?\s*版|版本年|该版|本版/;

/**
 * 成员资格**断言**。三次收窄的结果，每一次都是被实测的假阳性逼出来的：
 *
 *   v1「句子里提到目录名就要求带版本年」→ 10 篇报 35 条，**零真阳性**，
 *      全是「北大核心目录只给出成员资格，不提供排序」这类讲目录本身的句子。
 *   v2「判断动词 + 目录名」→ 又报 2 条假阳性：
 *        「无论从 CSSCI 还**是**北大核心的学科标签来看」——「还是」的是是连词
 *        「『高校学报』则**是** CSSCI 目录中特有的分类」——主语是分类不是本刊
 *   v3（当前）要求命题真的在说**本刊的成员资格**，二选一即可：
 *        ① 有指向本刊的主语（本刊/该刊/它/《刊名》）+ 判断动词 + 目录名
 *        ② 目录名后面紧跟「期刊/来源期刊/收录期刊」这个名词
 *
 * 📌 截至 8-11，这道闸在约 30 篇实测产物上累计报出 37 条，**真阳性 0 条**。
 *   prompt 侧的措辞纪律一直有效（模型稳定写「入选 X 版目录」）。
 *   保留它是为了防回归，不是因为它在抓活的问题 —— 若再出现假阳性，
 *   应当考虑降级为「只记录不计入违规数」，而不是继续加特例。
 */
const CATALOGS = "CSSCI\\s*扩展版?|CSSCI|北大核心|中文核心|中文社会科学引文索引|CSCD|SCI\\s*核心";
/** ① 主语指向本刊 */
const MEMBERSHIP_SUBJ = new RegExp(
  `(?:本刊|该刊|它|《[^》]{1,40}》)[^。！？；]{0,15}(?:是|为|属于|跻身|入列)[^。！？；]{0,10}(?:${CATALOGS})`,
  "g",
);
/** ② 目录名 + 「期刊」这个名词 —— 「是 CSSCI 来源期刊」这种即使省略主语也是成员资格断言 */
const MEMBERSHIP_NOUN = new RegExp(
  `(?:是|为|属于|跻身|入列|作为)\\s*(?:一本\\s*)?(?:${CATALOGS})[^。！？；]{0,4}(?:来源期刊|收录期刊|期刊)`,
  "g",
);

/**
 * 排名断言。本体裁**禁一切排名**——目录只给出成员资格，不给出排序。
 * 8-10 实测漏网：「收录本数位列第三」用的是中文数字，而数字闸只认阿拉伯数字。
 * 要求后面跟数词，所以「位列其中」这类不误报。
 */
const RANKING_CLAIM = /(?:排名|位列|名列|居|排在)\s*第?\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:位|名|)/g;

/**
 * 「是北大核心期刊」vs「入选 2023 版北大核心」。
 *
 * 前者是**现在时断言**，目录一更新就变成假话；后者陈述历史事实，永真。
 * 快照必然会旧 —— 所以句式要选那种旧了也不会变成错话的。这不是文风偏好，是正确性。
 *
 * 判据落在可检验处：**任何提到目录名的句子，必须在同一句里锚定版本年**。
 * 模板渲染的部分每处都带版本年，风险全在模型写的叙述里 —— 所以这条跑在叙述文本上。
 */
export function findMembershipClaimViolations(text: string | null | undefined): CohortNumberViolation[] {
  if (!text) return [];
  const out: CohortNumberViolation[] = [];
  for (const sentence of sentencesOf(toPlain(text))) {
    // ① 成员资格断言未锚定版本年 —— 目录一更新就变假话
    if (!VERSION_YEAR.test(sentence)) {
      const m =
        sentence.match(new RegExp(MEMBERSHIP_SUBJ.source, "g")) ??
        sentence.match(new RegExp(MEMBERSHIP_NOUN.source, "g"));
      if (m) out.push({ kind: "membership_not_time_anchored", matched: m[0], sentence });
    }
    // ② 排名断言 —— 无论有没有版本年，本体裁一律不许
    for (const r of sentence.matchAll(new RegExp(RANKING_CLAIM.source, RANKING_CLAIM.flags))) {
      out.push({ kind: "ranking_not_allowed", matched: r[0], sentence });
    }
  }
  return out;
}

/** 剥标签取纯文本。与 findBodyFabrication 同款（先剥 SVG，图表里的数字不算行文） */
function toPlain(body: string): string {
  return body.replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ");
}

/** 抽出一段文字里的全部数字串（含小数） */
function numbersIn(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

/**
 * 白名单 = 事实清单里出现的全部数字。
 * ⚠️ 唯一来源就是 `cohortPromptFacts` —— 不要在这里补充"常见的合理数字"。
 */
export function cohortNumberWhitelist(cohort: DisciplineCohort): Set<string> {
  const set = new Set<string>();
  for (const line of cohortPromptFacts(cohort)) {
    for (const n of numbersIn(line)) set.add(n);
  }
  return set;
}

function sentencesOf(plain: string): string[] {
  return plain
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 找出正文里所有**不在事实清单中**的数量断言与网址。
 * 返回空数组 = 这篇的每个数都能在官方目录里查到。
 */
export function findCohortNumberViolations(
  body: string | null | undefined,
  cohort: DisciplineCohort,
): CohortNumberViolation[] {
  if (!body) return [];
  const plain = toPlain(body);
  const white = cohortNumberWhitelist(cohort);
  const out: CohortNumberViolation[] = [];
  const seen = new Set<string>();

  for (const sentence of sentencesOf(plain)) {
    // 约数：先判，且不看白名单
    for (const m of sentence.matchAll(new RegExp(APPROX_RE.source, APPROX_RE.flags))) {
      const key = `approx@@${m[0]}@@${sentence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "approximation_not_allowed", matched: m[0], sentence });
    }
    for (const re of PATTERNS) {
      for (const m of sentence.matchAll(new RegExp(re.source, re.flags))) {
        const matched = m[0];
        // 一个断言里可能有多个数字（如 "2023-2024 年"），逐个查
        const bad = numbersIn(matched).filter((n) => !white.has(n));
        if (bad.length === 0) continue;
        const key = `${matched}@@${sentence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: "number_not_in_facts", matched, sentence });
      }
    }

    // 网址：只有审校过的查证入口才允许（当前白名单为空 = 一个都不许出现）
    const allowed = allowedUrls();
    for (const m of sentence.matchAll(/(?:https?:\/\/|www\.)[^\s，。）)"'<]+/g)) {
      if (allowed.some((u) => m[0].startsWith(u))) continue;
      out.push({ kind: "url_not_allowed", matched: m[0], sentence });
    }
  }
  return out;
}
