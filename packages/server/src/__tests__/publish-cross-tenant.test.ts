/**
 * PR: publishToAccounts 跨 tenant 发布 system 推荐文章 + transitionToStatus guard。
 * - system tenant 文章可被任意 tenant 用户发布（READABLE_TENANT_FILTER 一致）
 * - guard: 非 owner 发布共享文章不改其全局 status（多用户不互相污染）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../config/system-recommendation.js", () => ({
  SYSTEM_RECOMMENDATION_TENANT_ID: "00000000-0000-0000-0000-000000000001",
}));

let contentRow: Record<string, unknown> | undefined;
let accountRows: Array<Record<string, unknown>> = [];
let selectCall = 0;
vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => {
      selectCall++;
      const rows = selectCall === 1 ? (contentRow ? [contentRow] : []) : accountRows;
      // where() 返回真 Promise（accounts 查询直接 await）+ 挂 .limit()（contents 查询用）
      const whereResult = Promise.resolve(rows) as Promise<unknown> & { limit: () => Promise<unknown> };
      whereResult.limit = () => Promise.resolve(rows);
      return { from: () => ({ where: () => whereResult }) };
    }),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  },
}));
vi.mock("../models/schema.js", () => ({
  contents: { id: "id", tenantId: "tenant_id" },
  platformAccounts: { id: "id", tenantId: "tenant_id" },
  distributionRecords: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...xs: unknown[]) => ({ and: xs }),
  or: (...xs: unknown[]) => ({ or: xs }),
}));

const publishMock = vi.fn();
vi.mock("../services/publisher/adapters/wechat.js", () => ({
  WechatAdapter: vi.fn().mockImplementation(() => ({ publish: publishMock, verifyCredentials: vi.fn() })),
}));
vi.mock("../services/publisher/credentials-loader.js", () => ({
  decryptCredentialField: () => ({ appId: "wx-test", appSecret: "secret-test" }),
  hydrateAccount: (r: unknown) => r,
}));
const transitionToStatusMock = vi.fn();
vi.mock("../services/articles/state-machine.js", () => ({
  transitionToStatus: transitionToStatusMock,
  InvalidTransitionError: class extends Error {},
}));

const { publishToAccounts } = await import("../services/publisher/index.js");

const SYSTEM_TENANT = "00000000-0000-0000-0000-000000000001";
const HANXIAO_TENANT = "4c03a3d0-cad4-4286-b14d-d6b12b6422bd";
const wechatAccount = {
  id: "acc-1", tenantId: HANXIAO_TENANT, platform: "wechat",
  accountName: "老韩很野vibecoding", credentials: "encrypted-blob", capability: "draft_only", metadata: {},
};

beforeEach(() => {
  selectCall = 0;
  contentRow = undefined;
  accountRows = [wechatAccount];
  publishMock.mockReset();
  transitionToStatusMock.mockReset();
});

describe("publishToAccounts — 跨 tenant 发布 system 推荐文章", () => {
  it("system tenant 文章 + 韩宵 (你好集团) 发布 → 成功，不抛 '内容不存在'", async () => {
    contentRow = { id: "art-sys", tenantId: SYSTEM_TENANT, type: "article", title: "推荐文章", body: "<p>正文</p>", metadata: {} };
    publishMock.mockResolvedValue({ success: true, mode: "draft_only", mediaId: "media-123" });
    const results = await publishToAccounts({ contentId: "art-sys", tenantId: HANXIAO_TENANT, accountIds: ["acc-1"] });
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.mode).toBe("draft_only");
  });

  it("guard: system 文章 full publish → transitionToStatus 不调用（非 owner 不改全局 status）", async () => {
    contentRow = { id: "art-sys", tenantId: SYSTEM_TENANT, type: "article", title: "推荐文章", body: "<p>正文</p>", metadata: {} };
    publishMock.mockResolvedValue({ success: true, mode: "full" });
    await publishToAccounts({ contentId: "art-sys", tenantId: HANXIAO_TENANT, accountIds: ["acc-1"] });
    expect(transitionToStatusMock).not.toHaveBeenCalled();
  });

  it("owner 自己 tenant 文章 full publish → transitionToStatus 正常调用", async () => {
    contentRow = { id: "art-own", tenantId: HANXIAO_TENANT, type: "article", title: "我的文章", body: "<p>正文</p>", metadata: {} };
    publishMock.mockResolvedValue({ success: true, mode: "full" });
    await publishToAccounts({ contentId: "art-own", tenantId: HANXIAO_TENANT, accountIds: ["acc-1"] });
    expect(transitionToStatusMock).toHaveBeenCalledWith("art-own", "published");
  });

  it("不存在的 contentId → 抛 '内容不存在'", async () => {
    contentRow = undefined;
    await expect(
      publishToAccounts({ contentId: "nope", tenantId: HANXIAO_TENANT, accountIds: ["acc-1"] }),
    ).rejects.toThrow("内容不存在");
  });
});
