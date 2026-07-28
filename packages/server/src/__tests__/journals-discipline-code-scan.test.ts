/**
 * 学科码口径 —— **全量扫描**回归锁 (7-28, 阶段 1-A #5)。
 *
 * ## 病根(同一个病已经犯了 11 次)
 * `journals.discipline` 是**原始列**, 两套值域混在一列里:
 *   - 国内刊(2379 本 verified active)存北大核心/CSCD 的**中文分类名**: "临床医学" / "内科学" /
 *     "综合性理工农医" / "中国政治(除公安管理、公安工作）" …
 *   - 国际刊(4828 本)存**英文码**: "medicine" / "computer" …
 * 所以 `discipline ILIKE '%medicine%'` 对 2242 本国内刊永远匹配不上, 反过来
 * `discipline ILIKE '%医学%'` 对国际刊永远匹配不上。**两个方向都漏, 且不报错**——
 * 只是那批刊在学科槽位里静默消失。
 *
 * 7-20 建了生成列 `journals.discipline_code`(migration 026, 表达式由
 * `services/recommendation/discipline-mapping.ts` 的 RULES 生成, DB 保证不漂), 两套原始值
 * 都归一到同一套 13 码 + generic。但**只有选刊器切了过去**, 另外 11 处热路径继续读原始列:
 *   routes/journals.ts(列表筛选 + 学科下拉 GROUP BY) / content-engine/topic-recommender.ts /
 *   data-collection/journal-content-collector.ts ×3 / crawler/journal-cover-prefetch.ts /
 *   content-engine/roundup-generator.ts(三条件里还留了原始列 ILIKE 兜底) /
 *   routes/admin.ts(精准模式选热词) / recommendation/journal-topic-miner.ts(**写入侧**: 把
 *   中文分类名写进 keywords.category, 而 selectCandidates 按学科码筛 → 灌死票) /
 *   metrics/effect-dashboard.ts / scripts/sample-*.ts ×3 / scripts/enrich-wanfang-batch.ts。
 *
 * ## 所以这个测试扫全量 src/**\/*.ts
 * "抽了没切干净"是这个项目重复最多的失败模式(fallback-messages 至今 3/28)。单点测试守不住
 * 下一个人在第 12 个文件里写第 12 次。**这一条才是防复发的关键。**
 *
 * ## 判定规则
 * 出现 `journals.discipline`(词边界, 不含 `journals.disciplineCode`)时:
 *   - 在 ALLOWLIST 里 → 放行(全是"把原始中文分类名展示给人/LLM 看"或"维护原始列本身"的地方);
 *   - 否则 → 红。修法见 HOWTO。
 *
 * **铁律: 匹配/分组/写别的表 → 读生成列 discipline_code; 只有「展示原始分类名」才读原始列。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  toDisciplineCode,
  resolveDisciplineCode,
  GENERIC_DISCIPLINE_CODE,
  DISCIPLINE_CODES,
} from "../services/recommendation/discipline-mapping.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/**
 * 白名单: 允许读**原始列** discipline 的地方。key = 相对 src 的路径, value = [允许出现次数, 理由]。
 * 次数写死是刻意的 —— 同一个文件里新加一处也会红, 逼你说明为什么这一处不是匹配逻辑。
 *
 * 两类合法用途:
 *   ① **展示**: 原始中文分类名("临床医学")比学科码("medicine")信息量大、也更适合塞进
 *      给人看的文案或给 LLM 的 prompt。这类只 select 出来往下游传, 不参与任何比较。
 *   ② **维护原始列本身**: 回填/纠错脚本, 它们的操作对象就是这一列。
 */
const ALLOWLIST: Record<string, [number, string]> = {
  // ① 展示类 —— select 出来直接进文案/prompt, 不做比较
  "services/skills/video-skill.ts": [1, "展示: 视频脚本文案『期刊：X（临床医学领域）』"],
  "services/publisher/douyin-caption.ts": [2, "展示: 抖音文案生成的 prompt 素材 + 规则兜底 seeds"],
  "services/batch/batch-worker.ts": [1, "展示: 随期刊资料一起喂给生成引擎"],
  "services/video/index.ts": [1, "展示: 视频元数据"],
  "services/recommendation/journal-recommender.ts": [1, "展示: 候选刊清单喂给 LLM 选刊, 中文分类名信息量>码"],
  "services/recommendation/topic-recommender.ts": [1, "展示: 单刊推题 prompt『学科：X』+ 无 LLM 时的 fallback 主题串"],
  "services/content-engine/roundup-generator.ts": [1, "展示: 盘点模板里的学科字段(选刊条件已改读 discipline_code)"],

  // ② 维护原始列本身的脚本 —— 操作对象就是这一列
  "scripts/backfill-discipline.ts": [3, "回填脚本: WHERE 原始列为空/multidisciplinary 才补, 目标就是这一列"],
  "scripts/expand-and-fix-discipline.ts": [1, "纠错脚本: 把 multidisciplinary 占位值改成真分类, 目标就是这一列"],
};

