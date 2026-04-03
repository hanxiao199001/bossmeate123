# BossMate Agent 系统 — Claude Code 分步开发指令

> 本文档是给 Claude Code 的逐步执行指令。每个 Step 是一个独立可验证的任务。
> 请按顺序执行，每完成一个 Step 后 `pnpm build` 确认无编译错误再继续下一个。
>
> 总体参考架构见 `AGENT-SYSTEM-PLAN.md`

---

## 当前项目结构（关键文件）

```
packages/server/src/
├── models/
│   ├── schema.ts          # Drizzle 表定义（需新增6张表）
│   ├── migrate.ts         # 迁移脚本
│   └── db.ts              # 数据库连接
├── services/
│   ├── skills/
│   │   ├── base-skill.ts      # ISkill 接口
│   │   ├── skill-registry.ts  # SkillRegistry 单例
│   │   ├── article-skill.ts   # 图文创作流水线（已有完整8步）
│   │   ├── topic-skill.ts     # 选题技能
│   │   └── index.ts           # 初始化注册
│   ├── agents/
│   │   ├── keyword-analyzer.ts    # 关键词分析（已有）
│   │   ├── keyword-trend.ts       # 关键词趋势（已有）
│   │   └── keyword-dictionary.ts  # 关键词字典（已有）
│   ├── task/
│   │   ├── queue.ts             # BullMQ 队列（contentQueue + crawlerQueue）
│   │   ├── content-worker.ts    # 内容生成 Worker
│   │   └── progress-ws.ts      # WebSocket 进度
│   ├── knowledge/
│   │   ├── knowledge-service.ts  # CRUD + 向量搜索
│   │   ├── vector-store.ts       # LanceDB 存储
│   │   ├── embedding-service.ts  # 嵌入服务
│   │   ├── rag-retriever.ts      # RAG 检索
│   │   ├── rag-retriever-v2.ts   # RAG V2
│   │   ├── audit-pipeline.ts     # 5步审计管道
│   │   └── cold-start.ts         # 冷启动
│   ├── data-collection/
│   │   ├── ingest-pipeline.ts         # 入库管道
│   │   ├── journal-content-collector.ts # 期刊收集
│   │   ├── competitor-analyzer.ts      # 竞品分析
│   │   ├── style-learning-enhanced.ts  # 风格学习
│   │   ├── domain-knowledge-collector.ts # 领域知识
│   │   ├── hot-event-monitor.ts        # 热点监控
│   │   └── quality-check-engine.ts     # 质检引擎
│   ├── content-engine/
│   │   ├── topic-recommender.ts   # 每日推荐（已有）
│   │   ├── quality-check-v2.ts    # 质检V2
│   │   ├── content-calendar.ts    # 内容日历
│   │   ├── content-repurpose.ts   # 内容二创
│   │   └── format-generators.ts   # 格式生成
│   ├── publisher/
│   │   ├── index.ts               # 发布核心（5平台适配器已有）
│   │   └── adapters/              # wechat/baijiahao/toutiao/zhihu/xiaohongshu
│   ├── crawler/
│   │   ├── index.ts               # 爬虫调度
│   │   └── *-crawler.ts           # 各平台爬虫（letpub/pubmed/arxiv/openalex等）
│   ├── ai/
│   │   ├── chat-service.ts        # AI 对话服务
│   │   ├── model-router.ts        # 模型路由（expensive/cheap）
│   │   └── providers/             # Anthropic/OpenAI/DeepSeek/Qwen
│   └── scheduler.ts               # BullMQ 定时任务
├── routes/
│   ├── chat.ts                    # 对话路由
│   ├── content.ts                 # 内容管理路由
│   ├── recommendations.ts         # 每日推荐路由
│   └── ...其他路由
└── index.ts                       # 服务入口

apps/web/src/
├── pages/
│   ├── DashboardPage.tsx          # 首页（含 TodayRecommendations）
│   ├── ChatPage.tsx               # 对话页
│   ├── ContentPage.tsx            # 内容管理页
│   └── ...其他页面
├── components/
│   └── SmartInput.tsx             # 智能输入框
└── hooks/
    └── useAuthStore.ts            # 认证状态
```

---

## 第一期：Agent 基础框架 + 知识飞轮 + 自动化核心

---

### Step 1: 数据库新增6张表

在 `packages/server/src/models/schema.ts` 末尾新增以下表定义（使用 Drizzle ORM，保持与现有表风格一致）：

**1. daily_content_plans — 每日内容计划表**
```typescript
export const dailyContentPlans = pgTable("daily_content_plans", {
  id: varchar("id", { length: 36 }).primaryKey(), // nanoid
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
  tasks: jsonb("tasks").notNull().default([]),
  totalArticles: integer("total_articles").default(0),
  totalVideos: integer("total_videos").default(0),
  status: varchar("status", { length: 20 }).default("draft"), // draft | approved | executing | completed
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_dcp_tenant_date").on(table.tenantId, table.date),
]);
```

