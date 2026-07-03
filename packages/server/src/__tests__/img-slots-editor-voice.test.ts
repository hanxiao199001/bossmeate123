/**
 * 7-03 图文模板重构 — 防回归测试
 *   ② image-slots: 图位标记替换 / 优雅降级 / 去重幂等 / 双重转义修复（纯函数单测）
 *   ① 小编口吻 prompt 区 / ④ 轮换 / ③ 红线 的 source-grep 防回归
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyImageSlots,
  applyImageSlotsFallback,
  availableImageSlots,
  buildImageSlotPromptBlock,
  fixDoubleEscapedEntities,
} from "../services/content-engine/image-slots.js";
import { recordUsage, usageCount, exhaustedKeys, resetUsageCounters } from "../services/content-engine/usage-rotation.js";
import { classifyPersonaTone } from "../services/content-engine/title-generator.js";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

const FULL_JOURNAL = {
  coverUrlHd: "https://cdn.example.com/hd.jpg",
  coverImageUrl: "https://cdn.example.com/thumb.jpg",
  ifHistory: { data: [{ year: 2022, if: 2.1 }, { year: 2023, if: 2.4 }, { year: 2024, if: 2.6 }] },
  publicationStats: { annualVolumeHistory: [{ year: 2023, count: 320 }, { year: 2024, count: 410 }] },
  casPartition: "工程技术3区",
  casPartitionNew: "3区材料科学",
  jcrFull: { jifSubjects: [{ subject: "MATERIALS SCIENCE", zone: "Q2", rank: "120/345" }] },
};

describe("7-03 B image-slots 确定性保底(只对无内建图路径)", () => {
  const textBody6 = Array.from({ length: 6 }, (_, i) => `<p>正文第${i + 1}段的一些文字内容。</p>`).join("");

  it("无图正文 + 有数据 → 规则位插入(非 cover)", () => {
    const r = applyImageSlotsFallback(textBody6, FULL_JOURNAL);
    expect(r.changed).toBe(true);
    expect(r.inserted.length).toBeGreaterThanOrEqual(1);
    expect(r.inserted).not.toContain("cover"); // cover 归 hero, 保底不插
    expect(r.body).toContain("<!--img-slot:");
  });

  it("门: 正文已含 <svg>(shunshi 内建图表) → 跳过, 不重复出图", () => {
    const r = applyImageSlotsFallback(textBody6 + `<svg width="10"></svg>`, FULL_JOURNAL);
    expect(r.changed).toBe(false);
    expect(r.inserted).toHaveLength(0);
  });

  it("门: 正文已含 <img>(封面等) → 跳过", () => {
    const r = applyImageSlotsFallback(textBody6 + `<img src="x.png"/>`, FULL_JOURNAL);
    expect(r.changed).toBe(false);
  });

  it("门: 该刊无数据图位 → 跳过", () => {
    const r = applyImageSlotsFallback(textBody6, { coverUrl: null });
    expect(r.changed).toBe(false);
  });
});

describe("7-03 ② image-slots 标记替换", () => {
  it("有数据的图位: cover 用 coverUrlHd 优先, 图表转 data URI <img>", () => {
    const body = `<p>第一段。</p><p>{{IMG:cover}}</p><p>第二段。</p><p>{{IMG:if_trend}}</p>`;
    const r = applyImageSlots(body, FULL_JOURNAL);
    expect(r.changed).toBe(true);
    expect(r.inserted).toEqual(["cover", "if_trend"]);
    expect(r.body).toContain('src="https://cdn.example.com/hd.jpg"'); // HD 优先
    expect(r.body).toContain("data:image/svg+xml");
    expect(r.body).not.toMatch(/\{\{\s*IMG/);
  });

  it("cas_table/jcr_table 渲染 HTML 表格（DB 分区字符串原文拆列）", () => {
    const body = `<p>a</p>{{IMG:cas_table}}<p>b</p>{{IMG:jcr_table}}`;
    const r = applyImageSlots(body, FULL_JOURNAL);
    expect(r.inserted).toEqual(["cas_table", "jcr_table"]);
    expect(r.body).toContain("材料科学");
    expect(r.body).toContain("Q2");
  });

  it("优雅降级: 该刊没数据的图位标记直接删除（含独占 <p> 空壳）", () => {
    const body = `<p>正文。</p><p>{{IMG:if_trend}}</p><p>尾段。</p>`;
    const r = applyImageSlots(body, { coverUrl: null }); // 全空刊
    expect(r.body).toBe(`<p>正文。</p><p>尾段。</p>`);
    expect(r.inserted).toEqual([]);
    expect(r.dropped.length).toBe(1);
  });

  it("LLM 编造的未知标记删除", () => {
    const r = applyImageSlots(`<p>x{{IMG:magic_chart}}y</p>`, FULL_JOURNAL);
    expect(r.body).toBe(`<p>xy</p>`);
    expect(r.dropped).toContain("{{IMG:magic_chart}}");
  });

  it("同一图位重复标记只出一次图; 幂等（二次调用不重复插入）", () => {
    const body = `<p>{{IMG:cover}}</p><p>中段。</p><p>{{IMG:cover}}</p>`;
    const r1 = applyImageSlots(body, FULL_JOURNAL);
    expect(r1.inserted).toEqual(["cover"]);
    expect((r1.body.match(/<!--img-slot:cover-->/g) || []).length).toBe(1);
    // pipeline 兜底二次调用: 已有签名 + 新残留标记 → 只删不重插
    const r2 = applyImageSlots(r1.body + `<p>{{IMG:cover}}</p>`, FULL_JOURNAL);
    expect((r2.body.match(/<!--img-slot:cover-->/g) || []).length).toBe(1);
  });

  it("availableImageSlots 按真实数据出清单; prompt 块无数据时为空", () => {
    expect(availableImageSlots(FULL_JOURNAL)).toEqual(["cover", "if_trend", "pub_volume", "cas_table", "jcr_table"]);
    expect(availableImageSlots({})).toEqual([]);
    expect(buildImageSlotPromptBlock({})).toBe("");
    const block = buildImageSlotPromptBlock(FULL_JOURNAL);
    expect(block).toContain("{{IMG:cover}}");
    expect(block).toContain("不同图不重复");
  });

  it("fixDoubleEscapedEntities: &amp;lt;5% / &amp;amp; 降一层, 正常文本不动", () => {
    expect(fixDoubleEscapedEntities("CAR 指数 &amp;lt;5% 为低风险")).toBe("CAR 指数 &lt;5% 为低风险");
    expect(fixDoubleEscapedEntities("A &amp;amp; B")).toBe("A &amp; B");
    expect(fixDoubleEscapedEntities("正常 &lt;5% 和 A &amp; B")).toBe("正常 &lt;5% 和 A &amp; B");
  });
});

describe("7-03 ④ usage-rotation + 人设分级", () => {
  beforeEach(() => resetUsageCounters());

  it("同 scope 计数/限次; 不同 scope 隔离", () => {
    recordUsage("batch-1", "结果前置");
    recordUsage("batch-1", "结果前置");
    expect(usageCount("batch-1", "结果前置")).toBe(2);
    expect(usageCount("batch-2", "结果前置")).toBe(0);
    expect(exhaustedKeys("batch-1", ["结果前置", "痛点提问"], 2)).toEqual(["结果前置"]);
  });

  it("classifyPersonaTone: 编辑/学术号 strict, 营销/学生号 aggressive, 无人设 default", () => {
    expect(classifyPersonaTone("资深期刊编辑老师，语气严谨")).toBe("strict");
    expect(classifyPersonaTone("研究生党嘴替，接地气爆款风")).toBe("aggressive");
    expect(classifyPersonaTone(null)).toBe("default");
  });
});

describe("7-03 ①③ source-grep 防回归", () => {
  it("article-skill prompt: 小编口吻铁律 + 排版铁律 + 图位块已注入", async () => {
    const src = await readSrc("../services/skills/article-skill.ts");
    expect(src).toMatch(/小编口吻铁律/);
    expect(src).toMatch(/每个硬数据都要带小编解读/);
    expect(src).toMatch(/禁学术论文腔/);
    expect(src).toMatch(/排版铁律/);
    expect(src).toMatch(/最多 3 句、不超过 100 字/);
    expect(src).toMatch(/buildImageSlotPromptBlock/);
    expect(src).toMatch(/applyImageSlots/);
    expect(src).toMatch(/hookScope/); // ④ 轮换接线
  });

  it("quality-pipeline: 图位替换在禁词之后、六维之前接线", async () => {
    const src = await readSrc("../services/content-engine/quality-pipeline.ts");
    const slotIdx = src.indexOf("applyImageSlots(body");
    const declicheIdx = src.indexOf("P0③ decliche pass");
    const sixDimIdx = src.indexOf("六维质检 + 定向重写闭环");
    expect(slotIdx).toBeGreaterThan(declicheIdx);
    expect(sixDimIdx).toBeGreaterThan(slotIdx);
    expect(src).toMatch(/fixDoubleEscapedEntities/);
  });

  it("六维'排版'8分描述已对齐新排版（短段落+图文交替）", async () => {
    const src = await readSrc("../services/content-engine/quality-check-v2.ts");
    expect(src).toMatch(/短段落（每段≤3句\/≤100字）\+ 图文交替/);
  });

  it("承诺性话术红线: sanitize 映射 + 审计字典已加", async () => {
    const cc = await readSrc("../services/compliance/content-check.ts");
    expect(cc).toMatch(/放心投稿/);
    expect(cc).toMatch(/必中/);
    const banned = await readSrc("../services/risk-control/dictionaries/common-banned.ts");
    expect(banned).toMatch(/"放心投稿"/);
    expect(banned).toMatch(/"闭眼投必中"/);
    expect(banned).toMatch(/"保证录用"/);
  });

  it("模板写死的'可放心投稿'渲染话术已全部清除（shunshi/journal-template/wechat-article）", async () => {
    // 注: 只查渲染字符串; 代码注释里引用旧话术做说明不算违规
    const shunshi = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(shunshi).not.toMatch(/相对安全，可放心投稿/);
    const jt = await readSrc("../services/skills/journal-template.ts");
    expect(jt).not.toMatch(/，可放心投稿。/);
    const wat = await readSrc("../services/publisher/adapters/wechat-article-template.ts");
    expect(wat).not.toMatch(/，可放心投稿。/);
  });

  it("esc() 幂等化（先解一层再转义, 防 &amp;lt; 双重转义泄漏）", async () => {
    const src = await readSrc("../services/skills/journal-template.ts");
    expect(src).toMatch(/const decoded = str/);
    expect(src).toMatch(/\.replace\(\/&amp;\/g, "&"\)/);
  });

  it("wechat adapter: <article 开头的模板 HTML 直通, 不走 Markdown 正则", async () => {
    const src = await readSrc("../services/publisher/adapters/wechat.ts");
    expect(src).toMatch(/trimmed\.startsWith\("<article"\)/);
  });
});
