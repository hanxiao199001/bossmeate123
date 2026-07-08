/**
 * 发布期数据编造硬闸（补 triage 附录标注1 半兜底缺口，老韩已拍"开"）。
 * publishToAccounts 发布前对 needs_review/hasWarnings 内容重跑 checkTitleDataConsistency：
 * 标题审稿/录用率数字无 DB 支撑 → 拒发；forceOverride 强发落审计；违禁词硬拦不变；正常内容零触发。
 * 同客服线 findUnsourcedNumbers 哲学。四条 verify：编造拒发 / 有源放行 / override 绕过+审计 / 违禁词仍拦。
 */
import { describe, it, expect } from "vitest";
import { fabricationPublishGate } from "../services/compliance/content-check.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("fabricationPublishGate — 发布期数据编造硬闸决策", () => {
  it("verify①: 编造数字(needs_review, DB 无审稿周期) → block 拒发", () => {
    const g = fabricationPublishGate({
      status: "needs_review",
      title: "审稿仅30天，录用率高，快速见刊",
      body: "本刊审稿快，欢迎投稿",
      dbFields: { reviewCycle: null, acceptanceRate: null }, // DB 空 → 30天必是编造
    });
    expect(g.action).toBe("block");
    expect(g.mismatches.length).toBeGreaterThan(0);
    expect(g.mismatches.join()).toMatch(/30\s*天/);
  });

  it("verify②: 有源数字(DB 有审稿周期 + 正文复现) → pass 放行", () => {
    const g = fabricationPublishGate({
      status: "needs_review",
      title: "审稿30天，效率高",
      body: "据数据库，该刊审稿30天左右。",
      dbFields: { reviewCycle: "30天", acceptanceRate: null }, // DB 有据
    });
    expect(g.action).toBe("pass");
    expect(g.mismatches).toEqual([]);
  });

  it("verify③: 编造 + forceOverride:true → override 绕过(供调用方落审计)", () => {
    const g = fabricationPublishGate({
      status: "needs_review",
      title: "审稿仅30天",
      body: "投稿快",
      dbFields: { reviewCycle: null },
      forceOverride: true,
    });
    expect(g.action).toBe("override");
    expect(g.mismatches.length).toBeGreaterThan(0); // 审计要列出无源数字
  });

  it("零回归: 正常内容(status=generated, 无 hasWarnings)即使标题有编造数字也不触发闸 → pass", () => {
    const g = fabricationPublishGate({
      status: "generated",
      hasWarnings: false,
      title: "审稿仅30天",
      body: "投稿快",
      dbFields: { reviewCycle: null },
    });
    expect(g.action).toBe("pass"); // 闸只管 flagged 内容, 正常内容零触碰
  });

  it("hasWarnings=true 也触发闸(不止 needs_review)", () => {
    const g = fabricationPublishGate({
      status: "generated",
      hasWarnings: true,
      title: "录用率35%，很好投",
      body: "该刊容易中",
      dbFields: { acceptanceRate: null }, // DB 无录用率 → 35% 编造
    });
    expect(g.action).toBe("block");
  });
});

describe("发布链路 wire 防回归", () => {
  it("verify④: 违禁词硬拦(compliance.blocked→throw)不变, 且排在编造闸之前", async () => {
    const src = await readSrc("../services/publisher/index.ts");
    const blockedIdx = src.indexOf("compliance.blocked");
    const gateIdx = src.indexOf("fabricationPublishGate");
    expect(blockedIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(blockedIdx).toBeLessThan(gateIdx); // 违禁词硬拦在前, 编造闸不绕过它
    expect(src).toMatch(/if \(compliance\.blocked\)[\s\S]{0,80}throw new Error/);
  });

  it("publishToAccounts 接编造闸: needs_review/hasWarnings 触发 + block 抛错 + override 落审计", async () => {
    const src = await readSrc("../services/publisher/index.ts");
    expect(src).toMatch(/content\.status === "needs_review" \|\| _cMeta\.hasWarnings === true/);
    expect(src).toMatch(/gate\.action === "block"/);
    expect(src).toMatch(/throw new Error\(`内容含无 DB 支撑的编造数字/);
    expect(src).toMatch(/PUBLISH_FABRICATION_OVERRIDE/);
    expect(src).toMatch(/who: req\.userId/);
  });

  it("POST /publish 透传 userId(审计谁强发)", async () => {
    const src = await readSrc("../routes/accounts.ts");
    expect(src).toMatch(/userId:\s*request\.user\?\.userId/);
  });
});
