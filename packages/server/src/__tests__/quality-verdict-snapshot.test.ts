/**
 * 8-20 质量快照回归锁。
 *
 * 锁两样：
 *   ① `resolveQualitySnapshot` 的**行为**（纯函数，红线 #15：不匹配源码字面）
 *   ② 分发链路的两条**真跑的路**都写了 verdict —— 这是扫描守卫（红线 #17）
 *
 * ② 为什么必要：8-20 `contents.published_at` 那次，写入点被挂在
 * `initiated_by='manual'` 这条**从没跑过**的路上，上线后一行都没写。
 * 实测 content_publish_log 全历史只有两个 initiated_by：
 * `draft_dist`(333) 与 `bulk_distribute`(203)。守卫钉住这两条。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveQualitySnapshot } from "../services/publisher/quality-verdict.js";
import { RED_LINE_REASONS } from "../services/publisher/draft-distributor.js";

const SRC = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("resolveQualitySnapshot — 三档", () => {
  it("passed：sixDimPassed=true", () => {
    expect(resolveQualitySnapshot({ sixDimPassed: true, sixDimTotal: 86 }))
      .toEqual({ verdict: "passed", sixDimTotal: 86 });
  });

  it("below_bar：评过分但没过", () => {
    expect(resolveQualitySnapshot({ sixDimPassed: false, sixDimTotal: 73 }))
      .toEqual({ verdict: "below_bar", sixDimTotal: 73 });
  });

  it("unscored：从没跑过六维", () => {
    expect(resolveQualitySnapshot({})).toEqual({ verdict: "unscored", sixDimTotal: null });
    expect(resolveQualitySnapshot(null)).toEqual({ verdict: "unscored", sixDimTotal: null });
  });

  it("🔴 unscored 不许并进 below_bar —— 两者是不同的事", () => {
    // 实测近 14 天进分发的 103 篇里 29 篇是这一档(评分环节没执行, 不是分低)
    const a = resolveQualitySnapshot({});
    const b = resolveQualitySnapshot({ sixDimPassed: false, sixDimTotal: 40 });
    expect(a.verdict).not.toBe(b.verdict);
  });
});

describe("resolveQualitySnapshot — 不自己重算达标线", () => {
  it("🔴 总分 ≥80 但 sixDimPassed 缺失 → unscored，绝不当 passed", () => {
    // 达标线是「总分 ≥80 **且每维 ≥6**」。只看总分会把被地板挡下的算成达标(红线 #20)。
    const r = resolveQualitySnapshot({ sixDimTotal: 88 });
    expect(r.verdict).toBe("unscored");
    expect(r.sixDimTotal).toBe(88); // 总分仍留下供排查
  });

  it("总分 90 但 sixDimPassed=false（被每维 ≥6 的地板挡下）→ below_bar", () => {
    expect(resolveQualitySnapshot({ sixDimPassed: false, sixDimTotal: 90 }).verdict).toBe("below_bar");
  });
});

describe("resolveQualitySnapshot — 脏值", () => {
  it("总分是字符串也认", () => {
    expect(resolveQualitySnapshot({ sixDimPassed: true, sixDimTotal: "82.5" }).sixDimTotal).toBe(82.5);
  });

  it("总分是 NaN/空串 → null，不当 0", () => {
    // 当成 0 会被下限闸误拦(0 < 60)，把"读不出分"变成"分很低" —— 7-27 那类错误的形态
    expect(resolveQualitySnapshot({ sixDimPassed: true, sixDimTotal: "" }).sixDimTotal).toBeNull();
    expect(resolveQualitySnapshot({ sixDimPassed: true, sixDimTotal: "abc" }).sixDimTotal).toBeNull();
    expect(resolveQualitySnapshot({ sixDimPassed: true, sixDimTotal: Number.NaN }).sixDimTotal).toBeNull();
  });

  it("有 sixDimScores 但没总分 → 仍算评过分的形态，走 sixDimPassed", () => {
    expect(resolveQualitySnapshot({ sixDimScores: { dataAccuracy: 5 }, sixDimPassed: false }).verdict)
      .toBe("below_bar");
  });
});

describe("六维下限闸 —— 只拦'评过分且分低', 不拦 unscored", () => {
  it("six_dim_below_floor 必须在红线名单里（否则下一轮重进池被反复重拦）", () => {
    expect(RED_LINE_REASONS).toContain("six_dim_below_floor");
  });

  it("🔴 '没评上分'的 reason 绝不在红线里 —— 7-27 零产出事故的判据", () => {
    // "我们的评分器挂了" ≠ "内容有问题"
    for (const r of ["quality_check_unavailable", "sixdim_degraded", "quality_gate_unavailable"]) {
      expect(RED_LINE_REASONS).not.toContain(r);
    }
  });

  it("闸的判定条件必须要求 sixDimTotal 非 null（unscored 不进闸）", () => {
    const src = read("services/publisher/draft-distributor.ts");
    // 锁的是「null 检查与阈值比较在同一个表达式里」这个结构关系(红线 #16: 不用文件级共现)
    expect(src).toMatch(/snap\.sixDimTotal !== null && snap\.sixDimTotal < minSixDimTotal/);
  });
});

describe("守卫: 两条真跑的分发路径都写 quality_verdict（红线 #17）", () => {
  it("draft_dist 路径（近 30 天 267 行）写了 qualityVerdict", () => {
    const src = read("services/publisher/draft-distributor.ts");
    const idx = src.indexOf('initiatedBy: "draft_dist"');
    expect(idx).toBeGreaterThan(0);
    // insert 与 onConflictDoUpdate 两处都要写 —— 只写 insert 的话重推行会留着上一次的判定
    expect(src.match(/qualityVerdict:/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("bulk_distribute 路径（近 30 天 104 行）写了 quality_verdict，且冲突更新也写", () => {
    const src = read("services/bulk-distribute/worker.ts");
    expect(src).toContain("quality_verdict");
    expect(src).toMatch(/quality_verdict = EXCLUDED\.quality_verdict/);
    expect(src).toMatch(/six_dim_total = EXCLUDED\.six_dim_total/);
  });

  it("两条路径都用同一个纯函数判定，不各写一套", () => {
    for (const f of ["services/publisher/draft-distributor.ts", "services/bulk-distribute/worker.ts"]) {
      expect(read(f)).toContain("resolveQualitySnapshot");
    }
  });
});

describe("迁移 039", () => {
  it("加了两列 + 部分索引，且不回填存量", () => {
    const src = read("models/migrations.ts");
    expect(src).toContain("039_publish_log_quality_verdict");
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS quality_verdict/);
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS six_dim_total/);
    // 🔴 绝不 UPDATE 存量行: 回填只能拿 metadata 的**当前**值冒充**当时**值,
    //   而"冻结当时的判断"正是这两列的全部意义。
    const m = src.slice(src.indexOf("039_publish_log_quality_verdict"));
    expect(m.slice(0, m.indexOf("`,\n  },"))).not.toMatch(/UPDATE content_publish_log/i);
  });
});
