import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  toDisciplineCode,
  DISCIPLINE_CODES,
  GENERIC_DISCIPLINE_CODE,
} from "../services/recommendation/discipline-mapping.js";

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

describe("路由已切到生成列 + generic 放行", () => {
  it("查 journals.disciplineCode 而非原始 discipline 列", () => {
    expect(ROUTE_SRC).toContain("journals.disciplineCode");
    expect(ROUTE_SRC).toContain("toDisciplineCode(discipline)");
    // 匹配端点不再对原始 discipline 列做全等匹配
    expect(ROUTE_SRC).not.toContain("eq(journals.discipline, enDiscipline)");
  });

  it("与 daily-cron 选刊器同口径: code OR generic(综合刊任何槽位通吃)", () => {
    expect(ROUTE_SRC).toMatch(/or\(\s*eq\(journals\.disciplineCode, code\),\s*eq\(journals\.disciplineCode, GENERIC_DISCIPLINE_CODE\)\s*\)/);
  });
});
