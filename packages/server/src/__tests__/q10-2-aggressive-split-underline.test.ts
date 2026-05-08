/**
 * PR Q.10.2：拆段 threshold 80 + strong underline 视觉信号 防回归。
 */
import { describe, it, expect } from "vitest";

async function read(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.10.2: 拆段更激进 + strong underline", () => {
  it("拆段 threshold 80 字（5-9 实测拆 2 段→期望 5-7 段）", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/inner\.length <= 80/);
    expect(src).toMatch(/buf \+ s\)\.length > 50/);
  });

  it("strong CSS 移除 background（微信 strip）改 color + underline + 1.05em", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    const stronCssRe = /<strong\\b\(\?\!\[\^>\]\*style=\)[^']+'<strong style="([^"]+)"/;
    const m = src.match(stronCssRe);
    expect(m).not.toBeNull();
    const css = m![1];
    expect(css).not.toContain("background:");
    expect(css).toContain("text-decoration:underline");
    expect(css).toContain("text-decoration-thickness:2px");
    expect(css).toContain("font-size:1.05em");
    expect(css).toContain("color:{{PRIMARY}}");
    expect(css).toContain("text-decoration-color:{{PRIMARY}}");
  });

  it("4 套 palette 占位 {{PRIMARY}} 注入 strong（shunshi 末尾 replaceAll 4 套真色）", async () => {
    const src = await read("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/replaceAll\("\{\{PRIMARY\}\}", palette\.primary\)/);
  });
});
