/**
 * 5-23 PR #225 — 软化"无收录证据"prompt, 防误导"未被 SCI 收录".
 * 根因: wosLevel 字段空 (LetPub 数据未覆盖该刊) ≠ 真未被收录, 但原 prompt 强迫 AI 写"未被 SCI 收录".
 * 修: else 分支改中性, 不主动否认收录, 也不假称收录; #11 标题约束同步软化.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";

describe("PR #225: 软化无收录证据 prompt", () => {
  it("else 分支不再绝对否认 (不再'严禁称 SCI')", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).not.toMatch(/无 SCI\/SSCI\/中文核心 收录证据.{0,80}?严禁.{0,30}?称其为 "SCI 期刊"/);
  });
  it("else 分支强调'不代表未收录'+ 禁主动否认", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/不代表未收录/);
    expect(src).toMatch(/绝对不要.{0,30}?主动声称该刊"未被 SCI 收录"/);
  });
  it("else 分支仍禁假称 SCI/顶刊 (防拔高)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/不得.{0,30}?主动声称其为"SCI 期刊"/);
  });
  it("#11 标题约束软化: 没明确证据时保持中性, 不主动否定也不假称", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/我们没数据≠真未收录/);
    expect(src).not.toMatch(/无收录证据严禁写 "SCI"/);
  });
});
