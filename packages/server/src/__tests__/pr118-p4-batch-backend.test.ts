/**
 * PR #118 P4 批量 csv 导入 backend Day 1 单元测试 + 静态校验。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(48), LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", DATABASE_URL: "postgres://t/t" },
}));

const { parseCsv, buildReportCsv } = await import("../services/batch/csv-parser.js");

describe("PR #118 csv-parser: 解析 utf-8 BOM csv", () => {
  it("正常 4 列 csv 全 OK", () => {
    const csv = `topic,journal_id,template,priority\n"AI 医学影像",b3849878-a6b5-468f-86e2-063aaf59ac46,A,5\n"心肌梗死",,B,3\n"NLP 综述",,,2`;
    const r = parseCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ rowIndex: 1, topic: "AI 医学影像", template: "A", priority: 5 });
    expect(r.rows[0].journalId).toBe("b3849878-a6b5-468f-86e2-063aaf59ac46");
    expect(r.rows[1].journalId).toBe(null);
    expect(r.rows[1].template).toBe("B");
    expect(r.rows[2].priority).toBe(2);
    expect(r.rows[2].template).toBe(null);
  });

  it("UTF-8 BOM 兼容（Excel 导出）", () => {
    const csv = `﻿topic\n"BOM 测试"`;
    const r = parseCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].topic).toBe("BOM 测试");
  });

  it("topic 必填 — 空 topic 进 errors", () => {
    const csv = `topic,template\n,A\n"valid",B`;
    const r = parseCsv(csv);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/topic 必填/);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].topic).toBe("valid");
  });

  it("topic 100 字超 → errors", () => {
    const longTopic = "x".repeat(101);
    const csv = `topic\n${longTopic}`;
    const r = parseCsv(csv);
    expect(r.errors[0].message).toMatch(/超过 100 字/);
  });

  it("journal_id 非 UUID → errors", () => {
    const csv = `topic,journal_id\n"x",not-a-uuid`;
    const r = parseCsv(csv);
    expect(r.errors[0].message).toMatch(/journal_id 不是合法 UUID/);
  });

  it("template 必须 A/B/C/E", () => {
    const csv = `topic,template\n"x",Z`;
    const r = parseCsv(csv);
    expect(r.errors[0].message).toMatch(/template 必须 A\/B\/C\/E/);
  });

  it("priority 必须 1-5 整数", () => {
    expect(parseCsv(`topic,priority\n"x",6`).errors[0].message).toMatch(/priority 必须 1-5/);
    expect(parseCsv(`topic,priority\n"x",0`).errors[0].message).toMatch(/priority 必须 1-5/);
    expect(parseCsv(`topic,priority\n"x",abc`).errors[0].message).toMatch(/priority 必须 1-5/);
  });

  it("缺 priority 默认 3 (normal)", () => {
    const r = parseCsv(`topic\n"x"`);
    expect(r.rows[0].priority).toBe(3);
  });
});

describe("PR #118 csv-parser: buildReportCsv", () => {
  it("生成 utf-8 BOM csv 含 5 列 + 行", () => {
    const csv = buildReportCsv([
      { rowIndex: 1, topic: 'AI"医学', status: "generated", articleId: "a-1", errorMessage: null },
      { rowIndex: 2, topic: "失败例子", status: "failed", articleId: null, errorMessage: "LLM timeout" },
    ]);
    expect(csv.startsWith("﻿")).toBe(true); // BOM
    expect(csv).toMatch(/row,topic,status,article_id,error/);
    expect(csv).toMatch(/AI""医学/); // " 转义
    expect(csv).toMatch(/generated.*a-1/);
    expect(csv).toMatch(/LLM timeout/);
  });
});

describe("PR #118 schema + migration", () => {
  it("schema.ts 含 batches + batchRows pgTable export", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../models/schema.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export const batches = pgTable/);
    expect(src).toMatch(/export const batchRows = pgTable/);
    expect(src).toMatch(/PR #118.*P4 批量 csv/);
  });

  it("migrate.ts 含 CREATE TABLE batches + batch_rows + 4 INDEX", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../models/migrate.ts", import.meta.url), "utf8");
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS batches/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS batch_rows/);
    expect(src).toMatch(/idx_batches_tenant/);
    expect(src).toMatch(/idx_batches_status/);
    expect(src).toMatch(/idx_batch_rows_batch/);
    expect(src).toMatch(/idx_batch_rows_status/);
  });
});

describe("PR #118 worker + queue 静态校验", () => {
  it("queue.ts 含 BATCH_WORKER_CONCURRENCY=5 + 指数退避 30s/2min/5min", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/batch/queue.ts", import.meta.url), "utf8");
    expect(src).toMatch(/BATCH_WORKER_CONCURRENCY\s*=\s*5/);
    expect(src).toMatch(/BATCH_RETRY_DELAYS_MS\s*=\s*\[30_000,\s*120_000,\s*300_000\]/);
    expect(src).toMatch(/BATCH_MAX_AUTO_RETRY\s*=\s*3/);
  });

  it("batch-worker.ts 含 transitionStatus 完整链路（draft/generating/generated/failed）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/batch/batch-worker.ts", import.meta.url), "utf8");
    expect(src).toMatch(/initialStatusFields\("draft"\)/);
    expect(src).toMatch(/transitionStatus\(content\.id,\s*"draft",\s*"generating"\)/);
    expect(src).toMatch(/transitionStatus\(content\.id,\s*"generating",\s*"generated"\)/);
    expect(src).toMatch(/transitionStatus\(content\.id,\s*"generating",\s*"failed"/);
    // 自动 retry 含 failed → generating 转移
    expect(src).toMatch(/transitionStatus\(content\.id,\s*"failed",\s*"generating"\)/);
  });

  it("batch-worker 含自动 retry 指数退避 + retry 上限校验", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/batch/batch-worker.ts", import.meta.url), "utf8");
    expect(src).toMatch(/autoRetryCount\s*<\s*BATCH_MAX_AUTO_RETRY/);
    expect(src).toMatch(/BATCH_RETRY_DELAYS_MS\[autoRetryCount\]/);
  });

  it("batch-service.ts 含 createBatch / getBatchStatus / retryRow / recomputeBatchProgress", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/batch/batch-service.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export async function createBatch/);
    expect(src).toMatch(/export async function getBatchStatus/);
    expect(src).toMatch(/export async function retryRow/);
    expect(src).toMatch(/export async function recomputeBatchProgress/);
    expect(src).toMatch(/export async function updateRowProgress/);
  });
});

describe("PR #118 routes/batch.ts 静态校验", () => {
  it("含 4 endpoints + multipart upload + tenant 校验", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/batch.ts", import.meta.url), "utf8");
    expect(src).toMatch(/post\("\/batch\/upload"/);
    expect(src).toMatch(/get\("\/batch\/:id"/);
    expect(src).toMatch(/get\("\/batch\/:id\/report"/);
    expect(src).toMatch(/post\("\/batch\/:id\/retry\/:rowId"/);
    expect(src).toMatch(/request\.file\(\)/); // multipart
    expect(src).toMatch(/MAX_CSV_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
    expect(src).toMatch(/MAX_ROWS\s*=\s*500/);
  });
});

describe("PR #118 boot 接入", () => {
  it("index.ts 含 batchRoutes 注册 + startBatchWorker", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/batchRoutes/);
    expect(src).toMatch(/startBatchWorker/);
  });
});
