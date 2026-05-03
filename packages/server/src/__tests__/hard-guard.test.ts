/** B.3: hard guard 4 类 ×3 + whitelist 跳过 = 13 unit。 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://test/test" } }));
const dbMock = { rows: [] as { pattern: string }[] };
vi.mock("../models/db.js", () => ({
  db: { select: () => ({ from: () => ({ where: async () => dbMock.rows }) }) },
}));

const { hardGuardCheck, clearWhitelistCache, HARD_GUARD_PATTERNS } = await import("../services/sales/hard-guard.js");

const TENANT = "11111111-2222-3333-4444-555555555555";

beforeEach(() => { dbMock.rows = []; clearWhitelistCache(); });

describe("hard guard 4 类硬规则", () => {
  describe("quote 报价类 ×3", () => {
    it("命中「多少钱」", async () => expect((await hardGuardCheck("这个版面多少钱", TENANT)).category).toBe("quote"));
    it("命中「报价」", async () => expect((await hardGuardCheck("能给个报价吗", TENANT)).category).toBe("quote"));
    it("命中「多少 USD」", async () => expect((await hardGuardCheck("国际版多少 USD", TENANT)).category).toBe("quote"));
  });
  describe("contract 合同类 ×3", () => {
    it("命中「合同」", async () => expect((await hardGuardCheck("发份合同我看下", TENANT)).category).toBe("contract"));
    it("命中「盖章」", async () => expect((await hardGuardCheck("能盖章吗", TENANT)).category).toBe("contract"));
    it("命中「甲乙双方」", async () => expect((await hardGuardCheck("甲乙双方需要怎么定", TENANT)).category).toBe("contract"));
  });
  describe("legal 法律担保类 ×3", () => {
    it("命中「包过」", async () => expect((await hardGuardCheck("能包过吗", TENANT)).category).toBe("legal"));
    it("命中「100%」", async () => expect((await hardGuardCheck("100% 录用？", TENANT)).category).toBe("legal"));
    it("命中「退款」", async () => expect((await hardGuardCheck("不行就退款", TENANT)).category).toBe("legal"));
  });
  describe("deadline 时效承诺类 ×3", () => {
    it("命中「几天 + 出刊」", async () => expect((await hardGuardCheck("几天能出刊", TENANT)).category).toBe("deadline"));
    it("命中「多久 + 录用」", async () => expect((await hardGuardCheck("多久能录用", TENANT)).category).toBe("deadline"));
    it("命中「什么时候 + 拿到」", async () => expect((await hardGuardCheck("什么时候能拿到刊物", TENANT)).category).toBe("deadline"));
  });
  it("whitelist 命中：whitelisted=true，hit=false", async () => {
    dbMock.rows = [{ pattern: "多少钱" }];
    clearWhitelistCache();
    const r = await hardGuardCheck("这个多少钱", TENANT);
    expect(r.hit).toBe(false);
    expect(r.whitelisted).toBe(true);
  });
  it("无关消息不命中", async () => {
    expect((await hardGuardCheck("您好我想了解 SCI 投稿", TENANT)).hit).toBe(false);
  });
  it("4 类 regex 都按设计文档锁死（防漂移）", () => {
    expect(Object.keys(HARD_GUARD_PATTERNS).sort()).toEqual(["contract", "deadline", "legal", "quote"]);
  });
});
