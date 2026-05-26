/**
 * 5-23 PR #228 — 修 APC 双路径不一致 (AI 写"未公开"bug).
 * 根因: knownFields 只读 apcFee 列, enrichmentLines 读 publicationCosts.apc(JSONB); 两边不一致 → AI 困惑写"未公开".
 * 修: knownFields 兜底读 publicationCosts.apc; submissionAdvice 指令明禁模糊词.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ARTICLE = "../services/skills/article-skill.ts";

describe("PR #228: APC 双路径合一", () => {
  it("knownFields 兜底读 publicationCosts.apc (JSONB)", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/apcKnown_pc = \(journal as \{ apcFee\?: number \| null \}\)\.apcFee \?\? journal\.promptPublicationCosts\?\.apc/);
  });
  it("APC=0 视为'免费(无 APC)', 不是未知", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/免费 \(无 APC\)/);
  });
  it("submissionAdvice 指令明禁'未公开/未披露/通常较高'模糊词", async () => {
    const src = await readSrc(ARTICLE);
    expect(src).toMatch(/严禁写"未公开\/未披露\/未明确\/通常 OA 期刊版面费较高"/);
    expect(src).toMatch(/必须按该金额表述/);
  });
});
