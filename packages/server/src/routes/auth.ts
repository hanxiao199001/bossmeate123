import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcrypt";
import { nanoid } from "nanoid";
import { eq, and } from "drizzle-orm";
import { db } from "../models/db.js";
import { users, tenants } from "../models/schema.js";
import { logger } from "../config/logger.js";

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

export async function authRoutes(app: FastifyInstance) {
  /**
   * POST /auth/register - 注册（同时创建租户）
   */
  app.post("/register", async (request, reply) => {
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
    const [tenant] = await db
      .insert(tenants)
      .values({
        name: body.tenantName,
        slug,
      })
      .returning();

    // 创建用户（owner角色）
    const passwordHash = await bcrypt.hash(body.password, 12);
    const [user] = await db
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

    // 验证密码
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
        },
      },
    };
  });
}