**2. agent_logs — Agent 执行日志表**
```typescript
export const agentLogs = pgTable("agent_logs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  agentName: varchar("agent_name", { length: 50 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("running"), // running | completed | failed
  input: jsonb("input"),
  output: jsonb("output"),
  error: text("error"),
  durationMs: integer("duration_ms"),
  tokensUsed: integer("tokens_used").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_agent_logs_tenant_date").on(table.tenantId, table.createdAt),
]);
```

**3. boss_edits — 老板审核/修改记录表**
```typescript
export const bossEdits = pgTable("boss_edits", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  contentId: uuid("content_id").references(() => contents.id).notNull(),
  action: varchar("action", { length: 20 }).notNull(), // approve | edit | reject
  originalTitle: text("original_title"),
  editedTitle: text("edited_title"),
  originalBody: text("original_body"),
  editedBody: text("edited_body"),
  rejectReason: text("reject_reason"),
  editDistance: integer("edit_distance"),
  patternsExtracted: jsonb("patterns_extracted"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_boss_edits_tenant").on(table.tenantId, table.createdAt),
]);
```

**4. daily_reports — 每日运营报告表**
```typescript
export const dailyReports = pgTable("daily_reports", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  date: varchar("date", { length: 10 }).notNull(),
  report: jsonb("report").notNull(),
  aiSummary: text("ai_summary"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_daily_reports_tenant_date").on(table.tenantId, table.date),
]);
```

**5. peer_content_crawls — 同行内容抓取记录表**
```typescript
export const peerContentCrawls = pgTable("peer_content_crawls", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  competitorId: varchar("competitor_id", { length: 100 }).notNull(),
  platform: varchar("platform", { length: 30 }).notNull(),
  originalUrl: text("original_url").notNull(),
  title: text("title").notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(), // MD5 去重
  readCount: integer("read_count"),
  likeCount: integer("like_count"),
  knowledgeExtracted: boolean("knowledge_extracted").default(false),
  entriesCreated: integer("entries_created").default(0),
  crawledAt: timestamp("crawled_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_pcc_tenant_hash").on(table.tenantId, table.contentHash),
]);
```

**6. scheduled_publishes — 定时发布队列表**
```typescript
export const scheduledPublishes = pgTable("scheduled_publishes", {
  id: varchar("id", { length: 36 }).primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
  contentId: uuid("content_id").references(() => contents.id).notNull(),
  platform: varchar("platform", { length: 30 }).notNull(),
  accountId: varchar("account_id", { length: 100 }).notNull(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  status: varchar("status", { length: 20 }).default("pending"), // pending | published | failed
  publishedAt: timestamp("published_at"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_sp_pending").on(table.status, table.scheduledAt),
]);
```

**然后在 `packages/server/src/models/migrate.ts` 中新增对应的建表 SQL，执行迁移。**

**另外**，在 `tenants` 表的 `config` jsonb 字段中，增加 `automationConfig` 子结构：
```typescript
// 不需要改 schema，只需在代码中约定 config 中可包含：
interface TenantConfig {
  // ...已有字段
  automationConfig?: {
    stage: 'learning' | 'semi_auto' | 'full_auto'; // 默认 'learning'
    autoPublishThreshold: number;   // 默认 85
    pauseThreshold: number;         // 默认 60
    dailyArticleLimit: number;      // 默认 20
    dailyVideoLimit: number;        // 默认 5
    enabledPlatforms: Record<string, boolean>;
    topicBlacklist: string[];
    publishTimePreference: 'morning' | 'spread' | 'evening';
    tonePreference: 'professional' | 'casual' | 'storytelling' | 'academic';
    maxTokensPerArticle: number;    // 默认 10000
    autoUpgrade: boolean;           // 默认 true
  };
}
```

完成后运行 `pnpm build` 确认无错误。

---

### Step 2: Agent 基础框架（IAgent 接口 + AgentRegistry）

**创建目录** `packages/server/src/services/agents/base/`

**新建 `packages/server/src/services/agents/base/types.ts`**

定义以下接口（完整代码见 `AGENT-SYSTEM-PLAN.md` 模块 A1）：
- `IAgent` — Agent 统一接口：initialize, execute, handleTask, getStatus, shutdown
- `AgentConfig` — 配置：tenantId, concurrency, maxRetries, timeoutMs, settings
- `AgentContext` — 执行上下文：tenantId, date, plan, triggeredBy
- `AgentTask` — 子任务：id, agentName, type, priority, input, deadline, retryCount
- `AgentTaskResult` — 任务结果：taskId, success, output, error, metrics
- `AgentStatus` — 状态枚举：idle | running | paused | error | shutdown
- `AgentResult` — 执行结果：agentName, success, tasksCompleted, tasksFailed, summary, details

