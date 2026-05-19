/**
 * 5-23 PR #161 — Workbench v2 多选批量发布 + 手动生成 防回归.
 * File-content regression (web 无 testing-library).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #161: backend admin endpoints + migration", () => {
  it("migrate.ts 含 content_publish_log 表 + 4 indexes (UNIQUE dedup / tenant / status / created)", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS content_publish_log/);
    expect(src).toMatch(/UNIQUE INDEX IF NOT EXISTS idx_cpl_dedup ON content_publish_log\(content_id, account_id\)/);
    expect(src).toMatch(/idx_cpl_tenant/);
    expect(src).toMatch(/idx_cpl_status/);
    expect(src).toMatch(/idx_cpl_created/);
    // status enum 用 varchar (用注释标注语义)
    expect(src).toMatch(/status VARCHAR\(20\) NOT NULL[\s\S]{0,80}success.*failed.*skipped/);
    // initiated_by 类型枚举
    expect(src).toMatch(/initiated_by VARCHAR\(20\)/);
  });

  it("schema.ts 含 contentPublishLog drizzle table (uniqueIndex on content_id,account_id)", async () => {
    const src = await readSrc("../models/schema.ts");
    expect(src).toMatch(/export const contentPublishLog\s*=\s*pgTable\(/);
    expect(src).toMatch(/uniqueIndex\("idx_cpl_dedup"\)\.on\(table\.contentId, table\.accountId\)/);
  });

  it("middleware/admin-only.ts 验 role in {owner, admin} 否则 403", async () => {
    const src = await readSrc("../middleware/admin-only.ts");
    expect(src).toMatch(/ADMIN_ROLES\s*=\s*new Set\(\[\s*"owner"\s*,\s*"admin"\s*\]\)/);
    expect(src).toMatch(/return reply\.code\(403\)/);
    expect(src).toMatch(/FORBIDDEN/);
  });

  it("routes/admin.ts: addHook preHandler adminOnlyMiddleware + 3 endpoint", async () => {
    const src = await readSrc("../routes/admin.ts");
    // 守
    expect(src).toMatch(/app\.addHook\("preHandler",\s*adminOnlyMiddleware\)/);
    // 3 endpoint
    expect(src).toMatch(/app\.post\("\/generate-article"/);
    expect(src).toMatch(/app\.post\("\/generate-video"/);
    expect(src).toMatch(/app\.post\("\/bulk-distribute"/);
    expect(src).toMatch(/app\.get\("\/bulk-distribute\/:batchId\/stream"/);
    // generate-article 调 createBatch with priority=1
    expect(src).toMatch(/createBatch\([\s\S]{0,500}priority:\s*1/);
    // generate-video 双 source
    expect(src).toMatch(/source:\s*z\.enum\(\["from_article",\s*"from_topic"\]\)/);
    // bulk-distribute 笛卡尔 ≤200 cap
    expect(src).toMatch(/MAX_CARTESIAN\s*=\s*200/);
    // SSE event-stream
    expect(src).toMatch(/text\/event-stream/);
  });

  it("services/bulk-distribute/queue.ts: 新 BullMQ queue + ProgressTracker", async () => {
    const src = await readSrc("../services/bulk-distribute/queue.ts");
    expect(src).toMatch(/new Queue\("bulk-distribute"/);
    expect(src).toMatch(/initBulkProgress/);
    expect(src).toMatch(/updateBulkProgress/);
    expect(src).toMatch(/subscribers:\s*Set/);
  });

  it("services/bulk-distribute/worker.ts: publishToAccounts(forceOverride=true) + INSERT log ON CONFLICT", async () => {
    const src = await readSrc("../services/bulk-distribute/worker.ts");
    expect(src).toMatch(/publishToAccounts\(/);
    expect(src).toMatch(/forceOverride:\s*true/);
    expect(src).toMatch(/ON CONFLICT \(content_id, account_id\) DO UPDATE/);
    expect(src).toMatch(/initiated_by/);
    expect(src).toMatch(/'bulk_distribute'/);
  });

  it("index.ts 注册 startBulkDistributeWorker + adminRoutes /admin prefix", async () => {
    const src = await readSrc("../index.ts");
    expect(src).toMatch(/startBulkDistributeWorker/);
    expect(src).toMatch(/adminRoutes[\s\S]{0,100}prefix:[\s\S]{0,30}\/admin/);
  });
});

describe("PR #161: frontend Workbench v2 多选 + 手动生成", () => {
  it("ContentListItem 加 multiSelected + onToggleSelect (不覆盖现有 selected 单选 prop)", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/ContentListItem.tsx");
    expect(src).toMatch(/multiSelected\?\s*:\s*boolean/);
    expect(src).toMatch(/onToggleSelect\?\s*:\s*\(\)\s*=>\s*void/);
    // selected (单选高亮) 仍存在
    expect(src).toMatch(/selected:\s*boolean/);
    // checkbox stopPropagation 防触发父 onClick
    expect(src).toMatch(/e\.stopPropagation\(\)/);
  });

  it("WorkbenchTopBar 含 2 个生成 button + 已选 N 篇 badge", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/WorkbenchTopBar.tsx");
    expect(src).toMatch(/\+ 生成图文/);
    expect(src).toMatch(/🎬 生成视频/);
    expect(src).toMatch(/已选 \{selectedCount\} 篇 → 批量发布/);
    expect(src).toMatch(/selectedCount > 0/);
  });

  it("ContentWorkbenchPage 接 dual mode (单选 ContentPreviewPane / 多选 BatchPreviewSummary)", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentWorkbenchPage.tsx");
    expect(src).toMatch(/isMultiSelectMode\s*=\s*selectedIds\.size\s*>\s*0/);
    expect(src).toMatch(/isMultiSelectMode \?[\s\S]{0,80}<BatchPreviewSummary/);
    expect(src).toMatch(/isMultiSelectMode \?[\s\S]{0,80}<BulkDistributeCard/);
    // admin role check (TopBar / checkbox only for admin/owner)
    expect(src).toMatch(/isAdmin\s*=[\s\S]{0,80}owner[\s\S]{0,30}admin/);
    expect(src).toMatch(/isAdmin && \(\s*<WorkbenchTopBar/);
    // 2 modal mounted
    expect(src).toMatch(/<ManualGenerateModal/);
    expect(src).toMatch(/<ManualGenerateVideoModal/);
    // POST /admin/bulk-distribute call
    expect(src).toMatch(/api\.post[\s\S]{0,100}\/admin\/bulk-distribute/);
    // SSE progress panel mounted
    expect(src).toMatch(/<BulkDistributeProgressPanel/);
  });

  it("BulkDistributeProgressPanel 用 EventSource 订阅 SSE 端点", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/BulkDistributeProgressPanel.tsx");
    expect(src).toMatch(/new EventSource\(/);
    expect(src).toMatch(/\/api\/v1\/admin\/bulk-distribute\/.*\/stream/);
    // 2 event types: progress + done
    expect(src).toMatch(/addEventListener\("progress"/);
    expect(src).toMatch(/addEventListener\("done"/);
  });

  it("ManualGenerateModal PR #173 一键 N 篇 poll batch + 进度条", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/ManualGenerateModal.tsx");
    expect(src).toMatch(/POLL_INTERVAL_MS/);
    expect(src).toMatch(/MAX_WAIT_MS/);
    // PR #173: poll 多个 batchIds
    expect(src).toMatch(/batchIds/);
    expect(src).toMatch(/completedCount/);
    // POST endpoint
    expect(src).toMatch(/api\.post[\s\S]{0,80}\/admin\/generate-article/);
    // count radio
    expect(src).toMatch(/COUNT_OPTIONS/);
  });
});
