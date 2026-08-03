/**
 * 排版规则评分测试。
 *
 * 样本形态取自 8-02 Golden Set 里老板真实抱怨过的那几类:
 *   「排版乱」17 次 · 「排版没法看」10 次 · 「插图没有/太少/文字太密集」4 次
 * 每个用例都对应一种真实抱怨, 而不是凭空构造的 HTML。
 */
import { describe, it, expect } from "vitest";
import {
  analyzeFormatting,
  scoreFormatting,
  LONG_PARAGRAPH_CHARS,
  MAX_TEXT_RUN,
} from "../services/content-engine/formatting-metrics.js";

const CH = (n: number) => "中".repeat(n);

/** 好排版: 短段落 + 图文交替 + 小标题 + 加粗 */
const GOOD = `
<h2>一、这本刊适合谁</h2>
<p>${CH(80)}</p>
<p><strong>重点</strong>${CH(60)}</p>
<img src="a.jpg" />
<h2>二、审稿流程</h2>
<p>${CH(90)}</p>
<ul><li>${CH(20)}</li><li>${CH(20)}</li></ul>
<img src="b.jpg" />
<p>${CH(70)}</p>
`;

/** 「排版没法看」的典型: 一大坨字, 零图零小标题 */
const WALL_OF_TEXT = `<p>${CH(1200)}</p>`;

/** 「文字太密集」: 段落不算超长, 但连续十几段没有任何图 */
const NO_IMAGE_RUN = Array.from({ length: 12 }, () => `<p>${CH(120)}</p>`).join("");

describe("analyzeFormatting — 度量本身", () => {
  it("能数出段落/图片/小标题/强调", () => {
    const m = analyzeFormatting(GOOD);
    expect(m.imageCount).toBe(2);
    expect(m.headingCount).toBe(2);
    expect(m.emphasisCount).toBeGreaterThanOrEqual(1);
    expect(m.structuredBlockCount).toBeGreaterThanOrEqual(1);
    expect(m.paragraphCount).toBeGreaterThan(3);
  });

  it("能抓出超长段落(判据: 单段 >200 字)", () => {
    const m = analyzeFormatting(WALL_OF_TEXT);
    expect(m.maxParagraphChars).toBeGreaterThan(LONG_PARAGRAPH_CHARS);
    expect(m.longParagraphCount).toBe(1);
  });

  it("能抓出连续无图串(判据: 连续 4 段以上无图)", () => {
    const m = analyzeFormatting(NO_IMAGE_RUN);
    expect(m.imageCount).toBe(0);
    expect(m.maxTextRunWithoutImage).toBeGreaterThan(MAX_TEXT_RUN);
  });

  it("纯文本(无 HTML 标签)也能按空行切段 —— 生成链路两种形态都出现过", () => {
    const m = analyzeFormatting(`${CH(100)}\n\n${CH(100)}\n\n${CH(100)}`);
    expect(m.paragraphCount).toBe(3);
  });

  it("图块打断无图串: 图前后各 3 段, 最长串是 3 不是 6", () => {
    const html = `<p>${CH(50)}</p><p>${CH(50)}</p><p>${CH(50)}</p><img src="x.jpg"/><p>${CH(50)}</p><p>${CH(50)}</p><p>${CH(50)}</p>`;
    expect(analyzeFormatting(html).maxTextRunWithoutImage).toBe(3);
  });
});

describe("scoreFormatting — 打分", () => {
  it("好排版拿高分", () => {
    const r = scoreFormatting(GOOD);
    expect(r.score).toBeGreaterThanOrEqual(8);
  });

  it("🔴 一大坨字 + 零图 → 低分, 且必须低于发布线所需的 6 分", () => {
    const r = scoreFormatting(WALL_OF_TEXT);
    expect(r.score).toBeLessThan(6);
    // 可解释性是这一维改成规则的主要收益之一
    expect(r.deductions.some((d) => d.reason.includes("超过"))).toBe(true);
    expect(r.deductions.some((d) => d.reason.includes("没有一张图"))).toBe(true);
  });

  it("🔴 连续十几段无图(老板的「文字太密集」) → 扣分", () => {
    const r = scoreFormatting(NO_IMAGE_RUN);
    expect(r.score).toBeLessThan(8);
    expect(r.deductions.some((d) => d.reason.includes("没有图"))).toBe(true);
  });

  it("修改建议要能直接照做, 不是空话", () => {
    expect(scoreFormatting(WALL_OF_TEXT).fixHint).toMatch(/拆成|每段/);
    expect(scoreFormatting(NO_IMAGE_RUN).fixHint).toMatch(/图/);
  });

  it("正文过短给中性分, 不误伤(长度另有闸管)", () => {
    const r = scoreFormatting("<p>太短了</p>");
    expect(r.score).toBe(6);
  });

  it("空/null 不炸", () => {
    expect(() => scoreFormatting(null)).not.toThrow();
    expect(() => scoreFormatting("")).not.toThrow();
  });

  it("分数恒在 0-10, 与六维其余维度同尺度", () => {
    for (const html of [GOOD, WALL_OF_TEXT, NO_IMAGE_RUN, "", "<p>x</p>"]) {
      const s = scoreFormatting(html).score;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(10);
    }
  });
});