**新建 `packages/server/src/services/agents/base/registry.ts`**

- AgentRegistry 单例类，类似现有的 SkillRegistry
- methods: register, get, getAll, has, initializeAll, shutdownAll
- 内置 concurrency 配置：article-writer: 5, video-creator: 3, customer-service: 2, 其他: 1

**新建 `packages/server/src/services/agents/base/agent-logger.ts`**

Agent 执行日志工具：
```typescript
import { db } from '../../../models/db.js';
import { agentLogs } from '../../../models/schema.js';
import { nanoid } from 'nanoid';

export async function logAgentAction(params: {
  tenantId: string;
  agentName: string;
  action: string;
  status: 'running' | 'completed' | 'failed';
  input?: any;
  output?: any;
  error?: string;
  durationMs?: number;
  tokensUsed?: number;
}): Promise<string> {
  const id = nanoid(16);
  await db.insert(agentLogs).values({ id, ...params });
  return id;
}

export async function updateAgentLog(id: string, updates: Partial<{
  status: string;
  output: any;
  error: string;
  durationMs: number;
  tokensUsed: number;
}>): Promise<void> {
  await db.update(agentLogs).set(updates).where(eq(agentLogs.id, id));
}
```

完成后运行 `pnpm build` 确认无错误。

---

### Step 3: KnowledgeEngine Agent — 知识飞轮引擎

这是 Agent 系统的"弹药库"，必须最先实现。

**新建 `packages/server/src/services/agents/knowledge-engine.ts`**

实现 `IAgent` 接口，execute() 中执行 5 个阶段：

**Phase 1: crawlPeerContent** — 抓取同行爆款内容
- 从 `competitors` 表获取监控的同行账号（需确认 competitors 表已有数据，如果没有先跳过这步）
- 根据 platform 调用对应爬虫方法抓取最新文章
- 微信公众号：使用搜狗微信搜索 `https://weixin.sogou.com/weixin?type=1&query=账号名`，或通过已有的 `wechat-index-crawler.ts` 扩展
- 头条号：复用 `toutiao-crawler.ts`
- 知乎：复用 `zhihu-crawler.ts`
- 对每篇抓取的文章，先检查 `peer_content_crawls` 表的 content_hash 是否已存在（去重）
- 新文章调用 `extractKnowledge()` 方法：
  - 调用 `chat()` (skillType: 'daily_chat'，用 cheap 模型) 让 AI 从全文提取 5 个维度的知识：
    1. `content_format` — 标题公式、开头钩子、段落结构、CTA 手法
    2. `domain_knowledge` — 引用的数据、研究结论、事实
    3. `style` — 语气特点、修辞手法、过渡衔接
    4. `insight` — 为什么阅读量高？选题角度巧妙之处
    5. `hot_event` — 提到的时事热点
  - 每类最多 2 条，总共不超过 8 条
- 通过 `ingestToKnowledge()` （来自 `ingest-pipeline.ts`）将提取的知识存入对应子库
- 记录到 `peer_content_crawls` 表

**Phase 2: enhanceAcademicContent** — 学术全文增强
- 查询 `knowledgeEntries` 表中 category='domain_knowledge'、source 以 'PubMed' 开头、content 长度 < 2000 的条目（只有摘要的）
- 对每条，提取 PMID，尝试通过 PMC Open Access API 获取全文
  - API: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${PMCID}&rettype=xml`
  - 先调用 `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=${PMID}` 做 PMID→PMCID 转换
  - 如果有全文，AI 提取：核心发现、关键数据、方法创新、临床意义、背景知识
  - 通过 `ingestToKnowledge()` 存入 `domain_knowledge` 子库，source 标记为 `PubMed-fulltext:${PMID}`

**Phase 3: learnFromBossFeedback** — 老板反馈学习
- 查询 `boss_edits` 表最近 7 天的记录（如果表为空则跳过）
- 对 action='edit' 的记录，计算 original 和 edited 的 diff
- 调用 AI (cheap model) 分析修改模式，例如：
  - "老板把'据研究表明'改成'最新研究发现'" → 记住这个偏好
  - "老板在小红书内容中添加了分段符号" → 小红书风格偏好
- 提取的模式存入 `style` 子库，source 标记为 `boss-feedback:edit`

**Phase 4: healthCheck** — 知识库健康检查
- 统计各子库条目数
- 对低于阈值的子库生成告警（domain_knowledge < 50, content_format < 20, style < 10 等）
- 日志输出健康报告

**最后**，在 `packages/server/src/services/agents/base/registry.ts` 中导入并注册 KnowledgeEngineAgent。

完成后运行 `pnpm build` 确认无错误。

---

### Step 4: ContentDirector Agent — 总编辑

**新建 `packages/server/src/services/agents/content-director.ts`**

实现 `IAgent` 接口，核心方法 `generateDailyPlan()`：

1. 调用 `getTodayRecommendations(tenantId)` 获取今日推荐选题（来自 `topic-recommender.ts`）
2. 查询 `platformAccounts` 表获取所有 `isVerified=true && status='active'` 的账号
3. 读取 tenant config 中的 `automationConfig`（dailyArticleLimit, enabledPlatforms, topicBlacklist 等）
4. 为每个热词 × 每个启用平台生成一条 ContentTask：
   - 不同平台用不同风格：
     - wechat: deep_analysis, 2000字, 医学专业人士
     - baijiahao: popular_science, 1200字, 健康关注人群
     - toutiao: news_brief, 800字, 大众读者
     - zhihu: qa_format, 1500字, 知识型读者
     - xiaohongshu: listicle, 600字, 年轻用户
   - 爆发(exploding)和上升(rising)热词额外生成视频任务
   - 按最佳发布时段分配 scheduledPublishAt
   - 排除 topicBlacklist 中的话题
   - 总数不超过 dailyArticleLimit + dailyVideoLimit
5. 生成 `DailyContentPlan` 对象，存入 `daily_content_plans` 表
6. 返回 AgentResult

**接口定义**（写在同一文件顶部）：
```typescript
export interface DailyContentPlan {
  id: string;
  tenantId: string;
  date: string;
  tasks: ContentTask[];
  totalArticles: number;
  totalVideos: number;
  status: 'draft' | 'approved' | 'executing' | 'completed';
  generatedAt: string;
}

