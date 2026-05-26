/**
 * 5-23 PR #239 — 阿里云数字人 GetVideoTaskInfo status 实测返回数字 (1/2/3) 不是字符串.
 * PR #238 代码只判 "SUCCESS"/"SUCCEEDED" 漏过 status=3, 导致渲染完成仍 timeout 10min fallback mock.
 * 修: 兼容字符串 + 数字双轨判断. 数字 3 视为 SUCCESS, 数字 ≥4 视为 FAILED (保守).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const QUERY = "../services/digital-human/query-task.ts";

describe("PR #239: status 数字兼容", () => {
  it("rawStatus 不做 toUpperCase, 保留数字类型", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/const rawStatus = resp\.body\?\.data\?\.status/);
    expect(src).toMatch(/const statusNum = typeof rawStatus === "number" \? rawStatus : Number\.NaN/);
  });
  it("成功条件: 字符串 SUCCESS/SUCCEEDED 或 数字 3", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/statusStr === "SUCCESS" \|\| statusStr === "SUCCEEDED" \|\| statusNum === 3/);
  });
  it("失败条件: 字符串 FAIL/FAILED/FAILURE 或 数字 >=4", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/statusStr === "FAIL" \|\| statusStr === "FAILED" \|\| statusStr === "FAILURE" \|\| \(Number\.isFinite\(statusNum\) && statusNum >= 4\)/);
  });
  it("poll 日志带 rawStatus + statusStr + statusNum (诊断)", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/status: rawStatus, statusStr, statusNum/);
  });
  it("失败 error message 带 status=<rawStatus>", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/DVH task failed: status=\$\{rawStatus\}/);
  });
});
