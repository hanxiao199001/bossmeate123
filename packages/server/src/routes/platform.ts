/**
 * 7-05 多租户开通 P0 — 平台管理端路由(替代 ssh 跑 provision-tenant CLI)。
 *
 *   GET  /platform/me      — 当前用户是否平台管理员(所有登录用户可查, 前端据此显隐入口)
 *   POST /platform/tenants — 开通新客户(白名单管理员 only): 调 provision-tenant-service,
 *                            成功后尝试发欢迎短信(未配置则跳过, 响应带 smsSent/smsNote)
 *   GET  /platform/tenants — 薄客户列表(公司/owner手机/套餐/状态/成员数), 分页
 *
 * 挂载: index.ts protectedApp(auth + tenant 中间件之后), prefix ${API_PREFIX}/platform。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, inArray, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { tenants, users } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { platformAdminOnly, isPlatformAdmin } from "../middleware/platform-admin.js";
import { provisionTenant, ProvisionError } from "../services/onboarding/provision-tenant-service.js";
import { sendWelcomeSms } from "../services/auth/sms-service.js";

const createTenantSchema = z.object({
  company: z.string().trim().min(1, "公司名不能为空").max(100),
  phone: z.string().regex(/^1[3-9]\d{9}$/, "老板手机号格式不正确"),
  name: z.string().trim().min(1, "老板姓名不能为空").max(50),
  credit: z.string().trim().max(30).optional(),
  legal: z.string().trim().max(50).optional(),
  licenseUrl: z.string().trim().url("营业执照 URL 格式不正确").max(500).optional().or(z.literal("")),
  plan: z.enum(["trial", "basic", "pro"]).default("trial"),
});

const PROVISION_HTTP_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  ALREADY_PROVISIONED: 409,
  PHONE_TAKEN: 409,
  CREDIT_CODE_EXISTS: 409,
  SERVER_ERROR: 500,
};

export async function platformRoutes(app: FastifyInstance) {
  /** GET /platform/me — 不设白名单闸(否则前端拿不到 false), 只回布尔。 */
  app.get("/me", async (request) => {
    const ok = await isPlatformAdmin(request.user.userId);
    return { code: "OK", data: { isPlatformAdmin: ok } };
  });

  /** POST /platform/tenants — 开通客户 + 欢迎短信(优雅降级)。 */
  app.post("/tenants", { preHandler: platformAdminOnly }, async (request, reply) => {
    const body = createTenantSchema.parse(request.body);
    let result;
    try {
      result = await provisionTenant({
        company: body.company,
        ownerPhone: body.phone,
        ownerName: body.name,
        creditCode: body.credit,
        legalPerson: body.legal,
        businessLicenseUrl: body.licenseUrl || undefined,
        plan: body.plan,
        provisionedBy: `platform:${request.user.userId}`,
      });
    } catch (err) {
      if (err instanceof ProvisionError) {
        return reply.code(PROVISION_HTTP_STATUS[err.code] ?? 500).send({ code: err.code, message: err.message });
      }
      throw err;
    }

    // 欢迎短信: "您的 BossMate 已开通, 用本手机号验证码登录: boss-mates.com"(模板变量 company)
    const sms = await sendWelcomeSms(body.phone, { company: body.company });
    logger.info(
      { tenantId: result.tenant.id, by: request.user.userId, smsSent: sms.sent },
      "平台管理端开通客户成功",
    );
    return reply.code(201).send({
      code: "OK",
      data: {
        tenant: result.tenant,
        owner: result.owner,
        smsSent: sms.sent,
        smsNote: sms.sent
          ? "欢迎短信已发送"
          : `欢迎短信未发送(${sms.reason ?? "未配置"}), 请口头通知客户: 用手机号 ${body.phone} 在登录页选「手机号登录」获取验证码即可进入。`,
      },
    });
  });

  /** GET /platform/tenants — 薄客户列表, 分页(默认 20/页)。 */
  app.get("/tenants", { preHandler: platformAdminOnly }, async (request) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(request.query ?? {});

    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(tenants);
    const rows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        plan: tenants.plan,
        status: tenants.status,
        verifiedStatus: tenants.verifiedStatus,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .orderBy(desc(tenants.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);

    const ids = rows.map((r) => r.id);
    const members = ids.length
      ? await db
          .select({ tenantId: users.tenantId, role: users.role, phone: users.phone, isActive: users.isActive })
          .from(users)
          .where(inArray(users.tenantId, ids))
      : [];
    const byTenant = new Map<string, { ownerPhone: string | null; memberCount: number }>();
    for (const m of members) {
      const cur = byTenant.get(m.tenantId) ?? { ownerPhone: null, memberCount: 0 };
      if (m.isActive) cur.memberCount += 1;
      if (m.role === "owner" && !cur.ownerPhone) cur.ownerPhone = m.phone;
      byTenant.set(m.tenantId, cur);
    }

    return {
      code: "OK",
      data: {
        items: rows.map((r) => ({
          ...r,
          ownerPhone: byTenant.get(r.id)?.ownerPhone ?? null,
          memberCount: byTenant.get(r.id)?.memberCount ?? 0,
        })),
        total,
        page: q.page,
        pageSize: q.pageSize,
      },
    };
  });
}