export interface ContentTask {
  id: string;
  type: 'article' | 'video' | 'repost';
  topic: string;
  style: 'deep_analysis' | 'popular_science' | 'news_brief' | 'qa_format' | 'listicle' | 'story';
  platform: string;
  accountId: string;
  wordCount: number;
  audience: string;
  referenceJournals: string[];
  scheduledPublishAt: string; // HH:mm
  priority: 'urgent' | 'high' | 'normal' | 'low';
  recommendationId?: string;
  status: 'pending' | 'writing' | 'quality_check' | 'review' | 'published' | 'failed';
}
```

注册到 AgentRegistry。

完成后运行 `pnpm build` 确认无错误。

---

### Step 5: Orchestrator Agent — 调度中心

**新建 `packages/server/src/services/agents/orchestrator.ts`**

实现 `IAgent` 接口，execute() 按以下顺序：

1. 调用 `knowledgeEngine.execute()` — 先更新知识库
2. 调用 `contentDirector.execute()` — 生成今日计划
3. 从 `daily_content_plans` 表读取今日计划
4. 读取 tenant 的 `automationConfig.stage`
5. 遍历计划中的 article 类型任务：
   - 构造 `contentQueue.add('article-write', {...}, { priority, delay })` 加入 BullMQ 队列
   - delay 根据 scheduledPublishAt 计算（提前 2 小时开始写，保证发布时已完成）
   - 更新任务 status 为 'writing'
6. 遍历 video 类型任务：
   - 构造 `contentQueue.add('video-create', {...})` 加入队列
7. 更新 plan status 为 'executing'
8. 记录 agent_logs

**辅助方法**：
- `getDailyProgress(tenantId)` — 返回当天的计划执行进度（pending/running/completed/failed 数量）
- `calculateDelay(scheduledTime: string)` — 根据目标发布时间计算任务延迟

注册到 AgentRegistry。

完成后运行 `pnpm build` 确认无错误。

---

### Step 6: ArticleWriter Worker 改造

**修改 `packages/server/src/services/task/content-worker.ts`**

在现有 Worker 的 job processor 中新增对 `article-write` job 类型的处理分支：

```typescript
if (job.name === 'article-write') {
  const { taskId, tenantId, topic, style, platform, accountId,
          wordCount, audience, referenceJournals, scheduledPublishAt } = job.data;

  // 1. 构造用户指令（模拟老板输入）
  const styleDescriptions = {
    deep_analysis: '深度分析文章，需要引用具体研究数据和期刊',
    popular_science: '通俗易懂的科普文章，适合大众阅读',
    news_brief: '简明扼要的资讯快报，突出关键发现',
    qa_format: '问答形式的知识科普，围绕常见疑问展开',
    listicle: '清单体轻量图文，要点分明适合快速浏览',
    story: '故事化叙述，以案例引入专业内容',
  };

  const userInput = `请写一篇关于"${topic}"的${styleDescriptions[style] || '专业文章'}。
目标平台：${platform}
目标字数：${wordCount}字
目标受众：${audience}
${referenceJournals.length > 0 ? `参考期刊：${referenceJournals.join('、')}` : ''}
写完后自动发布到${platform}。`;

  // 2. 调用 ArticleSkill（复用现有完整流水线）
  const skill = SkillRegistry.get('article');
  if (!skill) throw new Error('ArticleSkill not registered');

  const provider = await getProviderForTask('content_generation');
  const result = await skill.handle(userInput, [], {
    tenantId,
    userId: 'system',
    conversationId: `auto-${taskId}`,
    provider,
    metadata: {
      autoMode: true,
      planTaskId: taskId,
      publishPlatform: platform,
      publishAccountId: accountId,
      scheduledPublishAt,
    },
  });

  // 3. 根据 automationConfig.stage 决定后续流程
  const tenant = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const config = (tenant[0]?.config as any)?.automationConfig;
  const stage = config?.stage || 'learning';

  if (result.artifact) {
    const contentId = result.artifact.metadata?.contentId;
    const qualityScore = result.artifact.metadata?.qualityScore || 0;

    if (stage === 'full_auto' && qualityScore >= (config?.pauseThreshold || 60)) {
      // 全自动：直接加入定时发布队列
      await schedulePublish(tenantId, contentId, platform, accountId, scheduledPublishAt);
    } else if (stage === 'semi_auto' && qualityScore >= (config?.autoPublishThreshold || 85)) {
      // 半自动：高分自动发
      await schedulePublish(tenantId, contentId, platform, accountId, scheduledPublishAt);
    } else {
      // 学习期 or 低分：进待审队列
      await db.update(contents).set({ status: 'pending_review' }).where(eq(contents.id, contentId));
    }
  }

  // 4. 更新 daily_content_plans 中对应任务的 status
  // (通过 taskId 找到对应任务，更新 status 为 published/review/failed)
}
```

**新增辅助函数 `schedulePublish()`**：
```typescript
async function schedulePublish(
  tenantId: string,
  contentId: string,
  platform: string,
  accountId: string,
  scheduledTime: string, // HH:mm
): Promise<void> {
  const now = new Date();
  const [h, m] = scheduledTime.split(':').map(Number);
  const target = new Date();
  target.setHours(h, m, 0, 0);

  if (target <= now) {
    // 已过时间，立即发布
    const { publishToAccounts } = await import('../publisher/index.js');
    await publishToAccounts({ contentId, tenantId, accountIds: [accountId] });
  } else {
    // 加入定时发布表
    await db.insert(scheduledPublishes).values({
      id: nanoid(16),
      tenantId,
      contentId,
      platform,
      accountId,
      scheduledAt: target,
    });
  }
}
```

**在 content-worker.ts 中增加 Worker 的并发配置**：
```typescript
const worker = new Worker('content-generation', processor, {
  connection: redis,
  concurrency: 5, // 从原来的值改为5，支持并发写文章
});
```

完成后运行 `pnpm build` 确认无错误。

---

### Step 7: 定时发布 Worker

**新建 `packages/server/src/services/task/publish-worker.ts`**

创建一个 BullMQ 定时任务，每分钟检查 `scheduled_publishes` 表中到期的任务：

```typescript
import { Worker, Queue } from 'bullmq';
import { db } from '../../models/db.js';
import { scheduledPublishes } from '../../models/schema.js';
import { eq, and, lte } from 'drizzle-orm';
import { publishToAccounts } from '../publisher/index.js';
import { logger } from '../../config/logger.js';
import { redis } from './queue.js'; // 复用已有的 redis 连接

