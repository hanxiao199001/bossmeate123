/**
 * P0四件套③ decliche 单测：命中 / 不误伤 / 连排组合检测 / LLM 失败兜底
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "test-jwt-secret-key-for-testing-12345678",
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    ARTICLE_DECLICHE: "true",
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const chatMock = vi.fn();
vi.mock("../services/ai/chat-service.js", () => ({ chat: (...a: unknown[]) => chatMock(...a) }));

const { detectCliches, removeCliches, extractProseSegments, replaceSegments, looksLikeHtml } =
  await import("../services/content-engine/decliche.js");

describe("detectCliches", () => {
  it("命中典型 AI 腔套话（总之/综上所述/在当今/赋能）", () => {
    const text = "在当今学术竞争激烈的环境下，选刊很重要。AI 工具能赋能科研人。综上所述，早投早安心。总之，选对刊事半功倍。";
    const hits = detectCliches(text);
    const names = hits.map((h) => h.name);
    expect(names).toContain("在当今");
    expect(names).toContain("赋能");
    expect(names).toContain("综上所述");
    expect(names).toContain("总之");
    // 位置信息可用于定位段落
    for (const h of hits) {
      expect(h.index).toBeGreaterThanOrEqual(0);
      expect(text.slice(h.index).startsWith(h.match.slice(0, 2))).toBe(true);
    }
  });

  it("命中'随着…的发展'句式（正则模糊匹配）", () => {
    const hits = detectCliches("随着人工智能技术的发展，论文产出效率大幅提升。");
    expect(hits.some((h) => h.name === "随着…的发展")).toBe(true);
  });

  it("不误伤正常表达（干净文本零命中）", () => {
    const clean =
      "这本刊 2024 年影响因子 5.1，中科院 2 区。审稿周期约 6 周，版面费 2000 美元。做肿瘤方向、赶毕业的同学可以优先考虑，先查最近三期的收稿方向再动手。";
    expect(detectCliches(clean)).toEqual([]);
  });

  it("不误伤：单独出现'首先'或一两次'不仅…还'不算命中", () => {
    const text = "首先要确认期刊的收稿范围。这本刊不仅审稿快，还对国人友好。";
    const hits = detectCliches(text);
    expect(hits.some((h) => h.name === "首先/其次/最后连排")).toBe(false);
    expect(hits.some((h) => h.name === "不仅…还…滥用")).toBe(false);
  });

  it("连排检测：首先…其次…最后 按序全出现才命中", () => {
    const text = "首先，要看分区。其次，要看审稿周期。最后，要看版面费。";
    const hits = detectCliches(text);
    expect(hits.some((h) => h.name === "首先/其次/最后连排")).toBe(true);
  });

  it("滥用检测：'不仅…还' 出现 3 次即命中", () => {
    const text =
      "这本刊不仅审稿快，还免版面费。它不仅分区稳定，还对新人友好。编辑部不仅回复及时，还会给修改意见。";
    const hits = detectCliches(text);
    const hit = hits.find((h) => h.name === "不仅…还…滥用");
    expect(hit).toBeTruthy();
    expect(hit!.match).toContain("3");
  });

  it("空文本返回空数组", () => {
    expect(detectCliches("")).toEqual([]);
  });
});

describe("extractProseSegments / replaceSegments", () => {
  it("markdown 按空行切段并保留偏移", () => {
    const md = "第一段内容。\n\n第二段内容。\n\n第三段内容。";
    const segs = extractProseSegments(md);
    expect(segs.length).toBe(3);
    expect(md.slice(segs[1].start, segs[1].end)).toBe("第二段内容。");
  });

  it("HTML 只取 <p>/<li> 等正文块，不碰其它标签", () => {
    const html = `<article><div style="color:red">数据卡</div><p>正文段落一。</p><li>列表项</li></article>`;
    expect(looksLikeHtml(html)).toBe(true);
    const segs = extractProseSegments(html);
    expect(segs.length).toBe(2);
    expect(segs[0].text).toBe("<p>正文段落一。</p>");
  });

  it("replaceSegments 从后往前替换不串位", () => {
    const md = "AAA\n\nBBB\n\nCCC";
    const segs = extractProseSegments(md);
    const out = replaceSegments(md, [
      { seg: segs[0], newText: "aaaa" },
      { seg: segs[2], newText: "cc" },
    ]);
    expect(out).toBe("aaaa\n\nBBB\n\ncc");
  });

  // 7-03 回归: 图位段(<img>/<!--img-slot-->)不进改写候选, 否则段落级重写/去AI腔会吞掉图文交替排版
  it("排除含 <img> / <!--img-slot--> 的段落，只留纯文字正文段", () => {
    const html = `<p>正文一。</p><p><!--img-slot:if_trend--><img src="data:image/svg+xml;base64,AAAA"/></p><p>正文二。</p><p><img src="x.png"/></p>`;
    const segs = extractProseSegments(html);
    expect(segs.length).toBe(2);
    expect(segs.map((s) => s.text)).toEqual(["<p>正文一。</p>", "<p>正文二。</p>"]);
  });

  it("图位段被排除后, replaceSegments 只改文字段, 图位在 body 原样保留", () => {
    const html = `<p>弱段要改。</p><p><img src="data:image/svg+xml;base64,ZZZ"/></p><p>另一段。</p>`;
    const segs = extractProseSegments(html);
    const out = replaceSegments(html, [{ seg: segs[0], newText: "<p>改后的强段。</p>" }]);
    expect(out).toContain(`<img src="data:image/svg+xml;base64,ZZZ"/>`);
    expect(out).toContain("<p>改后的强段。</p>");
    expect(out).not.toContain("弱段要改");
  });
});

describe("removeCliches", () => {
  it("零命中时不发 LLM 调用，原文返回", async () => {
    chatMock.mockClear();
    const clean = "这本刊 IF 5.1，审稿 6 周，赶毕业可以冲。";
    const r = await removeCliches(clean, { tenantId: "t1" });
    expect(r.text).toBe(clean);
    expect(r.rewritten).toBe(false);
    expect(r.llmCalls).toBe(0);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("命中时只把命中段落送 LLM，按编号拼回", async () => {
    const dirty = "这本刊 IF 5.1，审稿 6 周。\n\n总之，综上所述，值得投稿。\n\n版面费 2000 美元。";
    chatMock.mockResolvedValueOnce({ content: `{"1":"一句话：值得投。"}` });
    const r = await removeCliches(dirty, { tenantId: "t1" });
    expect(r.rewritten).toBe(true);
    expect(r.llmCalls).toBe(1);
    expect(r.text).toContain("一句话：值得投。");
    // 未命中段落必须原样保留
    expect(r.text).toContain("这本刊 IF 5.1，审稿 6 周。");
    expect(r.text).toContain("版面费 2000 美元。");
    // 只送了命中段（prompt 里不含干净段）
    const sentPrompt = (chatMock.mock.calls[0][0] as { message: string }).message;
    expect(sentPrompt).toContain("总之");
    expect(sentPrompt).not.toContain("版面费 2000 美元");
  });

  it("LLM 失败兜底：返回原文不 throw", async () => {
    const dirty = "总之，这本刊值得投。";
    chatMock.mockRejectedValueOnce(new Error("LLM down"));
    const r = await removeCliches(dirty, { tenantId: "t1" });
    expect(r.text).toBe(dirty);
    expect(r.rewritten).toBe(false);
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("LLM 输出异常（吞段/超长）时弃用改写，保留原文", async () => {
    const dirty = "总之，这一段有五十个字左右的正文内容，讲的是期刊投稿的建议和数据分析结论。";
    chatMock.mockResolvedValueOnce({ content: `{"1":"短"}` }); // 长度 < 原段 40% → 弃用
    const r = await removeCliches(dirty, { tenantId: "t1" });
    expect(r.text).toBe(dirty);
    expect(r.rewritten).toBe(false);
  });
});
