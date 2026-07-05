import type { FastifyInstance } from "fastify";
import { permissionsForRole } from "../permissions/permissions.js";
import { z } from "zod";
import bcrypt from "bcrypt";
import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import { db } from "../models/db.js";
import { users, tenants, tenantInvites } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import { sendSmsCode, verifySmsCode, isValidPhone, SmsError, type SmsPurpose } from "../services/auth/sms-service.js";
import { code2Session, getPhoneNumberByCode, decryptPhone, miniConfigured } from "../services/wechat/miniprogram.js";

// 请求体校验
const registerSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
  password: z.string().min(6, "密码至少6位"),
  name: z.string().min(1, "姓名不能为空"),
  tenantName: z.string().min(1, "企业名称不能为空"),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
  password: z.string().min(1, "密码不能为空"),
});

// 7-05 多租户开通 P0: 默认关闭自注册(客户由平台在 /platform 开通)。
//   Option B(7-05): 不再依赖 NODE_ENV(生产机实际以 development 身份跑, 旧逻辑架空了闸门)。
//   规则: 默认关闭 → ALLOW_SELF_REGISTER=true 显式打开; test 环境恒开(不破坏现有测试)。
//   本地开发需自注册时, .env 加 ALLOW_SELF_REGISTER=true。
function selfRegisterClosed(): boolean {
  return env.NODE_ENV !== "test" && !env.ALLOW_SELF_REGISTER;
}