const publishQueue = new Queue('scheduled-publish', {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 50, removeOnFail: 20 },
});

// 每分钟检查一次
export async function startPublishWorker(): Promise<void> {
  await publishQueue.add('check-schedule', {}, {
    repeat: { every: 60_000 }, // 每60秒
    jobId: 'publish-check',
  });

  const worker = new Worker('scheduled-publish', async (job) => {
    const now = new Date();
    const pendingItems = await db
      .select()
      .from(scheduledPublishes)
      .where(and(
        eq(scheduledPublishes.status, 'pending'),
        lte(scheduledPublishes.scheduledAt, now),
      ))
      .limit(10);

    for (const item of pendingItems) {
      try {
        await publishToAccounts({
          contentId: item.contentId,
          tenantId: item.tenantId,
          accountIds: [item.accountId],
        });
        await db.update(scheduledPublishes).set({
          status: 'published',
          publishedAt: new Date(),
        }).where(eq(scheduledPublishes.id, item.id));

        logger.info({ id: item.id, platform: item.platform }, '[PublishWorker] 定时发布成功');
      } catch (err: any) {
        await db.update(scheduledPublishes).set({
          status: 'failed',
          error: err.message,
        }).where(eq(scheduledPublishes.id, item.id));

        logger.error({ id: item.id, err }, '[PublishWorker] 定时发布失败');
      }
    }
  }, { connection: redis, concurrency: 1 });
}
```

在 `packages/server/src/index.ts` 的服务启动中调用 `startPublishWorker()`。

完成后运行 `pnpm build` 确认无错误。

---

### Step 8: Scheduler 集成 Agent 时间线

**修改 `packages/server/src/services/scheduler.ts`**

在现有定时任务基础上，新增以下 cron 任务：

```typescript
import { agentRegistry } from './agents/base/registry.js';

