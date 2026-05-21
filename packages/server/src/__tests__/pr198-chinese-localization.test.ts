/**
 * 5-21 PR #198 — 正文英文中文化 (标签 + JCR 学科名). file-content regression.
 */
import { describe, it, expect } from "vitest";
async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const T = "../services/publisher/adapters/shunshi-style-template.ts";

describe("PR #198: 英文中文化", () => {
  it("JCR panel 标签中文化", async () => {
    const src = await readSrc(T);
    expect(src).toMatch(/jcrRow\("WoS 等级"/);
    expect(src).toMatch(/jcrRow\("JIF 学科分区"/);
    expect(src).toMatch(/jcrRow\("是否顶刊"/);
    expect(src).toMatch(/jcrRow\("快速通道"/);
    expect(src).not.toMatch(/jcrRow\("WoS Level"/);
  });
  it("JCR 学科名翻译映射 + 函数", async () => {
    const src = await readSrc(T);
    expect(src).toMatch(/const JCR_SUBJECT_CN/);
    expect(src).toMatch(/"MEDICINE, GENERAL & INTERNAL": "医学·综合与内科"/);
    expect(src).toMatch(/function translateJcrSubject/);
    expect(src).toMatch(/translateJcrSubject\(s\.subject\)/);
  });
});
