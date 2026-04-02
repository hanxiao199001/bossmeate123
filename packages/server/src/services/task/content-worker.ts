import { Worker, Job } from "bullmq";
import { getRedisConnection } from "./queue.js";
import { SkillRegistry } from "../skills/index.js";
import { getProvider } from "../ai/provider-factory.js";
import { db } from "../../models/db.js";
import { tasks, taskLogs } from "../../models/schema.js";
import { eq } from "drizzle-orm";

interface ContentJobData {
  taskId: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  skillType: string;
  userInput: string;
  history: Array<{ role: string; content: string }>;
}

export function startContentWorker(): Worker {
  const worker = new Worker<ContentJobData>(
    "content-generation",
    async (job: Job<ContentJobData>) => {
      const { taskId, tenantId, userId, conversationId, skillType, userInput, history } = job.data;

      await db.update(tasks).set({
        status: "running", startedAt: new Date(), updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));

      const skill = SkillRegistry.get(skillType);
      if (!skill) throw new Error(`Skill "${skillType}" not found in registry`);

      const provider = getProvider(skill.preferredTier) || getProvider("cheap");
      if (!provider) throw new Error("No AI provider available");

      await job.updateProgress(10);
      await db.update(tasks).set({ progress: 10, updatedAt: new Date() }).where(eq(tasks.id, taskId));

      const stepStart = Date.now();

      const result = await skill.handle(
        userInput,
        history as Array<{ role: "user" | "assistant" | "system"; content: string }>,
        { tenantId, userId, conversationId, provider }
      );

      await job.updateProgress(90);
      await db.update(tasks).set({ progress: 90, updatedAt: new Date() }).where(eq(tasks.id, taskId));

      await db.insert(taskLogs).values({
        taskId,
        step: "skill_handle",
        status: "completed",
        model: provider.name,
        durationMs: Date.now() - stepStart,
        detail: { hasArtifact: !!result.artifact, tokenUsage: result.tokenUsage },
      });

      if (result.artifact) {
        const { contents } = await import("../../models/schema.js");
        await db.insert(contents).values({
          tenantId, userId, conversationId,
          type: result.artifact.type,
          title: result.artifact.title,
          body: result.artifact.body,
          status: "draft",
          metadata: result.artifact.metadata || {},
        });
      }

      await db.update(tasks).set({
        status: "completed", progress: 100,
        output: { reply: result.reply, artifact: result.artifact },
        completedAt: new Date(), updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));

      return { reply: result.reply, hasArtifact: !!result.artifact };
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on("completed", (job) => {
    console.log(`Task completed: ${job.id}`);
  });

  worker.on("failed", async (job, err) => {
    console.error(`Task failed: ${job?.id}`, err.message);
    if (job) {
      await db.update(tasks).set({
        status: "failed", error: err.message, updatedAt: new Date(),
      }).where(eq(tasks.id, job.data.taskId));
    }
  });

  console.log("Content generation worker started (concurrency: 3)");
  return worker;
}