// 在 initScheduler() 中增加：

// 06:30 — 知识引擎（在爬虫之后、总编辑之前）
await schedulerQueue.add('agent-knowledge-engine', {
  type: 'knowledge-engine-run',
}, {
  repeat: { pattern: '30 6 * * *', tz: 'Asia/Shanghai' },
  jobId: 'daily-knowledge-engine',
});

// 07:00 — Orchestrator 启动每日全流程（内部会依次调 ContentDirector → 分发任务）
await schedulerQueue.add('agent-orchestrator', {
  type: 'orchestrator-execute',
}, {
  repeat: { pattern: '0 7 * * *', tz: 'Asia/Shanghai' },
  jobId: 'daily-orchestrator',
});

// 11:00 — 知识引擎午间补充（抓同行上午发的内容）
await schedulerQueue.add('agent-knowledge-midday', {
  type: 'knowledge-engine-run',
}, {
  repeat: { pattern: '0 11 * * *', tz: 'Asia/Shanghai' },
  jobId: 'midday-knowledge-engine',
});

// 20:00 — 知识引擎晚间补充
await schedulerQueue.add('agent-knowledge-evening', {
  type: 'knowledge-engine-run',
}, {
  repeat: { pattern: '0 20 * * *', tz: 'Asia/Shanghai' },
  jobId: 'evening-knowledge-engine',
});

// 21:00 — DataAnalyst 生成日报（第2期实现，先占位）
// await schedulerQueue.add('agent-daily-report', {...});
```

**在 Worker 的 job processor 中新增处理分支**（scheduler.ts 的 Worker processor 中）：

```typescript
case 'knowledge-engine-run': {
  const ke = agentRegistry.get('knowledge-engine');
  if (ke) {
    // 对所有活跃租户执行
    const activeTenants = await db.select().from(tenants).where(eq(tenants.status, 'active'));
    for (const t of activeTenants) {
      await ke.execute({ tenantId: t.id, date: today, triggeredBy: 'scheduler' });
    }
  }
  break;
}

case 'orchestrator-execute': {
  const orch = agentRegistry.get('orchestrator');
  if (orch) {
    const activeTenants = await db.select().from(tenants).where(eq(tenants.status, 'active'));
    for (const t of activeTenants) {
      await orch.execute({ tenantId: t.id, date: today, triggeredBy: 'scheduler' });
    }
  }
  break;
}
```

**在服务启动 `index.ts` 中初始化 Agent 注册**：

```typescript
import { agentRegistry } from './services/agents/base/registry.js';
import { KnowledgeEngineAgent } from './services/agents/knowledge-engine.js';
import { ContentDirectorAgent } from './services/agents/content-director.js';
import { OrchestratorAgent } from './services/agents/orchestrator.js';

// 在 server 启动后：
agentRegistry.register(new KnowledgeEngineAgent());
agentRegistry.register(new ContentDirectorAgent());
agentRegistry.register(new OrchestratorAgent());
// 后续 Agent 在第2、3期注册
```

完成后运行 `pnpm build` 确认无错误。

---

### Step 9: 后端 API — Agent 状态 + 审核 + 计划

**新建 `packages/server/src/routes/agent-status.ts`**

```typescript
import { FastifyInstance } from 'fastify';
import { agentRegistry } from '../services/agents/base/registry.js';
import { db } from '../models/db.js';
import { dailyContentPlans, agentLogs, bossEdits, contents, scheduledPublishes } from '../models/schema.js';
import { eq, and, desc, gte } from 'drizzle-orm';

