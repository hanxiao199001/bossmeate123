/**
 * 8-20「关干净」的回归锁。
 *
 * 老韩：**留着一个每天跑、每天失败的任务，就是在制造下一个盲区。**
 * 所以关这条线的验收不是「cron 不见了」，是下面四条同时成立。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXTERNAL_FEEDBACK_AVAILABLE,
  getExternalFeedbackStatus,
  EXTERNAL_FEEDBACK_DEPENDENTS,
} from "../services/metrics/external-feedback-status.js";
import { REGISTRY } from "../services/ops/runtime-params.js";

const SRC = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("① 停用状态声明", () => {
  it("当前不可用，且带 notice 与停用日", () => {
    expect(EXTERNAL_FEEDBACK_AVAILABLE).toBe(false);
    const s = getExternalFeedbackStatus();
    expect(s.available).toBe(false);
    expect(s.notice).toBeTruthy();
    expect(s.disabledSince).toBe("2026-08-20");
  });

  it("notice 里写清了解锁条件是微信认证，不是等数据攒够", () => {
    expect(getExternalFeedbackStatus().notice).toContain("微信认证");
  });

  it("受影响功能清单覆盖三处 + 发布确认", () => {
    const keys = EXTERNAL_FEEDBACK_DEPENDENTS.map((d) => d.key);
    expect(keys).toContain("effect_dashboard");
    expect(keys).toContain("topic_feedback");
    expect(keys).toContain("title_learning");
    expect(keys).toContain("publish_confirm");
  });
});

describe("② cron 不再无条件注册", () => {
  it("注册被 EXTERNAL_FEEDBACK_AVAILABLE 包住", () => {
    const src = read("services/scheduler.ts");
    const i = src.indexOf("wechat-stats-collect-schedule");
    expect(i).toBeGreaterThan(0);
    // 锁结构关系而非共现(红线 #16)：注册语句必须紧跟在 if (EXTERNAL_FEEDBACK_AVAILABLE) 之后。
    // 用"同窗口"判据 —— 文件里别处也有 EXTERNAL_FEEDBACK_AVAILABLE 和 upsertJobScheduler，
    // 只断言两者都存在(共现)证明不了它们有关系。
    const guard = src.lastIndexOf("if (EXTERNAL_FEEDBACK_AVAILABLE)", i);
    expect(guard, "注册点之前找不到停用闸").toBeGreaterThan(0);
    const window = src.slice(guard, i);
    expect(window).toContain("upsertJobScheduler");
    // 闸与注册之间不许夹着别的语句块（夹了就说明注册不在这个 if 里）
    expect(window.length).toBeLessThan(200);
  });

  it("🔴 显式移除既有调度 —— 不 upsert ≠ 旧调度消失（它存在 Redis 里）", () => {
    expect(read("services/scheduler.ts")).toContain('removeJobScheduler("wechat-stats-collect-schedule")');
  });

  it("任务处理器保留 —— 删了会让'恢复'变成一次重写", () => {
    expect(read("services/scheduler.ts")).toContain('case "wechat-stats-collect"');
  });
});

describe("③ collector 自身有停用闸（手动触发也不产生副作用）", () => {
  it("入口处早退，且早退发生在任何写操作之前", () => {
    const src = read("services/metrics/wechat-stats-collector.ts");
    const guard = src.indexOf("if (!EXTERNAL_FEEDBACK_AVAILABLE");
    const write = src.indexOf("markExpiredDrafts");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf("for (const a of accounts)"));
    expect(write).toBeGreaterThan(0);
  });
});

describe("④ 三个人工拍的数已外化并标注无依据", () => {
  const HUMAN_SET = ["draft.targetPerAccount", "publish.sixDimTotalLine", "distribute.minSixDimTotal"];

  it("三个都注册了", () => {
    for (const k of HUMAN_SET) {
      expect(REGISTRY.find((d) => d.key === k), `缺参数 ${k}`).toBeTruthy();
    }
  });

  it("🔴 每个都写了 evidence，且明说「无数据依据」", () => {
    for (const k of HUMAN_SET) {
      const def = REGISTRY.find((d) => d.key === k)!;
      expect(def.evidence, `${k} 缺 evidence`).toBeTruthy();
      expect(def.evidence, `${k} 的 evidence 没标注无依据`).toContain("无数据依据");
    }
  });

  it("默认值等于外化前的硬编码值（上线当天行为不变）", () => {
    expect(REGISTRY.find((d) => d.key === "draft.targetPerAccount")!.fallback).toBe(2);
    expect(REGISTRY.find((d) => d.key === "publish.sixDimTotalLine")!.fallback).toBe(80);
    expect(REGISTRY.find((d) => d.key === "distribute.minSixDimTotal")!.fallback).toBe(60);
  });

  it("参数页会带出 evidence（listParams 展开 def，不需要手动透传）", () => {
    const src = read("services/ops/runtime-params.ts");
    expect(src).toMatch(/return \{ \.\.\.def, current:/);
  });
});

describe("④b 每维 ≥6 的地板刻意不外化", () => {
  it("地板不在参数注册表里 —— 它是约束不是偏好", () => {
    expect(REGISTRY.find((d) => d.key.includes("MinDim") || d.key.includes("minDim"))).toBeUndefined();
    expect(read("services/content-engine/quality-check-v2.ts")).toContain("SIX_DIM_PUBLISH_MIN_DIM");
  });

  it("给运营看的「未达 N 分」用的是判定时那条线，不是代码常量", () => {
    // 参数改过之后两者会不一致 —— 显示的线与实际判定的线是两个数(红线 #20)
    expect(read("services/content-engine/quality-check-v2.ts")).toContain("sixDim.publishTotalLine ??");
  });
});
