/**
 * 7-05 多租户开通 P0 — provision-tenant-service 幂等单测。
 *   ① 新手机号 → 建租户 + owner 成功
 *   ② 同手机号已是 owner → ALREADY_PROVISIONED("已开通"), 不再 insert
 *   ③ 手机号被普通成员占用 → PHONE_TAKEN
 *   ④ 信用代码重复 → CREDIT_CODE_EXISTS
 *   ⑤ 非法输入(手机号/plan) → INVALID_INPUT, 不查库
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

// schema 表对象用 marker 区分 select 来源
vi.mock("../models/schema.js", () => ({
  tenants: { __table: "tenants", id: "tenants.id", creditCode: "tenants.creditCode" },
  users: { __table: "users", id: "users.id", role: "users.role", tenantId: "users.tenantId", phone: "users.phone" },
}));

// 可编程 db mock: selectResults 按 from(table) 出队; insert 记录并回显
const state: {
  usersByPhone: Array<Record<string, unknown>>;
  tenantsByCredit: Array<Record<string, unknown>>;
  inserted: Array<{ table: string; values: Record<string, unknown> }>;
} = { usersByPhone: [], tenantsByCredit: [], inserted: [] };

vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: (tbl: { __table: string }) => ({
        where: () => ({
          limit: () =>
            Promise.resolve(tbl.__table === "users" ? state.usersByPhone : state.tenantsByCredit),
        }),
      }),
    })),
    insert: vi.fn((tbl: { __table: string }) => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push({ table: tbl.__table, values: v });
        return {
          returning: () =>
            Promise.resolve([{ id: `${tbl.__table}-id-1`, verifiedStatus: "unverified", ...v }]),
        };
      },
    })),
  },
  closePool: vi.fn(),
}));

import { provisionTenant, ProvisionError } from "../services/onboarding/provision-tenant-service.js";
import { db } from "../models/db.js";

const VALID = { company: "顺仕美途", ownerPhone: "13800138000", ownerName: "韩老板" };

beforeEach(() => {
  state.usersByPhone = [];
  state.tenantsByCredit = [];
  state.inserted = [];
  vi.clearAllMocks();
});

describe("provisionTenant 新开通", () => {
  it("新手机号 → 建租户 + owner, plan/认证字段正确", async () => {
    const r = await provisionTenant({ ...VALID, creditCode: "91110108MA01XXXX2B", legalPerson: "韩某某", plan: "basic" });
    expect(r.tenant.name).toBe("顺仕美途");
    expect(r.tenant.plan).toBe("basic");
    expect(r.owner.role).toBe("owner");
    expect(r.owner.phone).toBe("13800138000");
    expect(state.inserted.map((i) => i.table)).toEqual(["tenants", "users"]);
    const tenantValues = state.inserted[0].values;
    expect(tenantValues.verifiedStatus).toBe("verified"); // 有信用代码 → 直接标已认证
    expect(tenantValues.slug).toMatch(/^tenant-/);
  });

  it("无信用代码 → verifiedStatus=unverified, 默认 plan=trial", async () => {
    await provisionTenant(VALID);
    expect(state.inserted[0].values.verifiedStatus).toBe("unverified");
    expect(state.inserted[0].values.plan).toBe("trial");
  });
});

describe("provisionTenant 幂等/冲突", () => {
  it("同手机号已是 owner → ALREADY_PROVISIONED(已开通), 不 insert", async () => {
    state.usersByPhone = [{ id: "u1", role: "owner", tenantId: "t1" }];
    const err = await provisionTenant(VALID).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).code).toBe("ALREADY_PROVISIONED");
    expect((err as ProvisionError).message).toContain("已开通");
    expect((err as ProvisionError).existingTenantId).toBe("t1");
    expect(state.inserted).toHaveLength(0);
  });

  it("手机号是普通成员 → PHONE_TAKEN, 不 insert", async () => {
    state.usersByPhone = [{ id: "u2", role: "content_operator", tenantId: "t1" }];
    const err = await provisionTenant(VALID).catch((e) => e);
    expect((err as ProvisionError).code).toBe("PHONE_TAKEN");
    expect(state.inserted).toHaveLength(0);
  });

  it("信用代码已建过租户 → CREDIT_CODE_EXISTS", async () => {
    state.tenantsByCredit = [{ id: "t9" }];
    const err = await provisionTenant({ ...VALID, creditCode: "91110108MA01XXXX2B" }).catch((e) => e);
    expect((err as ProvisionError).code).toBe("CREDIT_CODE_EXISTS");
    expect(state.inserted).toHaveLength(0);
  });
});

describe("provisionTenant 输入校验", () => {
  it("手机号格式错 → INVALID_INPUT, 不查库", async () => {
    const err = await provisionTenant({ ...VALID, ownerPhone: "12345" }).catch((e) => e);
    expect((err as ProvisionError).code).toBe("INVALID_INPUT");
    expect(db.select).not.toHaveBeenCalled();
  });

  it("非法 plan → INVALID_INPUT", async () => {
    const err = await provisionTenant({ ...VALID, plan: "enterprise" }).catch((e) => e);
    expect((err as ProvisionError).code).toBe("INVALID_INPUT");
  });

  it("缺公司名/姓名 → INVALID_INPUT", async () => {
    const err = await provisionTenant({ ...VALID, company: "  " }).catch((e) => e);
    expect((err as ProvisionError).code).toBe("INVALID_INPUT");
  });
});
