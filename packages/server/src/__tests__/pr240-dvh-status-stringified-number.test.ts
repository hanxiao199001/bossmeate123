/**
 * 5-23 PR #240 — 阿里云 status 实测是字符串 "3" 而非数字 3.
 * PR #239 用 typeof === "number" 拿到 NaN 仍漏过. 改 Number(rawStatus) 通吃数字 + 数字字符串.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const QUERY = "../services/digital-human/query-task.ts";

describe("PR #240: status 字符串数字也要识别", () => {
  it("statusNum 用 Number(rawStatus) (兼容数字 + 数字字符串)", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/const statusNumRaw = Number\(rawStatus\)/);
    expect(src).toMatch(/Number\.isFinite\(statusNumRaw\) \? statusNumRaw : Number\.NaN/);
  });
  it("PR #240 注释解释字符串 '3' 问题", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/PR #240/);
    expect(src).toMatch(/status 是\*\*字符串\*\* "3"/);
  });
});
