/**
 * task#104 阶段2：万方 perioId 解析纯函数 + 批量选池纯函数 单测。
 *
 * 只测纯函数（parsePerioIdFromSearchHtml / extractPerioIdCandidates /
 * selectWanfangCandidates / getExistingPerioId）—— 不打网络（万方搜索端点桌面验证）。
 */
import { describe, it, expect, vi } from "vitest";

// logger 依赖 config；mock 掉避免真实 env 校验。resolver 不含 DB 依赖，纯函数可直测。
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const {
  parsePerioIdFromSearchHtml,
  extractPerioIdCandidates,
  selectWanfangCandidates,
  getExistingPerioId,
} = await import("../services/journal-enricher/fetchers/wanfang-perioid-resolver.js");

// ─────────── 合成搜索结果 HTML（med SSR 假设结构） ───────────
const SEARCH_HTML = `
<html><body>
<ul class="results">
  <li>
    <a href="/Periodical/Detail/zhyx">中华医学杂志</a>
    <span class="issn">ISSN：0376-2491</span>
  </li>
  <li>
    <a href="/Periodical/Detail/zhnk">中华内科杂志</a>
    <span class="issn">ISSN：0578-1426</span>
  </li>
  <li>
    <a href="https://med.wanfangdata.com.cn/Periodical/Detail/zhwk">中华外科杂志</a>
    <span>ISSN：0529-5815</span>
  </li>
</ul>
</body></html>
`;

// ─────────── 真实搜索结果 HTML（2026-07-16 桌面实抓 med.wanfangdata.com.cn/Periodical/Search?q=中华医学杂志，逐字节选） ───────────
//   真实格式是 href="/Periodical/{短码}"（非早前假设的 /Periodical/Detail/{id}）；anchor 文本带首尾空格（stripTags 去掉）。
const REAL_SEARCH_HTML = `<div class="classify-detail"><div class="item"><h3><span class="idx">1.</span>
<a href="/Periodical/zhyx" target="_blank"> 中华医学杂志 </a>
<span class="visible-sm-inline">中信所核心影响因子：2.123</span></h3>
<div class="keywords"><span title="中国科技论文统计源期刊(科技核心期刊) (ISTIC)">ISTIC</span></div></div>
<div class="item"><h3><span class="idx">2.</span>
<a href="/Periodical/zhcmj" target="_blank"> 中华医学杂志（英文版） </a></h3></div></div>`;

describe("extractPerioIdCandidates", () => {
  it("抠出所有 /Periodical/Detail/{perioId} 候选 + anchor 文本", () => {
    const c = extractPerioIdCandidates(SEARCH_HTML);
    expect(c.map((x) => x.perioId)).toEqual(["zhyx", "zhnk", "zhwk"]);
    expect(c[0].anchorText).toBe("中华医学杂志");
  });

  it("真实现网格式 /Periodical/{短码}：抠出 zhyx/zhcmj + perioId 反查回正确刊名", () => {
    const c = extractPerioIdCandidates(REAL_SEARCH_HTML);
    // 只应抓到两条真实期刊链接(排除 Search/其它噪音 href)
    expect(c.map((x) => x.perioId)).toEqual(["zhyx", "zhcmj"]);
    // 反查护栏: perioId ↔ 刊名一一对应, 防正则匹配到错短码/张冠李戴
    const byId = Object.fromEntries(c.map((x) => [x.perioId, x.anchorText]));
    expect(byId["zhyx"]).toBe("中华医学杂志");
    expect(byId["zhcmj"]).toBe("中华医学杂志（英文版）");
  });

  it("真实 HTML + 刊名精确 → 命中 zhyx(非英文版 zhcmj), 不张冠李戴", () => {
    const m = parsePerioIdFromSearchHtml(REAL_SEARCH_HTML, { issn: null, nameZh: "中华医学杂志" });
    expect(m).not.toBeNull();
    expect(m!.perioId).toBe("zhyx");        // 精确匹配挑中文正刊, 不是"中华医学杂志（英文版）"
    expect(m!.matchType).toBe("name_exact");
  });

  it("兼容绝对 URL + /perio/{id} 兜底形态，去重", () => {
    const html = `<a href="/perio/abc123">某刊</a><a href="/perio/abc123">重复</a>`;
    const c = extractPerioIdCandidates(html);
    expect(c).toHaveLength(1);
    expect(c[0].perioId).toBe("abc123");
  });

  it("非法 perioId（含路径穿越字符）不收", () => {
    const html = `<a href="/Periodical/Detail/../../etc">x</a>`;
    expect(extractPerioIdCandidates(html)).toHaveLength(0);
  });
});

