/**
 * 7-10 混剪新意批次: ⑥ 片头模板池 / ⑦ 卡点转场 / ⑧ 自动封面。
 * intro-templates / beat-grid 是零依赖纯函数模块 → 直接 import 测逻辑;
 * video-remix / publisher 的接线用 readSrc 断言(与 dvh-outro-kf-qr.test.ts 同风格, 不拖 env/storage)。
 */
import { describe, it, expect } from "vitest";
import {
  pickIntroTemplate,
  buildIntroFilter,
  wrapTitle,
  wrapTitleForTemplate,
  type IntroTemplate,
} from "../services/digital-human/intro-templates.js";
import { planBrollSlots, snapToBeat } from "../services/digital-human/beat-grid.js";
import { CLIP_STYLES } from "../services/video/clip-styles.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

/** mulberry32 — 与 video-remix.rng 同实现, 保证测试跑的是同一种确定性随机 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("⑥ 片头模板池 pickIntroTemplate", () => {
  it("同 seed 同模板(确定性, 防查重属性依赖它)", () => {
    const a = pickIntroTemplate(rng(7), { hasCover: true, hasStats: true });
    const b = pickIntroTemplate(rng(7), { hasCover: true, hasStats: true });
    expect(a).toBe(b);
  });

  it("无封面只出 C/D; 无封面无数据只出 D", () => {
    for (let s = 0; s < 200; s++) {
      expect(["C", "D"]).toContain(pickIntroTemplate(rng(s), { hasCover: false, hasStats: true }));
      expect(pickIntroTemplate(rng(s), { hasCover: false, hasStats: false })).toBe("D");
    }
  });

  it("有封面无数据不出 C(数据卡没数据没意义)", () => {
    for (let s = 0; s < 200; s++) {
      expect(["A", "B"]).toContain(pickIntroTemplate(rng(s), { hasCover: true, hasStats: false }));
    }
  });

  it("clipStyle=data 偏向 C, marketing 偏向 B(加权而非独占)", () => {
    const count = (style?: string) => {
      const c: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
      for (let s = 0; s < 500; s++) c[pickIntroTemplate(rng(s), { hasCover: true, hasStats: true, clipStyle: style })]!++;
      return c;
    };
    const data = count("data"), mkt = count("marketing"), neutral = count(undefined);
    expect(data.C).toBeGreaterThan(neutral.C);
    expect(data.C).toBeGreaterThan(data.A);
    expect(mkt.B).toBeGreaterThan(neutral.B);
    expect(mkt.B).toBeGreaterThan(mkt.A);
    // 加权不是独占: 其他模板仍有出场机会
    expect(data.A + data.B).toBeGreaterThan(0);
  });
});

describe("⑥ buildIntroFilter 四套滤镜链(已在沙盒 ffmpeg 4.4.2 真烧帧验过)", () => {
  const ctx = {
    w: 1080, h: 1920, font: "/tmp/f.ttc",
    introColor: "0x1a2a6c", accentColor: "0xffd166",
    titleFile: "/tmp/t.txt", titleLines: 2, hasImage: true,
    stats: { bigFile: "/tmp/big.txt", bigText: "IF 26.3", smallFile: "/tmp/small.txt", smallText: "医学1区" },
  };
  it.each(["A", "B", "C", "D"] as IntroTemplate[])("模板 %s 输出 [1:v]→[intro] 链", (t) => {
    const chain = buildIntroFilter(t, { ...ctx, hasImage: t === "A" || t === "B" });
    expect(chain.startsWith("[1:v]")).toBe(true);
    expect(chain.endsWith("[intro];")).toBe(true);
    expect(chain).toContain("fade=t=in"); // 增强图统一 fade in
    expect(chain).toContain("settb=AVTB"); // 时间基不齐 xfade 会崩
  });
  it("A 有图 = 原版式(铺满压暗+居中标题), 保持老观感兜底", () => {
    const chain = buildIntroFilter("A", ctx);
    expect(chain).toContain("eq=brightness=-0.28");
    expect(chain).toContain("x=(w-text_w)/2");
  });
  it("B = 上 2/3 封面 + pad 色块 + 左对齐标题 + 点缀色条", () => {
    const chain = buildIntroFilter("B", ctx);
    expect(chain).toContain("pad=1080:1920:0:0:color=0x1a2a6c");
    expect(chain).toContain("drawbox");
    expect(chain).not.toContain("x=(w-text_w)/2"); // 左对齐, 非居中
  });
  it("C = 数据大字(点缀色)当主角 + 小标签 + 标题小字; 缺 stats 兜回 A", () => {
    const chain = buildIntroFilter("C", { ...ctx, hasImage: false });
    expect(chain).toContain("/tmp/big.txt");
    expect(chain).toContain("fontcolor=0xffd166");
    const fallback = buildIntroFilter("C", { ...ctx, hasImage: false, stats: undefined });
    expect(fallback).not.toContain("/tmp/big.txt"); // 兜回 A 纯色版式
  });
  it("D = 纯排版大字报 + 下划线色条(无图输入)", () => {
    const chain = buildIntroFilter("D", { ...ctx, hasImage: false });
    expect(chain).toContain("drawbox");
    expect(chain).not.toContain("force_original_aspect_ratio"); // 不吃图
  });
  it("标题断行按模板: D 每行 8 字最多 3 行(超大字不出画)", () => {
    const wrapped = wrapTitleForTemplate("D", "这本期刊的IF为什么连涨五年啊");
    expect(wrapped.split("\n").every((l) => l.length <= 8)).toBe(true);
    expect(wrapped.split("\n").length).toBeLessThanOrEqual(3);
    expect(wrapTitle("短标题", 8, 3)).toBe("短标题");
  });
});

describe("⑦ 卡点转场 beat-grid", () => {
  const beat = { origin: 2.081, beatDur: 60 / 110 };

  it("snapToBeat: nearest 落在网格上(容 toFixed(3) 毫秒级舍入); floor 只向前吸", () => {
    const s = snapToBeat(9.9, beat);
    const n = (s - beat.origin) / beat.beatDur;
    expect(Math.abs(n - Math.round(n))).toBeLessThan(2e-3);
    expect(snapToBeat(9.9, beat, 1, "floor")).toBeLessThanOrEqual(9.9);
  });

  it("传 beat: B-roll 起点全部落在整拍上, 段长为整拍数", () => {
    for (let s = 0; s < 50; s++) {
      const slots = planBrollSlots(rng(s), 60, 2.081, 3, beat);
      for (const b of slots) {
        const n = (b.start - beat.origin) / beat.beatDur;
        expect(Math.abs(n - Math.round(n))).toBeLessThan(2e-3); // toFixed(3) 存的, 容 1ms 级舍入
        const m = b.seg / beat.beatDur;
        expect(Math.abs(m - Math.round(m))).toBeLessThan(2e-3);
      }
    }
  });

  it("传 beat: 吸附后仍互不重叠且间隔 ≥4s(吸附位移 ≤ 半拍, 吃不掉 5s 预留)", () => {
    for (let s = 0; s < 50; s++) {
      const slots = planBrollSlots(rng(s), 90, 1.7, 3, beat);
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i]!.start - (slots[i - 1]!.start + slots[i - 1]!.seg)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("不传 beat = 原随机行为(位于 25%~80% 区间, 段长 2.6~3.2)", () => {
    const slots = planBrollSlots(rng(9), 60, 2, 3);
    expect(slots.length).toBeGreaterThan(0);
    for (const b of slots) {
      expect(b.start).toBeGreaterThanOrEqual(2 + 60 * 0.25);
      expect(b.start + b.seg).toBeLessThanOrEqual(2 + 60 * 0.8 + 0.001);
      expect(b.seg).toBeGreaterThanOrEqual(2.6);
      expect(b.seg).toBeLessThanOrEqual(3.2);
    }
  });

  it("clip-styles: upbeat/energetic 有 bpm, calm 系无 bpm(不卡点)", () => {
    expect(CLIP_STYLES.popsci.bpm).toBe(110);
    expect(CLIP_STYLES.marketing.bpm).toBe(128);
    expect(CLIP_STYLES.academic.bpm).toBeUndefined();
    expect(CLIP_STYLES.data.bpm).toBeUndefined();
  });
});

describe("⑧ 自动封面接线(readSrc)", () => {
  it("video-remix: 抽帧函数 + 上传 + RemixResult.coverUrl", async () => {
    const src = await readSrc("../services/digital-human/video-remix.ts");
    expect(src).toMatch(/export async function extractCoverFrame/);
    expect(src).toMatch(/dvh-videos\/cover-/);
    expect(src).toMatch(/coverUrl\?: string/);
    expect(src).toMatch(/cover_extract_failed/); // 失败兜底只 warn 不阻塞
  });
  it("admin remix 端点把 coverUrl 落 content.metadata", async () => {
    const src = await readSrc("../routes/admin.ts");
    expect(src).toMatch(/coverUrl: result\.coverUrl/);
  });
  it("publisher: 视频内容优先取 metadata.coverUrl 当发布封面", async () => {
    const src = await readSrc("../services/publisher/index.ts");
    expect(src).toMatch(/contentMeta\.coverUrl/);
  });
  it("卡点/模板接线: remixVideo 用 clipStyle 建节拍网格 + 模板池", async () => {
    const src = await readSrc("../services/digital-human/video-remix.ts");
    expect(src).toMatch(/pickIntroTemplate/);
    expect(src).toMatch(/60 \/ stylePreset\.bpm/);
    expect(src).toMatch(/planBrollSlots\(r, dur, off1, brollFiles\.length, beat\)/);
  });
});
