/**
 * @vitest-environment happy-dom
 *
 * PR #55：sanitize SVG 白名单 + XSS 防御单测。
 *
 * 4 类 XSS 防御 + 4 SVG 图表渲染 fixture + 现有 HTML 不破坏 + 严格 scope 验证。
 * happy-dom 提供 DOMParser，让 sanitize.ts 的 walk() 真跑（vitest 默认 node env 没 DOMParser
 * 会触发 sanitize 的 SSR fallback 直接 escapeHtml，测不到真实清洗逻辑）。
 */
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "./sanitize";

// ============ 4 类 XSS 防御 ============

describe("sanitizeHtml: SVG XSS 防御", () => {
  it("剥 <svg onload='...'> 事件处理器（svg 保留）", () => {
    const out = sanitizeHtml("<svg onload=\"alert(1)\" viewBox=\"0 0 10 10\"><rect /></svg>");
    // case-insensitive：DOMParser 在不同 env（real browser / happy-dom）保留 attr 大小写不一致
    expect(out.toLowerCase()).toContain("<svg");
    expect(out.toLowerCase()).toContain('viewbox="0 0 10 10"');
    expect(out.toLowerCase()).not.toContain("onload");
    expect(out).not.toContain("alert");
  });

  it("剥 <svg> 内嵌 <script> 标签（兄弟元素保留）", () => {
    // 注：happy-dom HTML parser 对 <svg><script>...</script>X 解析跟实浏览器有差异，
    // 把 circle 放在 script 前更稳定测得"script 被剥但 circle 保留"语义。
    const out = sanitizeHtml("<svg><circle r='5'/><script>alert(1)</script></svg>");
    expect(out.toLowerCase()).toContain("<svg");
    expect(out.toLowerCase()).toContain("<circle");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("剥 <foreignObject>（嵌入 HTML 注入向量）", () => {
    const out = sanitizeHtml("<svg><foreignObject><iframe src='evil.html'></iframe></foreignObject></svg>");
    expect(out).toContain("<svg");
    expect(out).not.toContain("foreignobject");
    expect(out).not.toContain("iframe");
  });

  it("剥 <a xlink:href='javascript:...'> SVG 链接注入", () => {
    const out = sanitizeHtml("<svg><a xlink:href=\"javascript:alert(1)\"><text>x</text></a></svg>");
    // a 标签本身被剥（不在 SVG_TAGS 白名单），text 保留
    expect(out).not.toContain("xlink");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<text");
  });

  it("剥 style 内 url(javascript:...)（现有 STYLE_DENYLIST 兜底）", () => {
    const out = sanitizeHtml('<svg style="background:url(javascript:alert(1))"><circle r="5"/></svg>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<circle");
  });
});

// ============ 4 SVG 图表 fixture 渲染 ============

describe("sanitizeHtml: 4 SVG 图表保留 (shunshi-style C.1+C.2 投资)", () => {
  it("IF 历史折线图（svg + polyline + circle × N + text + line）", () => {
    const fixture = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" width="100%" style="max-width:600px;display:block;">
      <line x1="40" y1="20" x2="40" y2="180" stroke="#ccc" stroke-width="1"/>
      <polyline fill="none" stroke="#1976D2" stroke-width="2" points="40,180 100,100 200,80 300,40 400,30"/>
      <circle cx="40" cy="180" r="3" fill="#1976D2"/>
      <circle cx="100" cy="100" r="3" fill="#1976D2"/>
      <text x="40" y="195" text-anchor="middle" font-size="11" fill="#999">2020</text>
    </svg>`;
    const out = sanitizeHtml(fixture);
    expect(out).toContain("<svg");
    expect(out).toContain("<polyline");
    expect((out.match(/<circle/g) || []).length).toBe(2);
    expect(out).toContain("<text");
    expect(out).toContain("<line");
    expect(out).toContain('points="40,180 100,100 200,80 300,40 400,30"');
    expect(out).toContain('stroke="#1976D2"');
  });

  it("CAR 折线图（含 stroke-linecap / opacity）", () => {
    const fixture = `<svg viewBox="0 0 400 150"><polyline points="0,100 100,80 200,60 300,40" stroke="red" stroke-width="2" stroke-linecap="round" opacity="0.8" fill="none"/></svg>`;
    const out = sanitizeHtml(fixture);
    expect(out).toContain("polyline");
    expect(out).toContain('stroke-linecap="round"');
    expect(out).toContain('opacity="0.8"');
  });

  it("年发文量柱状图（rect × 11 + text）", () => {
    const rects = Array.from({ length: 11 }, (_, i) =>
      `<rect x="${i * 40}" y="50" width="30" height="100" fill="#1976D2"/>`
    ).join("");
    const fixture = `<svg viewBox="0 0 500 200">${rects}<text x="250" y="190" text-anchor="middle">2024</text></svg>`;
    const out = sanitizeHtml(fixture);
    expect((out.match(/<rect/g) || []).length).toBe(11);
    expect(out).toContain("<text");
  });

  it("引用饼图（path × 6 + rect × 6 legend）", () => {
    const paths = Array.from({ length: 6 }, () => `<path d="M0,0 L10,0 A10,10 0 0,1 5,8 Z" fill="#1976D2"/>`).join("");
    const legends = Array.from({ length: 6 }, (_, i) => `<rect x="${i * 80}" y="120" width="10" height="10" fill="#999"/>`).join("");
    const fixture = `<svg viewBox="0 0 500 200">${paths}${legends}</svg>`;
    const out = sanitizeHtml(fixture);
    expect((out.match(/<path/g) || []).length).toBe(6);
    expect((out.match(/<rect/g) || []).length).toBe(6);
    expect(out).toContain('d="M0,0 L10,0 A10,10 0 0,1 5,8 Z"');
  });
});

// ============ 现有 HTML 渲染不破坏 ============

describe("sanitizeHtml: 现有 HTML 渲染回归保护", () => {
  it("section / div / p / img / span 的 inline style 保留", () => {
    const out = sanitizeHtml('<section style="margin:22px 0;"><p style="color:red">hi</p><img src="/cover.png" alt="c"/></section>');
    expect(out).toContain('<section style="margin:22px 0;"');
    expect(out).toContain('<p style="color:red"');
    expect(out).toContain("<img");
    expect(out).toContain('src="/cover.png"');
  });

  it("HTML 元素不能携带 SVG 专属属性（严格 scope 验证）", () => {
    const out = sanitizeHtml('<div fill="red" stroke="blue" d="M0,0">hi</div>');
    expect(out).not.toContain("fill=");
    expect(out).not.toContain("stroke=");
    expect(out).not.toContain('d="M0,0"');
    expect(out).toContain("hi");
  });
});
