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
  // 7-30 条件片段收口: discExact / discOrGeneric(以及 active / fresh)不再内联写在这里,
  //   改由 journal-sql.ts 的 journalPoolCriteria() 统一给出 —— 期刊池盘点服务用的是**同一个
  //   函数的返回值**。断言随之从"锁字面 SQL"改成"锁同源"(与 7-28 ③c 对 verified 的处理同一路数):
  //   片段的定义本身由 journal-pool-criteria-single-source.test.ts 守。
  it("六个条件片段全部取自 journalPoolCriteria(与盘点服务同源), 不在选刊器里内联拼 SQL", async () => {
    const src = await readSrc();
    expect(src).toMatch(/const \{ active, verified, scope: sc, discExact, discOrGeneric, fresh \} =\s*[\s\S]{0,80}journalPoolCriteria\(\{ tenantId, scope, discipline \}\)/);
    expect(src).toMatch(/import \{[^}]*journalPoolCriteria[^}]*\} from "\.\.\/journals\/journal-sql\.js"/);
    // 🚫 回归锁: 选刊器里不许再出现自己拼的学科/冷却条件(那就是又造了第二套判据)
    const fnStart = src.indexOf("async function pickScopedFreshJournal");
    const fnBody = src.slice(fnStart, src.indexOf("runDailyContentByType", fnStart));
    expect(fnBody).not.toMatch(/sql`\(\$\{journals\.disciplineCode\}/);
    expect(fnBody).not.toMatch(/NOT EXISTS[\s\S]{0,120}journal_usage/);
  });

  // 7-28 (#1) 新契约: 新鲜(fresh)优先于回头(LRU)。旧层②(verified+discExact 的 LRU **无 fresh**)
  // 只要池非空必短路 → 小学科 verified 池新鲜耗尽后天天 LRU 回头同几本, 15 天冷却形同虚设。
  it("①② 已核实+新鲜两层(对口→generic)命中即返回, 且两层都带 fresh", async () => {
    const src = await readSrc();
    expect(src).toMatch(/const freshVerified\s*=\s*\(await pick\(\[active,\s*verified,\s*sc,\s*discExact,\s*fresh\][\s\S]*?pick\(\[active,\s*verified,\s*sc,\s*discOrGeneric,\s*fresh\]/);
    expect(src).toMatch(/if\s*\(freshVerified\)\s*return freshVerified/);
  });

  it("🚫 回归锁: 不允许再出现'verified+discExact 无 fresh 的 LRU'排在未核实新鲜层之前(旧层②小池死循环)", async () => {
    const src = await readSrc();
    const fnStart = src.indexOf("async function pickScopedFreshJournal");
    const fnBody = src.slice(fnStart, src.indexOf("runDailyContentByType", fnStart));
    // LRU 回头层(lruVerified)必须出现在未核实新鲜层(freshUnverified)之后 —— 新鲜优先于回头
    expect(fnBody.indexOf("freshVerified")).toBeGreaterThan(-1);
    expect(fnBody.indexOf("freshUnverified")).toBeGreaterThan(-1);
    expect(fnBody.indexOf("lruVerified")).toBeGreaterThan(fnBody.indexOf("freshUnverified"));
    expect(fnBody.indexOf("freshUnverified")).toBeGreaterThan(fnBody.indexOf("freshVerified"));
  });

  it("③④ 未核实新鲜层受日配额闸(UNVERIFIED_DAILY_QUOTA, env 可配默认 2), 内容走 needs_review 复核", async () => {
    const src = await readSrc();
    expect(src).toMatch(/UNVERIFIED_DAILY_QUOTA\s*>\s*0\s*&&\s*\(await unverifiedUsedToday\(tenantId\)\)\s*<\s*UNVERIFIED_DAILY_QUOTA/);
    expect(src).toMatch(/process\.env\.UNVERIFIED_DAILY_QUOTA/);
    expect(src).toMatch(/Number\.isFinite\(n\) && n >= 0 \? Math\.floor\(n\) : 2/); // 默认 2
    expect(src).toMatch(/日配额内放行未核实新鲜刊/);
    // 配额计数: 当日 journal_usage×journals 联查, 与 batch-worker isUnverifiedJournal 同口径
    expect(src).toMatch(/date_trunc\('day', now\(\)\)/);
    // 7-28 (③c): 门槛改**分体系**(国内刊看目录成员资格 / 国际刊仍 conf>=70), 口径不再内联写死在
    //   这条 SQL 里, 而是取自 journal-sql.ts 的 verifiedJournalCondition() —— 断言改为锁"同源"。
    expect(src).toMatch(/sql`NOT \$\{verifiedJournalCondition\(\)\}`/);
    // 7-30: 同一行 import 里 journalScopeCondition 已被 journalPoolCriteria 取代(scope 片段现在
    //   由条件组一并给出), 但"配额计数与选刊器同一把可信度尺子"这条约束不变。
    expect(src).toMatch(/import \{[^}]*verifiedJournalCondition[^}]*\} from "\.\.\/journals\/journal-sql\.js"/);
  });

  it("⑤⑥ 已核实 LRU 回头刊降为最后手段(在所有新鲜层之后), 带日志", async () => {
    const src = await readSrc();
    expect(src).toMatch(/const lruVerified\s*=\s*\(await pick\(\[active,\s*verified,\s*sc,\s*discExact\],\s*lru\)[\s\S]*?pick\(\[active,\s*verified,\s*sc,\s*discOrGeneric\],\s*lru\)/);
    expect(src).toMatch(/回退已核实 LRU 回头刊/);
  });

  it("⑦-⑩ 保产量红线 floor: 综合池兜底 + 最后仅 scope(丢 disc), 宁不对口不空名额", async () => {
    const src = await readSrc();
    expect(src).toMatch(/const byGeneric\s*=\s*\(await pick\(\[active,\s*sc,\s*discOrGeneric,\s*fresh\]/);
    // byScope 用 [active, sc, fresh] / [active, sc] — 不含 disc
    expect(src).toMatch(/const byScope\s*=\s*\(await pick\(\[active,\s*sc,\s*fresh\]/);
    expect(src).toMatch(/学科\+综合刊池均枯竭.*仅按 scope 兜底|仅按 scope 兜底\(内容可能不对口\)/);
  });

  it("scope 始终保留(6-19 红线: 国内/国外定位不丢, 每层都带 sc)", async () => {
    const src = await readSrc();
    // 抽取 pickScopedFreshJournal 函数体, 确认没有一层丢掉 sc
    const fnStart = src.indexOf("async function pickScopedFreshJournal");
    const fnBody = src.slice(fnStart, src.indexOf("runDailyContentByType", fnStart));
    // 所有 pick([...]) 调用都应含 sc (新层序共 10 层)
    const pickCalls = fnBody.match(/pick\(\[[^\]]*\]/g) || [];
    expect(pickCalls.length).toBeGreaterThanOrEqual(10);
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