const HOWTO =
  "\n\n修法: 用 services/journals/journal-sql.ts 的" +
  "\n  · journalDisciplineIs(raw)       —— 精确分桶(筛选器/统计/同档对比), = discipline_code" +
  "\n  · journalDisciplineMatches(raw)  —— 槽位匹配(选刊/配刊), = code OR generic; 归一不出具体学科返回 null" +
  "\n  · 只是把码取出来自己用 → 直接 select journals.disciplineCode" +
  "\n确属『展示原始中文分类名』(不参与任何比较)就把文件加进本测试的 ALLOWLIST 并写清理由。" +
  "\n背景: 原始列国内刊存中文分类名、国际刊存英文码, 任何一侧的匹配写法都会静默漏掉另一侧;" +
  "\n     discipline_code 是生成列(migration 026), 由 discipline-mapping.ts 的 RULES 生成, DB 保证不漂。";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 去掉整行注释(注释里提旧写法是历史说明, 不算病) */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/** `journals.discipline` 但**不是** `journals.disciplineCode` —— 靠后面不许跟标识符字符来区分 */
const RAW_DISCIPLINE = /journals\.discipline(?![A-Za-z0-9_])/g;

interface Hit { file: string; line: number; snippet: string }

function scanRawHits(): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(SRC)) {
    const code = stripLineComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(RAW_DISCIPLINE)) {
      hits.push({
        file: relative(SRC, file).replace(/\\/g, "/"),
        line: code.slice(0, m.index).split("\n").length,
        snippet: code.slice(Math.max(0, m.index - 70), m.index + 70).replace(/\s+/g, " "),
      });
    }
  }
  return hits;
}

