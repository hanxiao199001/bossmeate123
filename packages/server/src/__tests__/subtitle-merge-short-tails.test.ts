/**
 * 字幕碎片幕合并: 切分后 <4 字的尾巴 cue 并进前一条(防"半月"两字孤零零闪一下)。
 * P0 字幕修复配套(视频线量产前)。
 */
import { describe, it, expect } from "vitest";
import { splitCues } from "../services/digital-human/subtitle-from-text.js";

describe("splitCues — 短尾碎片幕合并", () => {
  it("硬切产生的 2 字尾巴合并进前一条(不再有 <4 字碎片)", () => {
    // "审稿周期只要半月" 之类长句硬切后, "半月" 会成独立 2 字 cue
    const cues = splitCues("这本刊审稿周期特别短只要半月就能见刊真的很快");
    expect(cues.every((c) => c.length >= 4)).toBe(true); // 无 <4 字碎片
    expect(cues.join("")).toContain("半月"); // 字没丢
  });

  it("逗号切出的短尾合并", () => {
    const cues = splitCues("影响因子六点二，工程技术一区，半月");
    expect(cues.some((c) => c.length < 4)).toBe(false);
    expect(cues.join("")).toContain("半月");
  });

  it("正常长度句不受影响(≥4 字各自成条)", () => {
    const cues = splitCues("这是第一句话。这是第二句话。");
    expect(cues).toContain("这是第一句话");
    expect(cues).toContain("这是第二句话");
    expect(cues.every((c) => c.length >= 4)).toBe(true);
  });

  it("整段只有一个短句(无前驱可合并)→ 保留不丢字", () => {
    const cues = splitCues("半月");
    expect(cues).toEqual(["半月"]); // 首条无前驱, 不丢
  });

  it("多个短尾连续 → 都并进前一条正常 cue", () => {
    const cues = splitCues("录用率很高的一本好刊，快，稳，准");
    expect(cues.some((c) => c.length < 4)).toBe(false);
    // "快""稳""准" 三个单字尾都并入
    expect(cues.join("")).toContain("快稳准");
  });
});
