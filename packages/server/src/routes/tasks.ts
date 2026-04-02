import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { contentQueue } from "../services/task/queue.js";
import { db } from "../models/db.js";
import { tasks, taskLogs } from "../models/schema.js";

const createTaskSchema = z.object({
  conversationId: z.string().uuid(),
  skillType: z.string(),
  userInput: z.string(),
  history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).optional().default([]),
});

export async function taskRoutes(app: FastifyInstance) {
  // POST /tasks — 创建异步任务
  app.post("/", async (request, reply) => {
    const body = createTaskSchema.parse(request.body);

    const [task] = await db.insert(tasks).values({
      tenantId: request.tenantId,
      userId: request.user.userId,
      conversationId: body.conversationId,
      type: `${body.skillType}_generation`,
      status: "pending",
      input: { userInput: body.userInput },
    }).returning();

    await contentQueue.add(`gen-${task.id}`, {
      taskId: task.id,
      tenantId: request.tenantId,
      userId: request.user.userId,
      conversationId: body.conversationId,
      skillType: body.skillType,
      userInput: body.userInput,
      history: body.history,
    });

    return reply.code(202).send({
      code: "OK",
      data: { taskId: task.id, status: "pending", message: "任务已提交，正在后台处理" },
    });
  });

  // GET /tasks/:id — 查询任务状态
  app.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const [task] = await db.select().from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, request.tenantId)))
      .limit(1);

    if (!task) return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });
    return { code: "OK", data: task };
  });

  // GET /tasks — 查询当前用户的任务列表
  app.get("/", async (request) => {
    const { status, limit = "20" } = request.query as { status?: string; limit?: string };

    let query = db.select().from(tasks)
      .where(and(eq(tasks.tenantId, request.tenantId), eq(tasks.userId, request.user.userId)))
      .orderBy(desc(tasks.createdAt))
      .limit(Number(limit));

    const result = await query;
    return { code: "OK", data: result };
  });

  // GET /tasks/:id/logs — 查询任务执行日志
  app.get("/:id/logs", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [task] = await db.select().from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, request.tenantId)))
      .limit(1);
    if (!task) return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });

    const logs = await db.select().from(taskLogs)
      .where(eq(taskLogs.taskId, id))
      .orderBy(taskLogs.createdAt);

    return { code: "OK", data: logs };
  });

  // POST /tasks/:id/cancel — 取消任务
  app.post("/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [task] = await db.select().from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, request.tenantId)))
      .limit(1);

    if (!task || !["pending", "running"].includes(task.status)) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "任务不存在或无法取消" });
    }

    await db.update(tasks).set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(tasks.id, id));

    return { code: "OK", data: { message: "任务已取消" } };
  });
}
