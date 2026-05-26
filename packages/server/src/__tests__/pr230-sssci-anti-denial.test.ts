/**
 * 5-23 PR #230 — 修 SSCI 收录刊被写"未被 SSCI 收录" bug.
 * 根因: PR #207 反否定 scieNote 正则 /\bSCIE?\b/ 不匹配 SSCI, 这类刊未拿到防否定约束.
 * 修: 正则扩到 SCIE/SSCI/AHCI/ESCI; 措辞强化为通用"绝对禁止写'未被 X 收录'"等否定句.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";

describe("PR #230: SSCI/AHCI/ESCI 反否定", () => {
  it("正则扩到 4 类 WOS 等级", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/\\b\(SCIE\|SSCI\|AHCI\|ESCI\)\\b/);
  });
  it("强力禁'未被 X 收录'/'未被 SSCI 收录'等否定句", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/绝对禁止.{0,40}?"未被 SCI 收录"\/"未被 SSCI 收录"\/"非 SCI 期刊"\/"非 SSCI 期刊"/);
  });
  it("禁'投稿前请确认单位/学校是否认可'这种暗示未收录话术", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/投稿前请确认单位\/学校是否认可此类期刊/);
  });
});
