/**
 * 「未部署改动」出口 (9-01)。
 *
 * 8-26→9-01 一周内同一形态复现三次:
 *   预测了主备模型共享账户 → 没行动 → 8-31 原样爆, 370 篇失败
 *   写完了备份系统         → 没部署 → 9-01 盘点时仍是零备份
 *   写完了欠费告警账户修正  → 没部署 → 8-31 告警又念了一遍错账户
 *
 * 共同点不是「没想到」, 是**「写了没上线」**, 而这件事此前没有任何出口。
 *
 * 这组用例锁两件:
 *   ① 超期未合的分支要被点名(否则它在生产上等于不存在, 却没人知道)
 *   ② 🔴 **查不成时不许说"没有未部署改动"** —— 那是一句读起来像好消息的假话,
 *      恰好是它要治的那个病
 */
import { describe, it, expect } from "vitest";
import {
  renderUnmergedBranches,
  STALE_BRANCH_DAYS,
  type UnmergedBranchesResult,
} from "../services/ops/unmerged-branches.js";

const ok = (branches: UnmergedBranchesResult["branches"], abandonedCount = 0): UnmergedBranchesResult =>
  ({ branches, abandonedCount, error: null });

describe("① 超期分支要点名", () => {
  it("列出分支名、天数、最后提交日", () => {
    const out = renderUnmergedBranches(ok([
      { name: "feat/backup-to-oss", ageDays: 6, lastCommitAt: "2026-08-26", subject: "每日全库备份" },
    ])).join("\n");
    expect(out).toContain("feat/backup-to-oss");
    expect(out).toContain("6 天");
    expect(out).toContain("2026-08-26");
    // 必须说清后果, 否则只是一个数字
    expect(out).toMatch(/生产上等于不存在/);
  });

  it("多个分支按天数倒序原样列出, 不截断", () => {
    const out = renderUnmergedBranches(ok([
      { name: "a", ageDays: 9, lastCommitAt: "2026-08-23", subject: "" },
      { name: "b", ageDays: 4, lastCommitAt: "2026-08-28", subject: "" },
    ])).join("\n");
    expect(out).toContain("· a");
    expect(out).toContain("· b");
  });

  it("没有超期分支 → 明确说没有(而不是这一节整个消失)", () => {
    const out = renderUnmergedBranches(ok([])).join("\n");
    expect(out).toContain("没有");
    expect(out).toContain(String(STALE_BRANCH_DAYS));
  });
});

describe("③ 🔴 陈旧分支只计数, 但不许静默折叠", () => {
  /**
   * 9-01 实测: 本仓库有 91 个未合入 main 的远端分支, 绝大多数是 5 月的僵尸
   * (squash 合并后分支尖端不再是 main 祖先, --no-merged 永远判"未合")。
   * 一条列 91 项的告警等于没有告警 —— 真正要上线的那两三个会被埋掉。
   * 但折叠了多少必须说出来, 否则读者会以为"只有这几个"。
   */
  it("陈旧数 > 0 时必须报出个数, 并说清动作是清理不是部署", () => {
    const out = renderUnmergedBranches(ok([{ name: "feat/x", ageDays: 5, lastCommitAt: "2026-08-27", subject: "" }], 89)).join("\n");
    expect(out).toContain("feat/x");        // 待上线的照常逐条点名
    expect(out).toContain("89");            // 折叠的说出个数
    expect(out).toMatch(/清理/);            // 且说清动作不同
  });

  it("待上线为空但有陈旧分支 → 两句都要在(不能只说'没有'就完事)", () => {
    const out = renderUnmergedBranches(ok([], 91)).join("\n");
    expect(out).toContain("没有");
    expect(out).toContain("91");
  });
});

describe("② 🔴 查不成 ≠ 没问题", () => {
  it("error 非空时必须说「没查成」, 且不许出现「没有未部署改动」这种话", () => {
    const out = renderUnmergedBranches({ branches: [], abandonedCount: 0, error: "fetch timeout" }).join("\n");
    expect(out).toMatch(/没查成/);
    expect(out).toContain("fetch timeout");
    // 这是本组的核心: 失败态不能长得像好消息
    expect(out).not.toMatch(/没有超过/);
    expect(out).toMatch(/≠ 没有未部署改动/);
  });

  it("error 非空时给出人工兜底动作 —— 每一行报表都要能回答「我该做什么」", () => {
    const out = renderUnmergedBranches({ branches: [], abandonedCount: 0, error: "boom" }).join("\n");
    expect(out).toMatch(/手动看一眼/);
  });
});