export async function agentRoutes(fastify: FastifyInstance) {

  // GET /api/v1/agents/status — 所有 Agent 状态
  fastify.get('/api/v1/agents/status', async (request) => {
    const agents = agentRegistry.getAll();
    return {
      agents: agents.map(a => ({
        name: a.name,
        displayName: a.displayName,
        status: a.getStatus(),
      })),
    };
  });

  // GET /api/v1/agents/daily-plan — 今日内容计划
  fastify.get('/api/v1/agents/daily-plan', async (request) => {
    const today = new Date().toISOString().slice(0, 10);
    const plan = await db.select().from(dailyContentPlans)
      .where(and(
        eq(dailyContentPlans.tenantId, request.tenantId),
        eq(dailyContentPlans.date, today),
      )).limit(1);
    return { plan: plan[0] || null };
  });

  // GET /api/v1/agents/logs?limit=20 — Agent 执行日志
  fastify.get('/api/v1/agents/logs', async (request) => {
    const { limit = 20 } = request.query as any;
    const logs = await db.select().from(agentLogs)
      .where(eq(agentLogs.tenantId, request.tenantId))
      .orderBy(desc(agentLogs.createdAt))
      .limit(Number(limit));
    return { logs };
  });

  // POST /api/v1/agents/:name/trigger — 手动触发 Agent
  fastify.post('/api/v1/agents/:name/trigger', async (request) => {
    const { name } = request.params as { name: string };
    const agent = agentRegistry.get(name);
    if (!agent) return { error: `Agent "${name}" not found` };

    const result = await agent.execute({
      tenantId: request.tenantId,
      date: new Date().toISOString().slice(0, 10),
      triggeredBy: 'manual',
    });
    return result;
  });

  // ===== 审核相关 =====

  // GET /api/v1/review/pending — 待审核内容列表
  fastify.get('/api/v1/review/pending', async (request) => {
    const pending = await db.select().from(contents)
      .where(and(
        eq(contents.tenantId, request.tenantId),
        eq(contents.status, 'pending_review'),
      ))
      .orderBy(desc(contents.createdAt))
      .limit(50);
    return { items: pending };
  });

  // POST /api/v1/review/:id/approve — 直接通过
  fastify.post('/api/v1/review/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    // 1. 更新 content status
    await db.update(contents).set({ status: 'approved' }).where(
      and(eq(contents.id, id), eq(contents.tenantId, request.tenantId))
    );
    // 2. 记录 boss_edits
    await db.insert(bossEdits).values({
      id: nanoid(16),
      tenantId: request.tenantId,
      contentId: id,
      action: 'approve',
    });
    // 3. 查找对应的 scheduled_publishes 或立即发布
    // TODO: 发布逻辑
    return { success: true };
  });

  // POST /api/v1/review/:id/edit — 修改后通过
  fastify.post('/api/v1/review/:id/edit', async (request) => {
    const { id } = request.params as { id: string };
    const { title, body } = request.body as { title?: string; body?: string };

    // 1. 读取原始内容
    const original = await db.select().from(contents)
      .where(and(eq(contents.id, id), eq(contents.tenantId, request.tenantId)))
      .limit(1);
    if (!original[0]) return { error: 'Content not found' };

    // 2. 更新内容
    const updates: any = { status: 'approved', updatedAt: new Date() };
    if (title) updates.title = title;
    if (body) updates.body = body;
    await db.update(contents).set(updates).where(eq(contents.id, id));

    // 3. 记录 boss_edits（含 diff）
    const editDistance = calculateEditDistance(original[0].body || '', body || '');
    await db.insert(bossEdits).values({
      id: nanoid(16),
      tenantId: request.tenantId,
      contentId: id,
      action: 'edit',
      originalTitle: original[0].title,
      editedTitle: title || original[0].title,
      originalBody: original[0].body,
      editedBody: body || original[0].body,
      editDistance,
    });

    return { success: true };
  });

  // POST /api/v1/review/:id/reject — 打回
  fastify.post('/api/v1/review/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    await db.update(contents).set({ status: 'rejected' }).where(
      and(eq(contents.id, id), eq(contents.tenantId, request.tenantId))
    );
    await db.insert(bossEdits).values({
      id: nanoid(16),
      tenantId: request.tenantId,
      contentId: id,
      action: 'reject',
      rejectReason: reason || '',
    });

    return { success: true };
  });

  // ===== 自动化配置 =====

  // GET /api/v1/agents/config — 获取自动化配置
  fastify.get('/api/v1/agents/config', async (request) => {
    const tenant = await db.select().from(tenants)
      .where(eq(tenants.id, request.tenantId)).limit(1);
    const config = (tenant[0]?.config as any)?.automationConfig || {
      stage: 'learning',
      autoPublishThreshold: 85,
      pauseThreshold: 60,
      dailyArticleLimit: 20,
      dailyVideoLimit: 5,
      enabledPlatforms: { wechat: true, baijiahao: true, toutiao: true, zhihu: true, xiaohongshu: true },
      topicBlacklist: [],
      autoUpgrade: true,
    };
    return { config };
  });

  // PATCH /api/v1/agents/config — 更新自动化配置
  fastify.patch('/api/v1/agents/config', async (request) => {
    const updates = request.body as any;
    const tenant = await db.select().from(tenants)
      .where(eq(tenants.id, request.tenantId)).limit(1);
    const currentConfig = (tenant[0]?.config as any) || {};
    currentConfig.automationConfig = {
      ...(currentConfig.automationConfig || {}),
      ...updates,
    };
    await db.update(tenants).set({ config: currentConfig })
      .where(eq(tenants.id, request.tenantId));
    return { success: true, config: currentConfig.automationConfig };
  });
}

