# 一键启动全链路优化方案

## 当前问题

点击「一键启动」后，流程只走到了 **任务入队** 就停了。Dashboard 显示 "5 排队中" 但任务永远不会变成 "写作中" 或 "待审核"。

### 根本原因分析

**Bug 1：`handleArticleWrite()` 不更新任务状态**

文件：`packages/server/src/services/task/content-worker.ts`

`handleDefaultContent()` 会更新 `tasks` 表的 status（pending → running → completed），但 `handleArticleWrite()` 完全没有更新任务状态的代码。对比：

```
handleDefaultContent():  ✅ 更新 tasks.status = "running" → "completed"
handleArticleWrite():    ❌ 从不更新 tasks 表，也不更新 dailyContentPlans.tasks 里的状态
```

**Bug 2：`dailyContentPlans.tasks` JSON 数组中的 task.status 永远是 "pending"**

Orchestrator 将任务入队后，plan 中每个 task 的 status 字段永远停在 "pending"。Worker 完成后只往 `contents` 表写了记录，但没回写 plan 中的 task status。Dashboard 读的是 plan 数据，所以永远显示 "排队中"。

**Bug 3：delay 计算可能导致任务不立即执行**

`calculateDelay()` 基于 `scheduledPublishAt` 减去30分钟。如果 scheduledPublishAt 是未来时间，任务会被延迟执行。测试时应该立即执行。

---

## 需要修改的文件

### 1. `packages/server/src/services/task/content-worker.ts`

**修改 `handleArticleWrite()` 函数，补充完整的状态管理：**

```typescript
async function handleArticleWrite(job: Job<ContentJobData>) {
  const { taskId, tenantId, userInput, history, agentMeta } = job.data;

  // ===== 新增：更新 task 状态为 running =====
  if (taskId) {
    await db.update(tasks).set({
      status: "running", startedAt: new Date(), updatedAt: new Date(),
    }).where(eq(tasks.id, taskId));
  }

  // ===== 新增：更新 plan 中该 task 的状态 =====
  if (agentMeta?.planId) {
    await updatePlanTaskStatus(agentMeta.planId, taskId, "running");
  }

  const skill = SkillRegistry.get("article");
  if (!skill) throw new Error('ArticleSkill not registered');

  const provider = getProvider(skill.preferredTier) || getProvider("cheap");
  if (!provider) throw new Error("No AI provider available");

  await job.updateProgress(10);

  const stepStart = Date.now();
  const enrichedInput = userInput;

  const result = await skill.handle(
    enrichedInput,
    history as Array<{ role: "user" | "assistant" | "system"; content: string }>,
    {
      tenantId,
      userId: "system",
      conversationId: agentMeta?.planId || nanoid(),
      provider,
    }
  );

  await job.updateProgress(70);

  // Save content to DB
  let contentId: string | null = null;
  if (result.artifact) {
    const [inserted] = await db.insert(contents).values({
      tenantId,
      userId: "system" as any,
      type: result.artifact.type,
      title: result.artifact.title,
      body: result.artifact.body,
      status: "draft",
      metadata: {
        ...(result.artifact.metadata || {}),
        agentGenerated: true,
        platform: agentMeta?.platform,
        style: agentMeta?.style,
        wordCount: agentMeta?.wordCount,
        planId: agentMeta?.planId,
      },
    }).returning({ id: contents.id });
    contentId = inserted?.id || null;
  }

  await job.updateProgress(90);

  // Decide next action based on stage
  const stage = agentMeta?.automationStage || "learning";
  const qualityScore = (result as any).qualityScore || 70;
  const threshold = 75;

  if (contentId) {
    switch (stage) {
      case "full_auto":
        await schedulePublish({ ... });
        await db.update(contents).set({ status: "approved", updatedAt: new Date() }).where(eq(contents.id, contentId));
        break;
      case "semi_auto":
        if (qualityScore >= threshold) {
          await schedulePublish({ ... });
          await db.update(contents).set({ status: "approved", updatedAt: new Date() }).where(eq(contents.id, contentId));
        } else {
          await db.update(contents).set({ status: "reviewing", updatedAt: new Date() }).where(eq(contents.id, contentId));
        }
        break;
      case "learning":
      default:
        await db.update(contents).set({ status: "reviewing", updatedAt: new Date() }).where(eq(contents.id, contentId));
        break;
    }
  }

  // ===== 新增：写入 taskLogs =====
  await db.insert(taskLogs).values({
    taskId: taskId || nanoid(),
    step: "article_write",
    status: "completed",
    model: provider.name,
    durationMs: Date.now() - stepStart,
    detail: { contentId, hasArtifact: !!result.artifact, qualityScore, stage },
  });

  // ===== 新增：更新 task 状态为 completed =====
  if (taskId) {
    await db.update(tasks).set({
      status: "completed",
      progress: 100,
      output: { contentId, qualityScore, stage },
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(tasks.id, taskId));
  }

  // ===== 新增：更新 plan 中该 task 的状态 =====
  if (agentMeta?.planId) {
    await updatePlanTaskStatus(agentMeta.planId, taskId, "completed");
  }

  await job.updateProgress(100);

  logger.info(
    { tenantId, contentId, stage, platform: agentMeta?.platform },
    "article-write completed"
  );

  return { contentId, hasArtifact: !!result.artifact, stage, qualityScore };
}
```

**新增辅助函数 `updatePlanTaskStatus()`：**

