/**
 * 5-23 PR #219 — 修批量发布"SSE 连接断开".
 * 根因: EventSource 不能带 Authorization 头, @fastify/jwt 只认 Bearer 头 → SSE 必 401 断连.
 * 修: 后端加 GET /admin/bulk-distribute/:batchId 普通状态接口; 前端从 EventSource 改 1.5s 轮询(api.get 带 Bearer).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const ADMIN = "../routes/admin.ts";
const PANEL = "../../../../apps/web/src/components/workbench/BulkDistributeProgressPanel.tsx";

describe("PR #219: 后端轮询状态接口", () => {
  it("新增 GET /bulk-distribute/:batchId (非 stream), admin 守卫", async () => {
    const src = await readSrc(ADMIN);
    expect(src).toMatch(/app\.get\("\/bulk-distribute\/:batchId", \{ preHandler: adminOnlyMiddleware \}/);
  });
  it("返回 finished + durationMs (前端据此判完成)", async () => {
    const src = await readSrc(ADMIN);
    expect(src).toMatch(/const finished = !!progress\.finishedAt/);
    expect(src).toMatch(/durationMs: finished \? progress\.finishedAt! - progress\.startedAt : null/);
  });
  it("SSE stream 路由仍保留 (不删, 只是前端不用了)", async () => {
    const src = await readSrc(ADMIN);
    expect(src).toMatch(/app\.get\("\/bulk-distribute\/:batchId\/stream"/);
  });
});

describe("PR #219: 前端改轮询 (弃用 EventSource)", () => {
  it("不再用 EventSource", async () => {
    const src = await readSrc(PANEL);
    expect(src).not.toMatch(/new EventSource/);
  });
  it("用 api.get 轮询状态接口 + 1.5s 间隔", async () => {
    const src = await readSrc(PANEL);
    expect(src).toMatch(/api\.get<[\s\S]*?>\(\s*`\/admin\/bulk-distribute\/\$\{batchId\}`/);
    expect(src).toMatch(/setTimeout\(poll, 1500\)/);
  });
  it("finished 时设 done 并停止轮询", async () => {
    const src = await readSrc(PANEL);
    expect(src).toMatch(/if \(d\.finished\)/);
    expect(src).toMatch(/return; \/\/ 完成, 停止轮询/);
  });
  it("连续失败才报错 (容忍偶发抖动)", async () => {
    const src = await readSrc(PANEL);
    expect(src).toMatch(/if \(errCount >= 5\)/);
  });
});
