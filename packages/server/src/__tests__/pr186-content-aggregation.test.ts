/**
 * 5-20 PR #186 — 运营反馈 2 个功能问题:
 *   A. 今日推荐(system tenant)内容未汇入"内容管理"全部视图 → content.ts 用 READABLE_TENANT_FILTER
 *   B. 内容工坊列表项无生成时间 → ContentListItem 加 createdAt 相对时间
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #186 问题A: 内容管理汇总 user+system", () => {
  it("content.ts: GET / '全部'视图用 READABLE_TENANT_FILTER", async () => {
    const src = await readSrc("../routes/content.ts");
    // "今日推荐"仍只 system, "全部"用 READABLE_TENANT_FILTER
    expect(src).toMatch(/query\.recommendation === "true"\s*\n?\s*\?\s*eq\(contents\.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID\)\s*\n?\s*:\s*READABLE_TENANT_FILTER\(request\.tenantId\)/);
  });
  it("content.ts: stats 同步用 READABLE_TENANT_FILTER", async () => {
    const src = await readSrc("../routes/content.ts");
    expect(src).toMatch(/\.where\(READABLE_TENANT_FILTER\(request\.tenantId\)\)\s*\n?\s*\.groupBy/);
  });
});

describe("PR #186 问题B: 列表项生成时间", () => {
  it("ContentListItem: 接口加 createdAt", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/ContentListItem.tsx");
    expect(src).toMatch(/createdAt\?: string \| null/);
  });
  it("ContentListItem: relativeTime 函数 + 渲染", async () => {
    const src = await readSrc("../../../../apps/web/src/components/workbench/ContentListItem.tsx");
    expect(src).toMatch(/function relativeTime/);
    expect(src).toMatch(/分钟前|小时前/);
    expect(src).toMatch(/item\.createdAt &&/);
  });
});
