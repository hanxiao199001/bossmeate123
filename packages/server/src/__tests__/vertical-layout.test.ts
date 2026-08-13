/**
 * 竖屏版面 + 遮挡检查（8-12）—— 锁「文字会不会挡脸」。
 *
 * 这套判据是**自校验型**：版面既然是自己算的，遮挡在合成前就能算出来，
 * 不用人脸检测、不用看成片。所以测试也能把真实病例写死成回归锁。
 */
import { describe, it, expect } from "vitest";

const L = await import("../services/digital-human/vertical-layout.js");

const PLAY_RES_Y = 288; // 与 subtitle-emphasis 同一坐标系

describe("① 病例回归：老韩截图那版参数必须判为遮挡", () => {
  /**
   * env 原值 MarginV=84 + 字号 15 + 强调 1.35。
   * `Alignment=2` 时 MarginV 量的是**底边距屏底**，文字向上长 —— 于是整块跑进人物区。
   */
  it("MarginV=84 + 2 行 + 强调 1.35 → 与人物区重叠 95%", () => {
    const box = L.textBoxForBand({ from: 0.7, to: 1 - 84 / PLAY_RES_Y }, 2, 15, PLAY_RES_Y, 1.35);
    const r = L.checkOcclusion(box);
    expect(r.ok).toBe(false);
    expect(r.hit).toBe("person");
    expect(r.overlapRatio).toBeGreaterThan(0.9);
    // 文字框顶边落在 54% 左右 —— 正对着脸
    expect(box.from).toBeLessThan(0.6);
  });

  it("解算后同样的输入 → 不再遮挡", () => {
    const s = L.solveSubtitleLayout({ fontSize: 15, marginV: 84, playResY: PLAY_RES_Y });
    expect(s.corrected).toBe(true);
    expect(s.occlusion.ok).toBe(true);
    expect(s.marginV).toBe(43); // 底边锚 85%
    expect(s.textBox.from).toBeGreaterThanOrEqual(0.69);
  });
});

describe("② 强调倍数由版面反推，不是常数", () => {
  /**
   * 🔴 写死 1.35 在当前字号下**数学上就放不进** 15% 的字幕带：
   * 2×15×1.35×1.2 = 48.6 单位 > 0.15×288 = 43.2 单位。
   * 所以它必须是算出来的 —— 否则每次调字号都可能悄悄把字幕顶进人物区。
   */
  it("字号 15 / 2 行 → 强调倍数被压到 1.2", () => {
    expect(L.emphasisScaleCap(L.ZONES.subtitleBand, 2, 15, PLAY_RES_Y)).toBe(1.2);
  });

  it("字号小到放得下时，恢复期望的 1.35", () => {
    expect(L.emphasisScaleCap(L.ZONES.subtitleBand, 2, 10, PLAY_RES_Y)).toBe(L.DESIRED_EMPHASIS_SCALE);
  });

  it("倍数永不小于 1（宁可不放大，也不缩小）", () => {
    expect(L.emphasisScaleCap(L.ZONES.subtitleBand, 4, 40, PLAY_RES_Y)).toBeGreaterThanOrEqual(1);
  });
});

describe("③ 字号上限按「N 行放得下」反推", () => {
  it("2 行时上限 = 18", () => {
    expect(L.maxFontSizeForBand(L.ZONES.subtitleBand, 2, PLAY_RES_Y)).toBe(18);
  });

  it("某条 cue 要 3 行 → 整轨字号一起降，而不是让那条溢出", () => {
    const two = L.solveSubtitleLayout({ fontSize: 15, marginV: 84, playResY: PLAY_RES_Y, linesNeeded: 2 });
    const three = L.solveSubtitleLayout({ fontSize: 15, marginV: 84, playResY: PLAY_RES_Y, linesNeeded: 3 });
    expect(three.fontSize).toBeLessThan(two.fontSize);
    expect(three.occlusion.ok).toBe(true); // 降完仍然不挡脸
    expect(three.notes.some((n) => n.includes("3 行"))).toBe(true);
  });
});

describe("④ 遮挡检查本身", () => {
  it("落在字幕带内 → 放行", () => {
    expect(L.checkOcclusion({ from: 0.72, to: 0.84 }).ok).toBe(true);
  });

  it("落在钩子大字区 → 放行（那是强调卡的合法位置）", () => {
    expect(L.checkOcclusion({ from: 0.13, to: 0.24 }).ok).toBe(true);
  });

  it("伸进平台 UI 区 → 拦截", () => {
    const r = L.checkOcclusion({ from: 0.8, to: 0.95 });
    expect(r.ok).toBe(false);
    expect(r.hit).toBe("platformUi");
  });

  it("擦边不超过 5% 容差 → 放行（避免把四舍五入判成事故）", () => {
    // 底边 85.07%（MarginV 取整到 43 的必然结果），越界 0.07% ≈ 占框高 0.5%
    expect(L.checkOcclusion({ from: 0.7007, to: 0.8507 }).ok).toBe(true);
  });

  it("人物框可按形象覆盖（③ 的接口预留）", () => {
    const standing = { x: 0, y: 0.2, w: 1, h: 0.62 }; // 站姿形象占得更高更长
    const box = { from: 0.72, to: 0.84 };
    expect(L.checkOcclusion(box).ok).toBe(true); // 默认半身像下合法
    expect(L.checkOcclusion(box, standing).ok).toBe(false); // 站姿形象下就挡了
  });
});

describe("⑤ 分区常量本身", () => {
  it("五区首尾相接、无缝无叠", () => {
    const z = [L.ZONES.topSafe, L.ZONES.hookBand, L.ZONES.personBand, L.ZONES.subtitleBand, L.ZONES.platformUi];
    expect(z[0].from).toBe(0);
    expect(z[z.length - 1].to).toBe(1);
    for (let i = 1; i < z.length; i++) expect(z[i].from).toBeCloseTo(z[i - 1].to, 6);
  });

  it("默认人物框 = 人物区", () => {
    expect(L.DEFAULT_PERSON_BOX.y).toBe(L.ZONES.personBand.from);
    expect(L.DEFAULT_PERSON_BOX.y + L.DEFAULT_PERSON_BOX.h).toBeCloseTo(L.ZONES.personBand.to, 6);
  });
});
