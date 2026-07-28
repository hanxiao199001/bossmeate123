import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  toDisciplineCode,
  DISCIPLINE_CODES,
  GENERIC_DISCIPLINE_CODE,
} from "../services/recommendation/discipline-mapping.js";
import {
  journalDisciplineIs,
  journalDisciplineMatches,
} from "../services/journals/journal-sql.js";

/**
 * 7-25 小程序期刊匹配(POST /journals/match)接通 discipline_code。
 *
 * 原实现三重坏死:
 *   ① `eq(journals.discipline, enDiscipline)` 对**原始列**全等匹配 —— 国内刊原始列存的是
 *      中文分类名("临床医学"), 永远等不上 "medicine" → 2379 本国内刊对小程序全部不可见;
 *   ② 本文件私有的 disciplineMap 里 materials / energy / math **不是合法学科码**;
 *   ③ "计算机" → "engineering" 是错映射(应为 computer)。
 *
 * 修法: 复用 discipline-mapping.ts 的 toDisciplineCode(唯一真相源, 也是生成列的规则源) + 查
 *   journals.discipline_code 生成列, 不再维护第二套映射。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE_SRC = readFileSync(resolve(HERE, "../routes/journals.ts"), "utf8");

describe("bug②: 那三个码根本不存在", () => {
  it("materials / energy / math 都不是合法学科码", () => {
    for (const bogus of ["materials", "energy", "math"]) {
      expect(DISCIPLINE_CODES as readonly string[]).not.toContain(bogus);
    }
  });

  it("旧 disciplineMap 已从路由删除, 不再有第二套映射", () => {
    // 只认"声明"(注释里提到旧名字是允许的, 那是历史说明)
    expect(ROUTE_SRC).not.toMatch(/const\s+disciplineMap/);
    // 三个死码在路由里彻底消失
    expect(ROUTE_SRC).not.toMatch(/"材料科学"\s*:\s*"materials"/);
    expect(ROUTE_SRC).not.toMatch(/"能源"\s*:\s*"energy"/);
    expect(ROUTE_SRC).not.toMatch(/"数学"\s*:\s*"math"/);
  });

  it("那三个中文学科现在被 toDisciplineCode 映到真实存在的码", () => {
    expect(toDisciplineCode("材料科学")).toBe("engineering"); // 材料 → engineering
    expect(toDisciplineCode("能源")).toBe("engineering");     // 能源 → engineering
    // 数学没有专属码, 规则未覆盖 → generic(综合刊池, 100% 覆盖约束)
    expect(toDisciplineCode("数学")).toBe(GENERIC_DISCIPLINE_CODE);
    for (const code of ["engineering", GENERIC_DISCIPLINE_CODE]) {
      expect([...DISCIPLINE_CODES, GENERIC_DISCIPLINE_CODE]).toContain(code);
    }
  });
});

describe("bug③: '计算机' 错映射到 engineering", () => {
  it("现在正确落 computer", () => {
    expect(toDisciplineCode("计算机")).toBe("computer");
    expect(toDisciplineCode("计算机科学")).toBe("computer");
    expect(toDisciplineCode("自动化技术、计算机技术")).toBe("computer");
  });
});

describe("bug①: 国内刊中文分类名现在能匹配上", () => {
  it("国内刊真实分类名 → 正确学科码(原全等匹配 0 结果)", () => {
    expect(toDisciplineCode("临床医学")).toBe("medicine");
    expect(toDisciplineCode("内科学")).toBe("medicine");
    expect(toDisciplineCode("教育学")).toBe("education");
    expect(toDisciplineCode("农业经济")).toBe("agriculture");
    expect(toDisciplineCode("地理学")).toBe("environment");
    expect(toDisciplineCode("综合性人文、社会科学")).toBe("humanities");
  });

  it("国际刊传英文码原样透传(大小写不敏感), 老用法不回归", () => {
    expect(toDisciplineCode("medicine")).toBe("medicine");
    expect(toDisciplineCode("Medicine")).toBe("medicine");
    expect(toDisciplineCode("computer")).toBe("computer");
  });

  it("综合刊/学报 → generic", () => {
    expect(toDisciplineCode("综合性理工农医")).toBe(GENERIC_DISCIPLINE_CODE);
    expect(toDisciplineCode("大学学报")).toBe(GENERIC_DISCIPLINE_CODE);
    expect(toDisciplineCode("")).toBe(GENERIC_DISCIPLINE_CODE);
    expect(toDisciplineCode(null)).toBe(GENERIC_DISCIPLINE_CODE);
  });
});

/**
 * 7-28 (阶段 1-A #5): 这里原来是两条**源码正则守卫**(断言路由里出现
 * `journals.disciplineCode` 和 `or(eq(code), eq(GENERIC))` 字面量)。判据抽进
 * `journal-sql.ts` 的 journalDisciplineMatches 之后, 那两条字面量自然消失, 正则守卫会
 * 假红 —— 正是设计框架里说的"守文本不守行为、等价重构反而全红"。
 * 换成: ① 对 helper 本身做**真行为测试**(它生成的 SQL 打的是哪一列、有没有放行 generic);
 *       ② 路由这边只留一条"确实在调 helper"的轻量检查, 具体行为由 ① 保证。
 * 全仓不许再读原始列这一条由 `journals-discipline-code-scan.test.ts` 全量扫描守着。
 */
