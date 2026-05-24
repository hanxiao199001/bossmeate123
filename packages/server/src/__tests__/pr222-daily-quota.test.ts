/**
 * 5-23 PR #222/#223/#224 — 每日推荐可配置: 每学科篇数 (dailyQuota).
 * cron 读 SYSTEM 租户 config.automationConfig.dailyQuota 按学科配额选刊; admin 接口读写; 设置界面调.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const CRON = "../services/recommendation/daily-cron.ts";
const ADMIN = "../routes/admin.ts";
const SETTINGS = "../../../../apps/web/src/pages/SettingsPage.tsx";

describe("PR #222: cron 读每学科配额", () => {
  it("getDailyQuota 读 SYSTEM 租户 dailyQuota", async () => {
    const src = await readSrc(CRON);
    expect(src).toMatch(/export async function getDailyQuota\(\)/);
    expect(src).toMatch(/\.automationConfig\?\.dailyQuota/);
  });
  it("总数=各篇数之和; 未配置回退 BATCH_SIZE", async () => {
    const src = await readSrc(CRON);
    expect(src).toMatch(/const targetTotal = quota \? Object\.values\(quota\)\.reduce/);
    expect(src).toMatch(/: RECOMMENDATION_BATCH_SIZE;/);
  });
  it("配额模式按学科封顶 + 跳过不在配额内的学科", async () => {
    const src = await readSrc(CRON);
    expect(src).toMatch(/if \(!quota\[cat\] \|\| \(perDisc\.get\(cat\) \?\? 0\) >= quota\[cat\]\) continue;/);
    expect(src).toMatch(/perDisc\.set\(kw\.category/);
  });
});

describe("PR #223: 配置接口", () => {
  it("GET 返回配额 + 全学科; PATCH 校验 + 写 SYSTEM 租户", async () => {
    const src = await readSrc(ADMIN);
    expect(src).toMatch(/app\.get\("\/daily-recommendation-config", \{ preHandler: adminOnlyMiddleware \}/);
    expect(src).toMatch(/app\.patch\("\/daily-recommendation-config", \{ preHandler: adminOnlyMiddleware \}/);
    expect(src).toMatch(/dailyQuota: clean/);
  });
  it("校验: 单学科≤50 + 总数≤100 + 只认已知学科 code", async () => {
    const src = await readSrc(ADMIN);
    expect(src).toMatch(/Math\.min\(n, 50\)/);
    expect(src).toMatch(/total > 100/);
    expect(src).toMatch(/validCodes\.has\(k\)/);
  });
});

describe("PR #224: 设置界面", () => {
  it("每日配额区块 + 各学科输入 + 保存", async () => {
    const src = await readSrc(SETTINGS);
    expect(src).toMatch(/每日推荐数量与配额/);
    expect(src).toMatch(/handleSaveQuota/);
    expect(src).toMatch(/\/admin\/daily-recommendation-config/);
  });
});
