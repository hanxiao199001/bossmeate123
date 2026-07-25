import { describe, it, expect } from "vitest";

/**
 * 7-21 选刊器分层收窄 — pickScopedFreshJournal 结构守卫。
 *
 * 背景: 原 disc 条件 `= discipline OR = generic`, 目标学科与综合刊在一层平权随机选。
 *   generic 桶(328本理工医综合刊)远大于单学科池(如 education 132本) → 教育号配了 education
 *   却 80% 选到理工综合刊(实测教育对口率仅 29%)。
 * 修: 分层从严到宽 —— 纯对口刊(discExact)优先, 枯竭再放 generic, 再枯竭仅 scope 保产量。
 *
 * 沿用 daily-cron 现有单测的"源码结构守卫"模式(该文件强依赖 db, 跑不了纯函数)。
 */
async function readSrc(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL("../services/recommendation/daily-cron.ts", import.meta.url), "utf8");
}

describe("pickScopedFreshJournal 分层收窄", () => {
  it("拆出 discExact(仅目标学科) 与 discOrGeneric(学科+综合刊)两个条件", async () => {
    const src = await readSrc();
    // discExact: 只匹配目标学科码
    expect(src).toMatch(/discExact\s*=\s*sql`\(\$\{journals\.disciplineCode\}\s*=\s*\$\{discipline\}\)`/);
    // discOrGeneric: 目标学科 OR generic
    expect(src).toMatch(/discOrGeneric\s*=\s*sql`\([\s\S]*?disciplineCode[\s\S]*?=\s*\$\{discipline\}\s*OR[\s\S]*?GENERIC_DISCIPLINE_CODE/);
  });

  it("① 纯对口刊(discExact)优先: 前两层用 discExact, 命中即返回, 不掺 generic", async () => {
    const src = await readSrc();
    // byExact 用 discExact 两层, 且 if(byExact) return 提前返回
    expect(src).toMatch(/const byExact\s*=[\s\S]*?discExact[\s\S]*?discExact[\s\S]*?;/);
    expect(src).toMatch(/if\s*\(byExact\)\s*return byExact/);
  });

  it("③④ 学科枯竭才回退 generic, 且日志标'因学科枯竭回退'", async () => {
    const src = await readSrc();
    expect(src).toMatch(/const byGeneric\s*=[\s\S]*?discOrGeneric/);
    expect(src).toMatch(/目标学科对口刊已枯竭.*回退综合刊|回退综合刊\(generic\)兜底/);
  });

  it("⑤⑥ 保产量红线: 最后两层仅 scope(丢 disc), 综合刊也枯竭时宁不对口不空名额", async () => {
    const src = await readSrc();
    // byScope 用 [active, sc, fresh] / [active, sc] — 不含 disc
    expect(src).toMatch(/const byScope\s*=\s*\(await pick\(\[active,\s*sc,\s*fresh\]/);
    expect(src).toMatch(/学科\+综合刊池均枯竭.*仅按 scope 兜底|仅按 scope 兜底\(内容可能不对口\)/);
  });

  it("scope 始终保留(6-19 红线: 国内/国外定位不丢, 每层都带 sc)", async () => {
    const src = await readSrc();
    // 抽取 pickScopedFreshJournal 函数体, 确认没有一层丢掉 sc
    const fnStart = src.indexOf("async function pickScopedFreshJournal");
    const fnBody = src.slice(fnStart, fnStart + 3000);
    // 所有 pick([...]) 调用都应含 sc
    const pickCalls = fnBody.match(/pick\(\[[^\]]*\]/g) || [];
    expect(pickCalls.length).toBeGreaterThanOrEqual(6);
    for (const c of pickCalls) expect(c).toContain("sc");
  });
});

describe("未配学科号不受误伤(disciplines 空 → ALL_DISC_CODES 全学科轮转)", () => {
  it("cfg.disciplines 空时回退 ALL_DISC_CODES, 逐学科进选刊器(分层收窄对每个学科同样生效)", async () => {
    const src = await readSrc();
    expect(src).toMatch(/const discs\s*=\s*cfg\.disciplines\.length\s*\?\s*cfg\.disciplines\s*:\s*ALL_DISC_CODES/);
    // 7-25: ALL_DISC_CODES 不再手抄 13 码副本(靠注释人工同步, 漏过一次), 直接引用 discipline-mapping 唯一真相源
    expect(src).toMatch(/import\s*\{[^}]*DISCIPLINE_CODES[^}]*\}\s*from\s*"\.\/discipline-mapping\.js"/);
    expect(src).toMatch(/ALL_DISC_CODES[^=]*=\s*DISCIPLINE_CODES/);
    // 真相源本身: 13 个具体学科码(含 7-20 新增 humanities), 且不含 generic(generic 只在选刊兜底, 不作生成目标)
    const { DISCIPLINE_CODES, GENERIC_DISCIPLINE_CODE } = await import("../services/recommendation/discipline-mapping.js");
    expect(DISCIPLINE_CODES).toHaveLength(13);
    expect(DISCIPLINE_CODES).toContain("education");
    expect(DISCIPLINE_CODES).toContain("humanities");
    expect(DISCIPLINE_CODES as readonly string[]).not.toContain(GENERIC_DISCIPLINE_CODE);
  });
});

// 7-25 交接护栏: 学科码在库里还有一份"带中文标签"的副本(topic-recommender.ALL_DISCIPLINES,
//   被 admin 配额校验 + 前端下拉复用)。两份码集必须一致, 否则前端能选、后端选刊选不出(或反之)。
describe("学科码单一真相源: ALL_DISCIPLINES(带标签) 与 DISCIPLINE_CODES 码集一致", () => {
  it("码集完全相同(新增/改码必须两处同改)", async () => {
    const { DISCIPLINE_CODES } = await import("../services/recommendation/discipline-mapping.js");
    const { ALL_DISCIPLINES } = await import("../services/content-engine/topic-recommender.js");
    expect([...ALL_DISCIPLINES.map((d) => d.code)].sort()).toEqual([...DISCIPLINE_CODES].sort());
  });
});

describe("多学科号: 加权数组已把 disciplines[] 展开(选刊器只需处理单学科码)", () => {
  it("weighted() 按覆盖学科的号数重复, discs[i % len] 轮询 → 多学科号的每个学科都轮到", async () => {
    const src = await readSrc();
    expect(src).toMatch(/const discipline\s*=\s*discs\[i\s*%\s*discs\.length\]/);
    // weighted: 每学科按号数重复入数组
    expect(src).toMatch(/for\s*\(const \[d, n\] of m\)\s*for\s*\(let i = 0; i < n; i\+\+\)\s*out\.push\(d\)/);
  });
});