export async function authRoutes(app: FastifyInstance) {
  /**
   * POST /auth/register - 注册（同时创建租户）。7-05: 生产默认关闭(见 selfRegisterClosed)。
   */
  app.post("/register", async (request, reply) => {
    if (selfRegisterClosed()) {
      return reply.code(403).send({ code: "SELF_REGISTER_DISABLED", message: "自助注册未开放, 请联系平台开通" });
    }
    const body = registerSchema.parse(request.body);

    // 检查邮箱是否已注册
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    if (existing.length > 0) {
      return reply.code(409).send({
        code: "EMAIL_EXISTS",
        message: "该邮箱已注册",
      });
    }

    // 创建租户
    const slug = `tenant-${nanoid(8)}`;
    const tenantResult = await db
      .insert(tenants)
      .values({
        name: body.tenantName,
        slug,
      })
      .returning();

    const tenant = tenantResult[0];
    if (!tenant) {
      return reply.code(500).send({ code: "SERVER_ERROR", message: "租户创建失败" });
    }

    // 创建用户（owner角色）
    const passwordHash = await bcrypt.hash(body.password, 12);
    const userResult = await db
      .insert(users)
      .values({
        tenantId: tenant.id,
        email: body.email,
        phone: body.phone,
        passwordHash,
        name: body.name,
        role: "owner",
      })
      .returning();

    const user = userResult[0];
    if (!user) {
      return reply.code(500).send({ code: "SERVER_ERROR", message: "用户创建失败" });
    }

    // 签发 JWT
    const token = app.jwt.sign({
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
    });

    logger.info({ userId: user.id, tenantId: tenant.id }, "新用户注册成功");

    return reply.code(201).send({
      code: "OK",
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          permissions: permissionsForRole(user.role),
        },
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
        },
      },
    });
  });

  /**
   * POST /auth/sms/send - 发送手机验证码(限频/防刷在 service 层)
   */
  app.post("/sms/send", async (request, reply) => {
    const body = z.object({ phone: z.string(), purpose: z.enum(["login", "register", "invite"]).default("login") }).parse(request.body);
    try {
      const r = await sendSmsCode(body.phone, body.purpose as SmsPurpose, request.ip);
      return reply.send({ code: "OK", data: { sent: r.sent, ...(r.devCode ? { devCode: r.devCode } : {}) } });
    } catch (err) {
      if (err instanceof SmsError) return reply.code(429).send({ code: err.code, message: err.message });
      throw err;
    }
  });

  /**
   * POST /auth/sms/login - 手机验证码登录。
   *   用户已存在 → 直接登录; 不存在但有 pending 邀请 → 建号绑角色入职; 都没有 → NO_TENANT 引导建公司。
   */
  app.post("/sms/login", async (request, reply) => {
    const body = z.object({ phone: z.string(), code: z.string() }).parse(request.body);
    if (!isValidPhone(body.phone)) return reply.code(400).send({ code: "INVALID_PHONE", message: "手机号格式不正确" });
    try {
      await verifySmsCode(body.phone, body.code, "login");
    } catch (err) {
      if (err instanceof SmsError) return reply.code(400).send({ code: err.code, message: err.message });
      throw err;
    }

    let [user] = await db.select().from(users).where(eq(users.phone, body.phone)).limit(1);
    let tenant;
    if (user) {
      [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    } else {
      // 无用户 → 看是否有 pending 邀请
      const [invite] = await db.select().from(tenantInvites)
        .where(and(eq(tenantInvites.phone, body.phone), eq(tenantInvites.status, "pending")))
        .orderBy(tenantInvites.createdAt).limit(1);
      if (!invite) return reply.code(404).send({ code: "NO_TENANT", message: "该手机号未注册, 也没有待接受的邀请。请创建公司或联系管理员邀请你加入。" });
      if (new Date(invite.expiresAt) < new Date()) {
        await db.update(tenantInvites).set({ status: "expired", updatedAt: new Date() }).where(eq(tenantInvites.id, invite.id));
        return reply.code(410).send({ code: "INVITE_EXPIRED", message: "邀请已过期, 请联系管理员重新邀请" });
      }
      const [created] = await db.insert(users).values({
        tenantId: invite.tenantId, phone: body.phone, role: invite.role, name: body.phone.slice(-4) + " 同学",
      }).returning();
      user = created;
      await db.update(tenantInvites).set({ status: "accepted", acceptedAt: new Date(), updatedAt: new Date() }).where(eq(tenantInvites.id, invite.id));
      [tenant] = await db.select().from(tenants).where(eq(tenants.id, invite.tenantId)).limit(1);
      logger.info({ userId: user.id, tenantId: invite.tenantId, role: invite.role }, "员工经邀请加入租户");
    }
    if (!user || !tenant) return reply.code(500).send({ code: "SERVER_ERROR", message: "登录异常" });
    const token = app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role });
    return reply.send({ code: "OK", data: {
      token,
      user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, permissions: permissionsForRole(user.role) },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    } });
  });

  /**
   * POST /auth/wx-login - 微信小程序一键登录
   *
   * body: { code, phoneCode?, encryptedData?, iv? }
   *   code           wx.login() 返回的 js_code
   *   phoneCode      新版基础库 getPhoneNumber 返回的 code（推荐）
   *   encryptedData+iv  旧版基础库返回的加密手机号
   *
   * 取到手机号后，复用与 /auth/sms/login 一致的「找用户 / 接受邀请」逻辑签发 JWT。
   * 需配置 WECHAT_MINI_APPID / WECHAT_MINI_SECRET。
   */
  app.post("/wx-login", async (request, reply) => {
    if (!miniConfigured()) {
      return reply.code(503).send({ code: "WX_NOT_CONFIGURED", message: "服务端未配置小程序 AppID/Secret" });
    }
    const body = z.object({
      code: z.string().min(1, "缺少 code"),
      phoneCode: z.string().optional(),
      encryptedData: z.string().optional(),
      iv: z.string().optional(),
    }).parse(request.body);

    // 1) code → openid + session_key
    let session;
    try {
      session = await code2Session(body.code);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "[wx-login.code2session.failed]");
      return reply.code(400).send({ code: "WX_CODE_INVALID", message: "微信登录态校验失败，请重试" });
    }

    // 2) 取手机号（优先新版 phoneCode，回退旧版解密）
    let phone;
    try {
      if (body.phoneCode) {
        phone = await getPhoneNumberByCode(body.phoneCode);
      } else if (body.encryptedData && body.iv) {
        phone = decryptPhone(body.encryptedData, body.iv, session.session_key);
      } else {
        return reply.code(400).send({ code: "NO_PHONE", message: "缺少手机号授权" });
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "[wx-login.phone.failed]");
      return reply.code(400).send({ code: "PHONE_FAILED", message: "获取手机号失败，请重试" });
    }
    if (!isValidPhone(phone)) {
      return reply.code(400).send({ code: "INVALID_PHONE", message: "手机号格式不正确" });
    }

    // 3) 复用 sms/login 的找用户 / 接受邀请逻辑
    let [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
    let tenant;
    if (user) {
      [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    } else {
      const [invite] = await db.select().from(tenantInvites)
        .where(and(eq(tenantInvites.phone, phone), eq(tenantInvites.status, "pending")))
        .orderBy(tenantInvites.createdAt).limit(1);
      if (!invite) {
        return reply.code(404).send({ code: "NO_TENANT", message: "该手机号未注册，也没有待接受的邀请。请联系管理员邀请你加入。" });
      }
      if (new Date(invite.expiresAt) < new Date()) {
        await db.update(tenantInvites).set({ status: "expired", updatedAt: new Date() }).where(eq(tenantInvites.id, invite.id));
        return reply.code(410).send({ code: "INVITE_EXPIRED", message: "邀请已过期，请联系管理员重新邀请" });
      }
      const [created] = await db.insert(users).values({
        tenantId: invite.tenantId, phone, role: invite.role, name: phone.slice(-4) + " 同学",
      }).returning();
      user = created;
      await db.update(tenantInvites).set({ status: "accepted", acceptedAt: new Date(), updatedAt: new Date() }).where(eq(tenantInvites.id, invite.id));
      [tenant] = await db.select().from(tenants).where(eq(tenants.id, invite.tenantId)).limit(1);
      logger.info({ userId: user.id, tenantId: invite.tenantId }, "小程序经邀请加入租户");
    }
    if (!user || !tenant) return reply.code(500).send({ code: "SERVER_ERROR", message: "登录异常" });

    const token = app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role });
    logger.info({ userId: user.id }, "小程序登录成功");
    return reply.send({ code: "OK", data: {
      token,
      user: { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role, permissions: permissionsForRole(user.role) },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    } });
  });

  /**
   * POST /auth/register-company - 手机号注册新公司(创建租户 + owner 主账号)。
   */
  app.post("/register-company", async (request, reply) => {
    if (selfRegisterClosed()) {
      return reply.code(403).send({ code: "SELF_REGISTER_DISABLED", message: "自助注册未开放, 请联系平台开通" });
    }
    const body = z.object({ phone: z.string(), code: z.string(), name: z.string().min(1), tenantName: z.string().min(1) }).parse(request.body);
    if (!isValidPhone(body.phone)) return reply.code(400).send({ code: "INVALID_PHONE", message: "手机号格式不正确" });
    const [dup] = await db.select().from(users).where(eq(users.phone, body.phone)).limit(1);
    if (dup) return reply.code(409).send({ code: "PHONE_EXISTS", message: "该手机号已注册, 请直接登录" });
    try {
      await verifySmsCode(body.phone, body.code, "register");
    } catch (err) {
      if (err instanceof SmsError) return reply.code(400).send({ code: err.code, message: err.message });
      throw err;
    }
    const slug = `tenant-${nanoid(8)}`;
    const [tenant] = await db.insert(tenants).values({ name: body.tenantName, slug }).returning();
    if (!tenant) return reply.code(500).send({ code: "SERVER_ERROR", message: "租户创建失败" });
    const [user] = await db.insert(users).values({
      tenantId: tenant.id, phone: body.phone, name: body.name, role: "owner",
    }).returning();
    if (!user) return reply.code(500).send({ code: "SERVER_ERROR", message: "用户创建失败" });
    const token = app.jwt.sign({ userId: user.id, tenantId: tenant.id, role: user.role });
    logger.info({ userId: user.id, tenantId: tenant.id }, "手机号注册新公司成功");
    return reply.code(201).send({ code: "OK", data: {
      token,
      user: { id: user.id, name: user.name, phone: user.phone, role: user.role, permissions: permissionsForRole(user.role) },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    } });
  });

  /**
   * POST /auth/login - 登录
   */
  app.post("/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);

    // 查找用户
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    if (!user) {
      return reply.code(401).send({
        code: "INVALID_CREDENTIALS",
        message: "邮箱或密码错误",
      });
    }

    // 验证密码(手机号注册用户无密码 → 引导走手机验证码登录)
    if (!user.passwordHash) {
      return reply.code(400).send({ code: "USE_SMS_LOGIN", message: "该账号未设置密码, 请用手机验证码登录" });
    }
    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({
        code: "INVALID_CREDENTIALS",
        message: "邮箱或密码错误",
      });
    }

    if (!user.isActive) {
      return reply.code(403).send({
        code: "ACCOUNT_DISABLED",
        message: "账户已被禁用",
      });
    }

    // 更新最后登录时间
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    // 签发 JWT
    const token = app.jwt.sign({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
    });

    logger.info({ userId: user.id }, "用户登录成功");

    return {
      code: "OK",
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          permissions: permissionsForRole(user.role),
        },
      },
    };
  });
}
