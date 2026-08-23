/**
 * 8-23 标题-正文判据：否定误伤 + 三档拆分。**用五轮迭代里的真实误伤样本当输入。**
 *
 * ═══ 为什么每一条都值钱 ═══
 *
 * 修这个 bug 迭代了五轮，每一轮漏的都是同一个病换了个入口：
 *
 * ```
 * v1  排除已知反例                 358 → 190   漏「✅预警名单」模板小标题
 * v2  改成要求正面证据             358 →  67   漏间隔里夹「不」
 * v3  间隔排除否定字 + 删谨慎评估   358 →  55   漏「没」
 * v4  否定字集补「没/无」           358 →  55   漏另一个入口 `上了?预警`
 * v5  每个入口都加否定守卫          358 →  54   ✅ 收敛
 * ```
 *
 * 下面每一条 `ok` 用例都对应上面某一轮的漏网形态 —— 删掉任何一条，
 * 就等于把那一轮的 bug 放回来，而且不会有别的测试发现。
 */
import { describe, it, expect } from "vitest";
import { checkTitleBodyConsistency } from "../services/compliance/content-check.js";

const 狠话标题 = "毕业党闭眼冲！";

describe("否定不该被读成肯定（五轮迭代的真实漏网样本）", () => {
  it("v1 漏的：模板小标题「✅ 预警名单✅」—— 否定在后面，排除法看不见", () => {
    const r = checkTitleBodyConsistency(狠话标题, "✅ 预警名单✅ 中科院《国际期刊预警名单》：不在预警名单中。");
    expect(r.verdict).toBe("ok");
  });

  it("v2 漏的：间隔里夹「不」——「在它不在预警名单」", () => {
    expect(checkTitleBodyConsistency(狠话标题, "它不在预警名单，安全。").verdict).toBe("ok");
  });

  it("v3 漏的：否定字集缺「没」——「在稳定，没上预警名单」", () => {
    expect(checkTitleBodyConsistency(狠话标题, "IF 在稳定，没上预警名单。").verdict).toBe("ok");
  });

  it("v4 漏的：另一个入口 `上了?预警` 命中「没上预警名单」的子串", () => {
    expect(checkTitleBodyConsistency(狠话标题, "该刊未上预警名单。").verdict).toBe("ok");
  });

  it("模板小标题「谨慎评估：」说的是读者要谨慎，不是期刊有风险", () => {
    const body = "👥 适合人群 适合投：· 常规课题组、硕博 谨慎评估：· 经费有限的团队（版面费偏高，需提前确认预算）";
    expect(checkTitleBodyConsistency(狠话标题, body).verdict).toBe("ok");
  });

  it("🔴 同一篇里「谨慎评估」出现两次也不许命中（局部排除挡不住重复出现）", () => {
    const body = "谨慎评估：经费有限的团队。……后文又提到 谨慎评估 这四个字。";
    expect(checkTitleBodyConsistency(狠话标题, body).verdict).toBe("ok");
  });
});

describe("真风险必须仍然拦住（防止修误伤时把召回一起修没了）", () => {
  it.each([
    ["已列入", "该刊已列入中科院预警名单，建议避开。"],
    ["上了",   "该刊上了预警名单。"],
    ["拒稿率", "该刊拒稿率高，建议谨慎。"],
    ["自引率", "该刊自引率 33.3% · 高风险。"],
    ["除名",   "该刊已被 SCI 除名。"],
  ])("%s → 仍判信任事故", (_名, body) => {
    expect(checkTitleBodyConsistency(狠话标题, body).verdict).toBe("trust_incident");
  });
});

describe("三档拆分：分类决定处置，处置不可逆", () => {
  it("硬禁词与正文无关 —— 正文再干净也是违规，但归 hard_banned_title（可修复）", () => {
    const r = checkTitleBodyConsistency("评职称毕业稳过！", "本刊审稿规范，无任何风险。");
    expect(r.verdict).toBe("hard_banned_title");
    expect(r.titleHits).toContain("稳过");
    expect(r.riskSignal).toBeNull();   // 与正文无关，不该带上风险信号
  });

  it("🔴 限量话术 + 正文无真风险 = 合法（老韩 8-23 确认保留，额度归 rotation 管）", () => {
    expect(checkTitleBodyConsistency(狠话标题, "该刊审稿 3 个月，IF 3.2，投稿友好。").verdict).toBe("ok");
  });

  it("正文真风险 + 标题不吹 = 合法（诚实报告风险不是问题）", () => {
    expect(checkTitleBodyConsistency("某刊近期数据一览", "该刊已列入预警名单，建议避开。").verdict).toBe("ok");
  });

  it("🔴 hard_banned_title 不在红线名单里 —— 它是改一句标题就能救的", async () => {
    const { RED_LINE_REASONS } = await import("../services/publisher/draft-distributor.js");
    expect(RED_LINE_REASONS).not.toContain("title_hard_banned");
    expect(RED_LINE_REASONS).toContain("title_body_inconsistent");   // 信任事故仍是红线
  });
});
