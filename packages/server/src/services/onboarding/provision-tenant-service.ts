/**
 * 7-05 多租户开通 P0: 客户开通核心逻辑(从 scripts/provision-tenant.ts 抽出共用)。
 * 调用方: ① 平台管理端 POST /platform/tenants(routes/platform.ts) ② CLI pnpm provision:tenant(薄包装)。
 *
 * 幂等语义: 同手机号已是某租户 owner → 抛 ALREADY_PROVISIONED("已开通"), 不重复建租户;
 *   手机号被普通成员占用 → PHONE_TAKEN; 信用代码重复 → CREDIT_CODE_EXISTS。
 */
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../models/db.js";
import { tenants, users } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

export const PROVISION_PLANS = ["free", "trial", "basic", "pro"] as const;
export type ProvisionPlan = (typeof PROVISION_PLANS)[number];

const PHONE_RE = /^1[3-9]\d{9}$/;

export class ProvisionError extends Error {
  constructor(
    public code:
      | "INVALID_INPUT"
      | "ALREADY_PROVISIONED"
      | "PHONE_TAKEN"
      | "CREDIT_CODE_EXISTS"
      | "SERVER_ERROR",
    message: string,
    /** ALREADY_PROVISIONED 时带上已有租户信息, 方便前端/CLI 提示 */
    public existingTenantId?: string,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}

export interface ProvisionInput {
  company: string;
  ownerPhone: string;
  ownerName: string;
  creditCode?: string | null;
  legalPerson?: string | null;
  businessLicenseUrl?: string | null;
  plan?: string;
  /** 审计: 谁开通的(如 "provision-script" / "platform:<userId>") */
  provisionedBy?: string;
}

export interface ProvisionResult {
  tenant: { id: string; name: string; slug: string; plan: string; verifiedStatus: string | null };
  owner: { id: string; phone: string | null; name: string; role: string };
}

/** 校验 + 幂等检查 + 建租户(已认证) + 老板 owner 主账号。 */
export async function provisionTenant(input: ProvisionInput): Promise<ProvisionResult> {
  const company = input.company?.trim();
  const phone = input.ownerPhone?.trim();
  const name = input.ownerName?.trim();
  const creditCode = input.creditCode?.trim() || null;
  const legalPerson = input.legalPerson?.trim() || null;
  const businessLicenseUrl = input.businessLicenseUrl?.trim() || null;
  const plan = (input.plan?.trim() || "trial").toLowerCase();

  const errs: string[] = [];
  if (!company) errs.push("缺公司名");
  if (!name) errs.push("缺老板姓名");
  if (!phone || !PHONE_RE.test(phone)) errs.push("老板手机号格式不正确");
  if (!(PROVISION_PLANS as readonly string[]).includes(plan)) errs.push("plan 须为 free|trial|basic|pro");
  if (errs.length) throw new ProvisionError("INVALID_INPUT", errs.join("; "));

  // 幂等: 手机号已存在 → owner 视为"已开通", 其余角色视为被占用
  const [dupUser] = await db
    .select({ id: users.id, role: users.role, tenantId: users.tenantId })
    .from(users)
    .where(eq(users.phone, phone!))
    .limit(1);
  if (dupUser) {
    if (dupUser.role === "owner") {
      throw new ProvisionError(
        "ALREADY_PROVISIONED",
        `手机号 ${phone} 已开通(是租户 ${dupUser.tenantId} 的老板), 请勿重复开通。`,
        dupUser.tenantId,
      );
    }
    throw new ProvisionError("PHONE_TAKEN", `手机号 ${phone} 已是某公司成员, 不能作为老板开通新公司。`);
  }
  if (creditCode) {
    const [dupTenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.creditCode, creditCode))
      .limit(1);
    if (dupTenant) {
      throw new ProvisionError("CREDIT_CODE_EXISTS", `信用代码 ${creditCode} 已开通过公司(租户 ${dupTenant.id})。`, dupTenant.id);
    }
  }

  const slug = `tenant-${nanoid(8)}`;
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: company!,
      slug,
      plan,
      creditCode,
      legalPerson,
      businessLicenseUrl,
      verifiedStatus: creditCode ? "verified" : "unverified",
      verifiedAt: creditCode ? new Date() : null,
      verifiedBy: input.provisionedBy ?? "provision-script",
    })
    .returning();
  if (!tenant) throw new ProvisionError("SERVER_ERROR", "租户创建失败");

  const [owner] = await db
    .insert(users)
    .values({ tenantId: tenant.id, phone: phone!, name: name!, role: "owner" })
    .returning();
  if (!owner) throw new ProvisionError("SERVER_ERROR", "老板账号创建失败");

  logger.info(
    { tenantId: tenant.id, ownerId: owner.id, phone, plan, by: input.provisionedBy },
    "多租户开通: 新租户 + owner 已创建",
  );
  return {
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan, verifiedStatus: tenant.verifiedStatus },
    owner: { id: owner.id, phone: owner.phone, name: owner.name, role: owner.role },
  };
}
