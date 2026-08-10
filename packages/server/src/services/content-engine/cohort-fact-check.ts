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
  kind: "number_not_in_facts" | "url_not_allowed";
  /** 命中的原文片段 */
  matched: string;
  /** 整句原文，便于人工复核 */
  sentence: string;
}

/** 期刊计数的量词。刻意**不含「个」** —— 「3 个步骤」是行文，不是数量断言 */
const COUNT_UNITS = "本|种|份|篇|家";

const PATTERNS: RegExp[] = [
  new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:${COUNT_UNITS})`, "g"),
  /\d+(?:\.\d+)?\s*[%％]/g,
  /\d{4}\s*年/g,
  /(?:共|收录|合计|总计)\s*\d+(?:\.\d+)?/g,
  /(?:排名|位列|名列)\s*第?\s*\d+/g,
];

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
