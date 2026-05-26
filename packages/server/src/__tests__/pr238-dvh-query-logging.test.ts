/**
 * 5-23 PR #238 — DVH query 加中间状态日志 + 延 timeout 到 10min.
 * 之前 5min timeout 后 fallback mock 看不到任务实际 status. 加 poll 中间状态 + 失败原因日志.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const QUERY = "../services/digital-human/query-task.ts";

describe("PR #238: DVH query 加日志 + 延 timeout", () => {
  it("POLL_TIMEOUT_MS 延到 10min", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/const POLL_TIMEOUT_MS = 10 \* 60 \* 1000/);
  });
  it("加 poll 中间状态日志 (status 变或每 30s)", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/dvh\.query\.poll/);
    expect(src).toMatch(/status !== lastStatus \|\| pollCount % 6 === 0/);
  });
  it("API 失败 + 任务失败 + timeout 各加专属日志", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/dvh\.query\.api_failed/);
    expect(src).toMatch(/dvh\.query\.task_failed/);
    expect(src).toMatch(/dvh\.query\.timeout/);
  });
  it("timeout 错误带 lastStatus + pollCount (诊断)", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/lastStatus=\$\{lastStatus\} polls=\$\{pollCount\}/);
  });
});
