/**
 * draft_shortfall 趋势型判据 —— 8-24。
 *
 * 实测动机：近 30 天**告警 27 天、跨度 27 天，一天没停过**。
 * 一个每天都成立的告警就是常数判据 —— 命中率 ≈100% = 零判别力。
 *
 * 8-22 我们重写过它的文案（点名到号 + 先查存货），让它说得更准。
 * **但准和有用是两回事**：改文案 27 天后它还在天天喊。根因是判据形态，不是措辞。
 */
import { describe, it, expect } from "vitest";
import { shouldReportShortfall, SHORTFALL_QUIET_DAYS } from "../services/publisher/draft-distributor.js";

const snap = (ids: string[]) => ({ count: ids.length, ids: [...ids].sort() });
const prev = (ids: string[], ageDays: number) => ({ snap: snap(ids), ageDays });

describe("① 缺口扩大 → 报", () => {
  it("2 个号变 3 个号", () => {
    const v = shouldReportShortfall(snap(["a", "b", "c"]), prev(["a", "b"], 1));
    expect(v.report).toBe(true);
    expect(v.trend).toBe("worse");
  });
});

describe("② 某个号从达标变成不达标 → 报（即使总数没变）", () => {
  it("a,b → a,c：总数都是 2，但 c 是新的", () => {
    const v = shouldReportShortfall(snap(["a", "c"]), prev(["a", "b"], 1));
    expect(v.report).toBe(true);
    expect(v.trend).toBe("new_account");
  });
});

describe("🔴 ③ 无变化 → 不报，但每 7 天汇总一次（降频，不静默）", () => {
  it("同一批号、1 天前报过 → 不报", () => {
    const v = shouldReportShortfall(snap(["a", "b"]), prev(["a", "b"], 1));
    expect(v.report).toBe(false);
    expect(v.trend).toBe("unchanged");
  });

  it(`同一批号、满 ${SHORTFALL_QUIET_DAYS} 天 → 汇总报一次`, () => {
    const v = shouldReportShortfall(snap(["a", "b"]), prev(["a", "b"], SHORTFALL_QUIET_DAYS));
    expect(v.report).toBe(true);
    expect(v.trend).toBe("weekly_digest");
  });

  it("🔴 长期未解决的问题不许彻底消失 —— 汇总周期到了必须重新出现", () => {
    // 否则它会被完全遗忘。从每日降级为每周，是"保留存在感但不消耗每天的注意力"，
    // 不是"让它闭嘴"。
    expect(shouldReportShortfall(snap(["a"]), prev(["a"], 30)).report).toBe(true);
  });
});

describe("缺口收窄 → 不报（只禁变差，不禁变好）", () => {
  it("3 个号变 1 个号，且是原集合的子集", () => {
    const v = shouldReportShortfall(snap(["a"]), prev(["a", "b", "c"], 1));
    expect(v.report).toBe(false);
    expect(v.trend).toBe("unchanged");
  });
});

describe("🔴 首次 / 读不到上次状态 → 报（不许静默）", () => {
  it("prev=null → 报", () => {
    // 查不到上次状态 ≠ 没有缺口。查询挂了就退回"报"，
    // 宁可多报一次也不静默（红线 #23：检查器自己挂了不许当作"没问题"）。
    const v = shouldReportShortfall(snap(["a", "b"]), null);
    expect(v.report).toBe(true);
    expect(v.trend).toBe("first");
  });
});
