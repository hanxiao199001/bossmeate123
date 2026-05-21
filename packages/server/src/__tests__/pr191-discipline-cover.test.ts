/**
 * 5-20 PR #191 — 学科主题题图 (替占位卡). file-content regression.
 *   封面真图补不全 (LetPub无/Springer14%) → 学科配图库, 按 discipline 渲染主题卡.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const T = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #191: 学科主题题图", () => {
  it("disciplineTheme 映射函数 (14 学科)", async () => {
    const src = await readSrc(T);
    expect(src).toMatch(/function disciplineTheme/);
    expect(src).toMatch(/医\|临床\|药\|medic/);  // 医学
    expect(src).toMatch(/计算\|信息\|软件\|comput/); // 计算机
  });
  it("renderHeroBlock 无真封面用学科主题题图", async () => {
    const src = await readSrc(T);
    expect(src).toMatch(/linear-gradient\(135deg,\$\{theme\.grad\}\)/);
    expect(src).toMatch(/\$\{theme\.icon\}/);
  });
  it("默认主题兜底 (未知学科)", async () => {
    const src = await readSrc(T);
    expect(src).toMatch(/grad: "#455A64,#B0BEC5", icon: "📖"/);
  });
});