describe("parsePerioIdFromSearchHtml — 匹配优先级", () => {
  it("ISSN 就近命中优先（最可信）", () => {
    const m = parsePerioIdFromSearchHtml(SEARCH_HTML, { issn: "0578-1426", nameZh: "无关名" });
    expect(m).toEqual({ perioId: "zhnk", matchType: "issn" });
  });

  it("无 ISSN → 刊名精确命中", () => {
    const m = parsePerioIdFromSearchHtml(SEARCH_HTML, { nameZh: "中华外科杂志" });
    expect(m).toEqual({ perioId: "zhwk", matchType: "name_exact" });
  });

  it("刊名唯一模糊包含 → name_fuzzy（兜底，标记需复核）", () => {
    // fixture 须 >200 字符(parsePerioIdFromSearchHtml 有"过短HTML=疑错误页→null"护栏, 真实搜索页恒 >200)
    const html = `<div class="classify-detail"><div class="item"><h3><span class="idx">1.</span>` +
      `<a href="/Periodical/Detail/zhek">中华儿科杂志（网络版）</a></h3>` +
      `<div class="keywords"><span title="收录">ISTIC</span> · <span>中文核心期刊要目总览</span></div>` +
      `<p class="summary">该刊为儿科领域学术期刊, 主要刊载临床与基础研究论文, 供检索与投稿参考使用。</p></div></div>`;
    const m = parsePerioIdFromSearchHtml(html, { nameZh: "中华儿科杂志" });
    expect(m).toEqual({ perioId: "zhek", matchType: "name_fuzzy" });
  });

  it("多个模糊命中 → 不猜，return null", () => {
    const html = `
      <a href="/Periodical/Detail/a1">中华医学杂志上</a>
      <a href="/Periodical/Detail/a2">中华医学杂志下</a>`;
    expect(parsePerioIdFromSearchHtml(html, { nameZh: "中华医学杂志" })).toBeNull();
  });

  it("ISSN 大小写 / X 校验位归一命中", () => {
    const html = `<li><a href="/Periodical/Detail/jx">某刊</a> <span>ISSN：1234-567X</span></li>` + "<!--pad-->".repeat(30);
    const m = parsePerioIdFromSearchHtml(html, { issn: "1234-567x" });
    expect(m).toEqual({ perioId: "jx", matchType: "issn" });
  });

  it("空 / 过短 HTML → null", () => {
    expect(parsePerioIdFromSearchHtml("", { nameZh: "x" })).toBeNull();
    expect(parsePerioIdFromSearchHtml("<html></html>", { nameZh: "x" })).toBeNull();
  });

  it("无候选链接 → null", () => {
    const html = "<html><body>没有任何期刊链接" + "x".repeat(300) + "</body></html>";
    expect(parsePerioIdFromSearchHtml(html, { issn: "0376-2491", nameZh: "中华医学杂志" })).toBeNull();
  });

  it("ISSN 未命中但刊名精确命中 → 回落刊名", () => {
    const m = parsePerioIdFromSearchHtml(SEARCH_HTML, { issn: "9999-9999", nameZh: "中华医学杂志" });
    expect(m).toEqual({ perioId: "zhyx", matchType: "name_exact" });
  });
});

// ─────────── 批量选池纯函数 ───────────
describe("getExistingPerioId", () => {
  it("取 metadata.wanfang.perioId", () => {
    expect(getExistingPerioId({ wanfang: { perioId: "zhyx" } })).toBe("zhyx");
  });
  it("缺失 / 非字符串 / 空串 → null", () => {
    expect(getExistingPerioId(null)).toBeNull();
    expect(getExistingPerioId({})).toBeNull();
    expect(getExistingPerioId({ wanfang: {} })).toBeNull();
    expect(getExistingPerioId({ wanfang: { perioId: "  " } })).toBeNull();
    expect(getExistingPerioId({ wanfang: { perioId: 123 } })).toBeNull();
  });
});

describe("selectWanfangCandidates — 选池逻辑", () => {
  const base = {
    id: "x", nameEn: null, issn: "0376-2491",
    catalogs: [], cscdLevel: null, pkuCoreLevel: null, metadata: null,
  };

  it("catalogs 非空 → 入选", () => {
    const rows = [{ ...base, name: "中华医学杂志", catalogs: ["pku-core"] }];
    expect(selectWanfangCandidates(rows).map((r) => r.id)).toEqual(["x"]);
  });

  it("cscd / pku 有标记 → 入选（即便 catalogs 空）", () => {
    // 刊名须 ≥3 字(selectWanfangCandidates 有"刊名太短没法搜→排除"护栏), 原 "刊A"/"刊B" 仅 2 字被误排
    const rows = [
      { ...base, id: "c", name: "中华刊甲", cscdLevel: "核心库" },
      { ...base, id: "p", name: "中华刊乙", pkuCoreLevel: "北大核心" },
    ];
    expect(selectWanfangCandidates(rows).map((r) => r.id).sort()).toEqual(["c", "p"]);
  });

  it("非国内刊（catalogs 空 + 无 cscd/pku）→ 排除", () => {
    const rows = [{ ...base, name: "Nature" }];
    expect(selectWanfangCandidates(rows)).toHaveLength(0);
  });

  it("已有 perioId → 断点续跑跳过", () => {
    const rows = [{ ...base, name: "中华医学杂志", catalogs: ["cscd"], metadata: { wanfang: { perioId: "zhyx" } } }];
    expect(selectWanfangCandidates(rows)).toHaveLength(0);
  });

  it("刊名太短 / 空 → 排除（没法搜）", () => {
    const rows = [
      { ...base, id: "s", name: "刊", catalogs: ["cscd"] },
      { ...base, id: "n", name: null, catalogs: ["cscd"] },
    ];
    expect(selectWanfangCandidates(rows)).toHaveLength(0);
  });
});