```typescript
async function updatePlanTaskStatus(
  planId: string,
  taskId: string,
  newStatus: string
): Promise<void> {
  try {
    const [plan] = await db
      .select()
      .from(dailyContentPlans)
      .where(eq(dailyContentPlans.id, planId))
      .limit(1);

    if (!plan) return;

    const planTasks = (plan.tasks || []) as any[];
    const updated = planTasks.map((t) =>
      t.id === taskId ? { ...t, status: newStatus } : t
    );

    // 计算整体完成状态
    const allDone = updated.every((t) => t.status === "completed" || t.status === "failed");
    const planStatus = allDone ? "completed" : "executing";

    await db
      .update(dailyContentPlans)
      .set({ tasks: updated, status: planStatus, updatedAt: new Date() })
      .where(eq(dailyContentPlans.id, planId));
  } catch (err) {
    logger.error({ planId, taskId, err }, "更新 plan task 状态失败");
  }
}
```

需要在文件顶部 import 添加 `dailyContentPlans`：
```typescript
import { tasks, taskLogs, contents, scheduledPublishes, tenants, dailyContentPlans } from "../../models/schema.js";
```

同时更新 `worker.on("failed")` 回调，也更新 plan 状态：
```typescript
worker.on("failed", async (job, err) => {
  console.error(`Task failed: ${job?.id}`, err.message);
  if (job) {
    const { taskId, agentMeta } = job.data;
    await db.update(tasks).set({
      status: "failed", error: err.message, updatedAt: new Date(),
    }).where(eq(tasks.id, taskId));

    // 新增：同步更新 plan 中的 task 状态
    if (agentMeta?.planId && taskId) {
      await updatePlanTaskStatus(agentMeta.planId, taskId, "failed");
    }
  }
});
```

### 2. `packages/server/src/services/agents/orchestrator.ts`

**修改 `calculateDelay()` 函数，测试阶段不延迟：**

```typescript
function calculateDelay(scheduledTime: string): number {
  if (!scheduledTime) return 0;
  const scheduled = new Date(scheduledTime).getTime();
  const now = Date.now();
  const delay = scheduled - now - 30 * 60 * 1000;
  // 如果已过时间，立即执行（不延迟）
  return Math.max(delay, 0);
}
```

这个函数本身逻辑没问题（已经有 Math.max），但需要确认 `scheduledPublishAt` 的时区处理正确。

### 3. Dashboard 前端状态映射

文件：`apps/web/src/pages/DashboardPage.tsx`

Dashboard 的 FactoryHero 组件需要正确映射 plan task 状态到显示：
- `pending` → 排队中
- `running` → 写作中
- `completed` + content.status === "reviewing" → 待审核
- `completed` + content.status === "approved" → 已发布
- `failed` → 失败

确保 Dashboard 通过 API 拉取的数据能反映 plan tasks 的实时状态。目前 `/api/v1/agents/daily-progress` 返回的 task 状态来自 `dailyContentPlans.tasks` JSON，修复 Bug 2 后这里就能正确显示了。

### 4. Dashboard 数据统计

FactoryHero 显示的计数（已发布/待审核/写作中/排队中）需要从两个来源汇总：
1. `dailyContentPlans.tasks` 中各 task 的 status（排队中/写作中）
2. `contents` 表中当日 agentGenerated 的内容的 status（待审核/已发布）

建议在 `/api/v1/agents/daily-progress` 接口中增加 contents 统计：

```typescript
// 在 getDailyProgress() 中增加
const todayContents = await db
  .select()
  .from(contents)
  .where(
    and(
      eq(contents.tenantId, tenantId),
      gte(contents.createdAt, todayStart),
      sql`(${contents.metadata}->>'agentGenerated')::boolean = true`
    )
  );

const contentStatusCounts = {
  draft: todayContents.filter(c => c.status === 'draft').length,
  reviewing: todayContents.filter(c => c.status === 'reviewing').length,
  approved: todayContents.filter(c => c.status === 'approved').length,
  published: todayContents.filter(c => c.status === 'published').length,
};
```

---

## 测试验证

修改完成后，按以下步骤验证：

1. 清除今日已有的 plan（避免重复）：
```sql
DELETE FROM daily_content_plans WHERE date = CURRENT_DATE;
DELETE FROM daily_recommendations WHERE date = CURRENT_DATE::text;
```

2. 触发一键启动：
```bash
curl -s -X POST http://localhost:3000/api/v1/agents/orchestrator/trigger \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{}' | jq .
```

3. 观察 pm2 logs 看 worker 是否在处理任务：
```bash
pm2 logs bossmate-server --lines 50
```

4. 查看 contents 表是否有新生成的文章：
```bash
psql -U bossmate -d bossmate -c "SELECT id, title, status, created_at FROM contents ORDER BY created_at DESC LIMIT 10;"
```

5. 查看 Dashboard 是否正确显示状态变化：排队中 → 写作中 → 待审核

---

## 总结

核心修改量不大，主要是 `content-worker.ts` 中的 `handleArticleWrite()` 函数需要补充：
1. **任务状态回写**：更新 tasks 表和 dailyContentPlans.tasks JSON
2. **任务日志记录**：写入 taskLogs
3. **失败状态同步**：worker.on("failed") 也要更新 plan

这样一键启动后，Dashboard 就能实时看到：排队中(5) → 写作中(3) 排队中(2) → 待审核(5) → 手动审批后 → 已发布(5)
