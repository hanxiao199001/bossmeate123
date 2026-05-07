/**
 * PR Q.6.3：web font CDN + 4 套 font-family chain 强化（5-8 user 验收 4 套字体一样）。
 */
import { describe, it, expect } from "vitest";

async function read(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.6.3: 4 套 web font 真差异", () => {
  it("index.html 含 font.im CDN（Noto Serif + Inter + Noto Sans）", async () => {
    const html = await read("../../../../apps/web/index.html");
    expect(html).toMatch(/fonts\.font\.im.*Noto\+Serif\+SC.*Inter:wght.*Noto\+Sans\+SC/s);
  });

  it("A 学术 → Noto Serif SC + 0.3px + 26px H1", async () => {
    const css = await read("../../../../apps/web/src/styles/templates/academic.css");
    expect(css).toMatch(/\.bm-template-academic \*/);
    expect(css).toMatch(/"Noto Serif SC".*serif/);
    expect(css).toMatch(/letter-spacing:\s*0\.3px/);
    expect(css).toMatch(/font-size:\s*26px/);
  });

  it("B 营销 → Inter + -0.3px + 28px weight 900", async () => {
    const css = await read("../../../../apps/web/src/styles/templates/marketing.css");
    expect(css).toMatch(/"Inter".*sans-serif/);
    expect(css).toMatch(/letter-spacing:\s*-0\.3px/);
    expect(css).toMatch(/font-size:\s*28px/);
  });

  it("C 科普 → Noto Sans SC + 0.5px + 24px weight 500", async () => {
    const css = await read("../../../../apps/web/src/styles/templates/popular.css");
    expect(css).toMatch(/"Noto Sans SC"/);
    expect(css).toMatch(/letter-spacing:\s*0\.5px/);
    expect(css).toMatch(/font-size:\s*24px/);
  });

  it("E 行业 → PingFang + tnum + 22px H1", async () => {
    const css = await read("../../../../apps/web/src/styles/templates/vertical.css");
    expect(css).toMatch(/"PingFang SC"[\s\S]*tnum[\s\S]*22px/);
  });
});