// 简单编辑距离（Levenshtein 的简化版，按行 diff）
function calculateEditDistance(a: string, b: string): number {
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  let changes = 0;
  const maxLen = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < maxLen; i++) {
    if (linesA[i] !== linesB[i]) changes++;
  }
  return changes;
}
```

**在 `packages/server/src/index.ts` 中注册路由**：
```typescript
import { agentRoutes } from './routes/agent-status.js';
// 在路由注册部分：
await fastify.register(agentRoutes);
```

完成后运行 `pnpm build` 确认无错误。

---

### Step 10: 前端 — Dashboard 改造

**修改 `apps/web/src/pages/DashboardPage.tsx`**

在现有 TodayRecommendations 组件下方、三大入口卡片上方，新增两个组件：

**1. AgentStatusBar — Agent 运行状态条**

```tsx
function AgentStatusBar() {
  const [agents, setAgents] = useState<Array<{ name: string; displayName: string; status: string }>>([]);
  const [plan, setPlan] = useState<any>(null);

  useEffect(() => {
    api.get('/agents/status').then(res => setAgents(res.data?.agents || [])).catch(() => {});
    api.get('/agents/daily-plan').then(res => setPlan(res.data?.plan)).catch(() => {});
  }, []);

  if (agents.length === 0) return null;

  const statusColors: Record<string, string> = {
    running: 'bg-green-500',
    idle: 'bg-gray-300',
    error: 'bg-red-500',
    paused: 'bg-yellow-400',
  };

  const completed = plan?.tasks?.filter((t: any) => t.status === 'published').length || 0;
  const total = plan?.tasks?.length || 0;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mb-6 bg-white border border-gray-200 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-700">Agent 运行状态</h3>
        {plan && (
          <span className="text-xs text-gray-400">
            今日计划: {completed}/{total} 已完成 ({progress}%)
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        {agents.map(a => (
          <div key={a.name} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${statusColors[a.status] || 'bg-gray-300'}`} />
            <span className="text-xs text-gray-600">{a.displayName}</span>
          </div>
        ))}
      </div>
      {total > 0 && (
        <div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-gradient-to-r from-blue-500 to-green-500 rounded-full transition-all"
               style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}
```

**2. PendingReviewBanner — 待审核提醒横幅**

```tsx
function PendingReviewBanner() {
  const [count, setCount] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/review/pending').then(res => {
      setCount(res.data?.items?.length || 0);
    }).catch(() => {});
  }, []);

  if (count === 0) return null;

  return (
    <div className="mb-6 bg-amber-50 border-2 border-amber-200 rounded-2xl p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-2xl">📝</span>
        <div>
          <p className="text-sm font-bold text-amber-800">
            有 {count} 篇文章等待审核
          </p>
          <p className="text-xs text-amber-600">Agent 已完成写作和质检，等待您确认后发布</p>
        </div>
      </div>
      <button
        onClick={() => navigate('/content?status=pending_review')}
        className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-xl hover:bg-amber-600 transition"
      >
        去审核
      </button>
    </div>
  );
}
```

**3. 更新 DashboardPage 布局顺序**：

```tsx
<div className="max-w-6xl mx-auto py-10 px-6">
  <h1>你好，{user?.name}</h1>
  <p>...</p>

  {/* 1. 待审核提醒（最重要的行动项） */}
  <PendingReviewBanner />

  {/* 2. 今日选题推荐 */}
  <TodayRecommendations />

  {/* 3. Agent 运行状态 */}
  <AgentStatusBar />

  {/* 4. 三个主入口 */}
  <div className="grid grid-cols-3 ...">...</div>

  {/* 5. 智能输入框 */}
  <SmartInput />

  {/* 6. 工具区 */}
  <div className="grid grid-cols-2 ...">...</div>
</div>
```

完成后运行 `pnpm build` 和 `pnpm dev` 确认前后端均无错误。

---

### Step 11: 验证第一期

**验证清单**：

1. `pnpm build` 前后端均无编译错误
2. 数据库迁移成功，6 张新表已创建
3. 手动调用 `POST /api/v1/agents/orchestrator/trigger` 能触发完整流程：
   - 知识引擎执行（如果 competitors 表有数据则抓取同行内容）
   - 总编辑生成每日计划（如果有推荐数据则生成任务列表）
   - 调度中心分发任务到 BullMQ
4. `GET /api/v1/agents/status` 返回 3 个 Agent 的状态
5. `GET /api/v1/agents/daily-plan` 返回今日计划
6. `GET /api/v1/review/pending` 返回待审核内容
7. Dashboard 页面显示：待审横幅 + 今日推荐 + Agent 状态条 + 进度条
8. 在 learning 模式下，Agent 写完的文章进入 pending_review 状态（不自动发布）
9. 通过 `POST /api/v1/review/:id/approve` 可以审批通过并触发发布
10. `boss_edits` 表正确记录审核操作

---

## 第二期预告（第一期完成后再开始）

第二期将实现：
- CustomerService Agent（智能客服）
- DataAnalyst Agent（经营日报）
- 老板反馈学习闭环（boss_edits → 模式提取 → style 子库更新）
- 通知推送系统
- Dashboard 日报展示组件

第二期的详细指令将在第一期完成验证后提供。