describe("路由已切到生成列 + generic 放行", () => {
  it("路由调 helper, 不再自己拼学科条件", () => {
    expect(ROUTE_SRC).toContain("journalDisciplineMatches(discipline)");
    // 匹配端点不再对原始 discipline 列做全等匹配
    expect(ROUTE_SRC).not.toContain("eq(journals.discipline, enDiscipline)");
  });

  it("helper 打的是生成列 discipline_code, 不是原始列", () => {
    const q = journalDisciplineMatches("临床医学")!;
    expect(q).not.toBeNull();
    const sqlText = JSON.stringify(q);
    expect(sqlText).toContain("discipline_code");
    // 原始列 "discipline" 只会作为 "discipline_code" 的前缀出现, 不会单独出现
    expect(/"name":"discipline"/.test(sqlText)).toBe(false);
  });

  it("与 daily-cron 选刊器同口径: code OR generic(综合刊任何槽位通吃)", () => {
    const q = journalDisciplineMatches("计算机")!;
    const sqlText = JSON.stringify(q);
    expect(sqlText).toContain("computer");
    expect(sqlText).toContain(GENERIC_DISCIPLINE_CODE);
  });

  it("includeGeneric:false 时只要对口刊(筛选器/同档对比用)", () => {
    const q = journalDisciplineMatches("计算机", { includeGeneric: false })!;
    const sqlText = JSON.stringify(q);
    expect(sqlText).toContain("computer");
    expect(sqlText).not.toContain(GENERIC_DISCIPLINE_CODE);
  });

  it("自由文本归一不出具体学科 → null(不加条件), 不掉进 generic 把综合刊全捞出来", () => {
    expect(journalDisciplineMatches("元宇宙")).toBeNull();
    expect(journalDisciplineMatches("")).toBeNull();
    expect(journalDisciplineMatches(null)).toBeNull();
  });

  it("journalDisciplineIs: 精确分桶, 与 meta/disciplines 的 GROUP BY discipline_code 同口径", () => {
    const sqlText = JSON.stringify(journalDisciplineIs("临床医学"));
    expect(sqlText).toContain("discipline_code");
    expect(sqlText).toContain("medicine");
    expect(sqlText).not.toContain(GENERIC_DISCIPLINE_CODE);
    // 下拉框里的 generic 那一桶也能原样查回来
    expect(JSON.stringify(journalDisciplineIs(GENERIC_DISCIPLINE_CODE))).toContain(GENERIC_DISCIPLINE_CODE);
  });

  it("学科下拉框按生成列分组(否则前端永远拼不出『medicine 还剩几本』)", () => {
    const start = ROUTE_SRC.indexOf('app.get("/journals/meta/disciplines"');
    expect(start).toBeGreaterThan(-1);
    const body = ROUTE_SRC.slice(start, start + 1600);
    expect(body).toContain("groupBy(journals.disciplineCode)");
    expect(body).not.toMatch(/groupBy\(journals\.discipline\)/);
  });
});

/**
 * bug④(7-25 线上验证时发现): 上面三重修完, `POST /journals/match {discipline:"计算机"}` 线上
 * 实测**仍是 0 条** —— 而且不带 discipline 也是 0 条, 任何租户都是 0 条。
 *
 * 真因不在学科码, 在 conditions 的第一行: `eq(journals.tenantId, tenantId)`。线上 8743 本期刊
 * 的 tenant_id 是 **NULL**(共享池; 只有租户自建刊才带 tenant_id), NULL 等不上任何 uuid →
 * 整个池子被排除。学科码修对了(computer 306 本 + generic 1139 本 = 1444 本待命), 只是看不见。
 *
 * 同文件 GET /journals/:id 早就是 `isNull OR eq` 口径, daily-cron 的 pickScopedFreshJournal
 * 也只拿 tenantId 做冷却/LRU、不拿它过滤期刊表 —— match 是唯一跑偏的读路径。
 */
describe("bug④: tenant 严格相等把整个共享池排除在外", () => {
  /** match 端点的函数体(到下一个 app.xxx 注册为止) */
  const MATCH_BODY = (() => {
    const start = ROUTE_SRC.indexOf('app.post("/journals/match"');
    expect(start).toBeGreaterThan(-1);
    const rest = ROUTE_SRC.slice(start + 1);
    const end = rest.search(/\n\s{2}app\.(get|post|patch|put|delete)\(/);
    return end === -1 ? rest : rest.slice(0, end);
  })();

  it("不再对 tenantId 做严格相等(那会漏掉 tenant_id IS NULL 的共享池)", () => {
    expect(MATCH_BODY).not.toMatch(/conditions:\s*any\[\]\s*=\s*\[eq\(journals\.tenantId, tenantId\)\]/);
  });

  it("共享池(isNull) 与租户自有刊(eq) 一起放行, 与 GET /journals/:id 同口径", () => {
    expect(MATCH_BODY).toMatch(/or\(\s*isNull\(journals\.tenantId\),\s*eq\(journals\.tenantId, tenantId\)\s*\)/);
  });

  it("写路径保持严格租户隔离(seed / patch / enrich 不受本次放宽影响)", () => {
    // 放宽只发生在 match 一处; 写端点仍是裸 eq
    for (const ep of ['app.post("/journals/seed"', 'app.patch("/journals/:id"']) {
      const i = ROUTE_SRC.indexOf(ep);
      expect(i).toBeGreaterThan(-1);
    }
    expect(ROUTE_SRC).toMatch(/eq\(journals\.tenantId, tenantId\)/); // 其它端点仍在用
  });
});