describe("学科码口径 — 全量扫描(src/**/*.ts)", () => {
  const hits = scanRawHits();

  it("白名单之外不许读原始列 journals.discipline", () => {
    const offenders = hits.filter((h) => !(h.file in ALLOWLIST));
    expect(
      offenders.map((h) => `${h.file}:${h.line}  ${h.snippet}`),
      "发现新的原始学科列用法(国内刊或国际刊会被静默漏掉)" + HOWTO,
    ).toEqual([]);
  });

  it("白名单文件里的出现次数不许变多(新加一处也要说明理由)", () => {
    for (const [file, [expected, reason]] of Object.entries(ALLOWLIST)) {
      const n = hits.filter((h) => h.file === file).length;
      expect(n, `${file} 期望 ${expected} 处原始列用法(${reason}), 实际 ${n} 处。` + HOWTO).toBe(expected);
    }
  });

  it("11 处发病点已全部改读生成列(逐个文件点名, 防有人改回去)", () => {
    const FIXED = [
      "routes/journals.ts",
      "routes/admin.ts",
      "services/content-engine/topic-recommender.ts",
      "services/content-engine/roundup-generator.ts",
      "services/data-collection/journal-content-collector.ts",
      "services/crawler/journal-cover-prefetch.ts",
      "services/recommendation/journal-topic-miner.ts",
      "services/metrics/effect-dashboard.ts",
      "scripts/sample-titles.ts",
      "scripts/sample-article.ts",
      "scripts/sample-card-video.ts",
      "scripts/enrich-wanfang-batch.ts",
    ];
    for (const file of FIXED) {
      const src = stripLineComments(readFileSync(join(SRC, file), "utf8"));
      expect(
        /journals\.disciplineCode|journalDisciplineIs\(|journalDisciplineMatches\(/.test(src),
        `${file} 应该读生成列 discipline_code(直接读 或 走 journal-sql.ts 的 helper)`,
      ).toBe(true);
      // roundup-generator 白名单里还留着一处展示用的 select, 所以只查"非白名单文件不许有裸用法"
      if (!(file in ALLOWLIST)) {
        expect(hits.some((h) => h.file === file), `${file} 又出现原始列 journals.discipline`).toBe(false);
      }
    }
  });

  it("helper 自身是唯一定义处(别再有人另起炉灶写第二套学科匹配)", () => {
    // 同上: 必须去注释再扫 —— 该文件头部注释正是在解释"原始列 journals.discipline 是什么",
    // 不去注释会把这段历史说明当成违规命中(源码正则守卫的典型误伤)。
    const src = stripLineComments(readFileSync(join(SRC, "services/journals/journal-sql.ts"), "utf8"));
    expect(src).toMatch(/export function journalDisciplineIs/);
    expect(src).toMatch(/export function journalDisciplineMatches/);
    // 两个 helper 都只打生成列
    expect(src).not.toMatch(/journalDisciplineIs[\s\S]{0,300}journals\.discipline(?![A-Za-z0-9_])/);
  });

  it("topic-recommender 的第二张私有学科表(extractDiscipline)已删除", () => {
    const src = readFileSync(join(SRC, "services/content-engine/topic-recommender.ts"), "utf8");
    expect(src).not.toMatch(/function extractDiscipline/);
    // 它独有的词根并入了 inferCategoryFromKeyword, 覆盖面不缩
    expect(src).toContain("高血压");
    expect(src).toContain("光伏");
  });
});

/** 纯逻辑复刻: 原始列的两套值域 —— 11 次犯病的共同根因 */
describe("根因复刻: 原始列一列两套值域, 任何一侧的匹配写法都漏另一侧", () => {
  interface Row { name: string; discipline: string }
  const POOL: Row[] = [
    { name: "中华内科杂志", discipline: "临床医学" },      // 国内刊: 中文分类名
    { name: "护理学杂志", discipline: "内科学" },          // 国内刊: 另一个中文分类名
    { name: "The Lancet", discipline: "medicine" },        // 国际刊: 英文码
    { name: "Nature", discipline: "multidisciplinary" },   // 国际刊: 占位值
  ];
  const rawIlike = (rows: Row[], q: string) => rows.filter((r) => r.discipline.toLowerCase().includes(q.toLowerCase()));
  const byCode = (rows: Row[], code: string) => rows.filter((r) => toDisciplineCode(r.discipline) === code);

  it("`discipline ILIKE '%medicine%'` 只捞到国际刊, 国内刊全漏", () => {
    expect(rawIlike(POOL, "medicine").map((r) => r.name)).toEqual(["The Lancet"]);
  });

  it("`discipline ILIKE '%医学%'` 反过来漏掉国际刊, 还漏掉同学科的『内科学』", () => {
    expect(rawIlike(POOL, "医学").map((r) => r.name)).toEqual(["中华内科杂志"]);
  });

  it("`discipline = discipline` 字面全等: 同为医学的两本国内刊互相不认(同档对比恒空)", () => {
    const a = POOL[0], b = POOL[1];
    expect(a.discipline === b.discipline).toBe(false);
    expect(toDisciplineCode(a.discipline)).toBe(toDisciplineCode(b.discipline));
  });

  it("生成列 discipline_code: 三本医学刊一次全中, 跨国内/国际", () => {
    expect(byCode(POOL, "medicine").map((r) => r.name)).toEqual([
      "中华内科杂志", "护理学杂志", "The Lancet",
    ]);
  });
});

/** helper 的语义边界: toDisciplineCode(100% 覆盖) vs resolveDisciplineCode(不硬凑) */
describe("resolveDisciplineCode: 自由文本归一不出具体学科时返回 null, 而不是硬塞 generic", () => {
  it("能归一的照常给码", () => {
    expect(resolveDisciplineCode("临床医学")).toBe("medicine");
    expect(resolveDisciplineCode("Medicine")).toBe("medicine");
    expect(resolveDisciplineCode("计算机")).toBe("computer");
  });

  it("空值 / 综合刊 / 规则未覆盖的自由热词 → null(调用方据此不加学科条件)", () => {
    for (const raw of [null, undefined, "", "   ", "综合性理工农医", "大学学报", "元宇宙"]) {
      expect(resolveDisciplineCode(raw), `resolveDisciplineCode(${JSON.stringify(raw)})`).toBeNull();
      // 对照: toDisciplineCode 的契约是 100% 覆盖, 这些一律落 generic
      expect(toDisciplineCode(raw)).toBe(GENERIC_DISCIPLINE_CODE);
    }
  });

  it("返回值只可能是合法学科码, 且永远不是 generic", () => {
    for (const raw of ["临床医学", "教育学", "农业机械", "环境科学", "medicine", "元宇宙", null]) {
      const code = resolveDisciplineCode(raw);
      if (code === null) continue;
      expect(DISCIPLINE_CODES as readonly string[]).toContain(code);
      expect(code).not.toBe(GENERIC_DISCIPLINE_CODE);
    }
  });
});
