# BossMate Agent 自动化系统 — 实施方案

> 目标：把 BossMate 从"内容工具"升级为"AI 内容工厂"
> 老板角色：从"操作者"变成"审批者"——每天只看日报和审批异常

---

## 一、Agent 全景架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Orchestrator 调度中心                       │
│         (每日计划编排 · 异常处理 · 优先级调度 · 日报汇总)         │
└────┬──────────┬──────────┬──────────┬──────────┬────────────┘
     │          │          │          │          │
     ▼          ▼          ▼          ▼          ▼
┌─────────┐┌─────────┐┌─────────┐┌─────────┐┌─────────┐
│ContentDir││Article  ││Video    ││Customer ││Compete  │
│总编辑    ││Writer   ││Creator  ││Service  ││Watcher  │
│         ││图文写手  ││视频制作  ││智能客服  ││竞品监控  │
└─────────┘└─────────┘└─────────┘└─────────┘└─────────┘
     │          │          │          │          │
     ▼          ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────┐
│               DataAnalyst 数据分析师（晚 9 点汇总日报）          │
└─────────────────────────────────────────────────────────────┘
```

### 6 个 Agent 职责

| Agent | 角色 | 职责 | 运行方式 |
|-------|------|------|----------|
| **Orchestrator** | 调度中心 | 编排每日计划、分配任务、处理异常、汇总结果 | BullMQ 主 Worker |
| **ContentDirector** | 总编辑 | 根据热词+期刊生成每日内容计划（选题×平台×账号矩阵） | 每天 7:00 执行 |
| **ArticleWriter** | 图文写手 | 执行完整 ArticleSkill 流水线，并发5篇 | BullMQ 并发 Worker |
| **VideoCreator** | 视频制作 | 脚本→字幕→配音→封面→发布 | BullMQ 并发 Worker |
| **CustomerService** | 智能客服 | 监控各平台消息，AI 自动回复，复杂转人工 | 轮询 Worker（5min） |
| **CompetitorWatcher** | 竞品监控 | 监控竞品账号，分析策略，生成简报 | 每天 9:00 执行 |
| **DataAnalyst** | 数据分析师 | 采集各平台数据，生成经营日报推送老板 | 每天 21:00 执行 |

---

## 二、每日自动化时间线

```
06:00  ┌─ 爬虫启动（已有）：7平台热词 + 关键词分析
       │
07:00  ├─ ContentDirector 生成每日内容计划
       │    输入：热词推荐 + 期刊库 + 账号矩阵 + 历史表现
       │    输出：daily_content_plan（20-30条任务）
       │    ┌──────────────────────────────────────────────────────┐
       │    │ 任务1: "GLP-1受体激动剂" → 公众号A(深度) + 头条(科普) │
       │    │ 任务2: "SGLT2抑制剂"    → 知乎(问答) + 小红书(轻量)  │
       │    │ 任务3: "GLP-1受体激动剂" → 视频脚本 → 抖音/视频号     │
       │    │ ... 共20-30条                                        │
       │    └──────────────────────────────────────────────────────┘
       │
07:30  ├─ Orchestrator 开始分发任务
       │    → ArticleWriter ×5 并发写文章
       │    → VideoCreator  ×3 并发做视频
       │
08:00  ├─ CustomerService 启动（持续运行到 22:00）
       │    → 每5分钟轮询各平台新消息
       │    → AI 自动回复常见问题
       │    → 复杂问题标记 + 推送老板
       │
09:00  ├─ CompetitorWatcher 执行竞品分析
       │    → 抓取竞品最新内容
       │    → 分析爆款原因
       │    → 生成"竞品日简报"
       │
09:00  ├─ 第一批文章完成 → 质检 → 自动发布
~ 18:00│   (按最佳发布时间分批发布)
       │    → 早高峰 8-10: 公众号/头条 深度内容
       │    → 午间  12-13: 知乎/小红书 轻量内容
       │    → 晚高峰 18-20: 短视频 + 二次分发
       │
21:00  ├─ DataAnalyst 生成经营日报
       │    ┌──────────────────────────────────────────────┐
       │    │ 📊 4月3日经营日报                              │
       │    │ ✅ 发布：图文22篇 视频8条                      │
       │    │ 👀 总阅读：45,230  互动：1,892                 │
       │    │ 🔥 爆款：《GLP-1...》阅读12,000                │
       │    │ 💬 客服：回复128条 转人工3条                    │
       │    │ 🏆 竞品：XX号今日发了3篇关于...                 │
       │    │ 📋 明日建议：继续追GLP-1话题...                 │
       │    └──────────────────────────────────────────────┘
       │
22:00  └─ 系统休眠，等待明天 06:00
```

---

## 三、核心代码实现

### 模块 A：Agent 基础框架

#### A1. IAgent 接口（新建 `packages/server/src/services/agents/base/types.ts`）

```typescript
/**
 * Agent 统一接口
 * 每个 Agent 是一个独立的、有状态的工作单元
 */
export interface IAgent {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;

  /** 初始化（连接外部服务、加载配置） */
  initialize(config: AgentConfig): Promise<void>;

  /** 执行主任务 */
  execute(context: AgentContext): Promise<AgentResult>;

  /** 处理子任务（被 Orchestrator 调度时） */
  handleTask(task: AgentTask): Promise<AgentTaskResult>;

  /** 获取当前状态 */
  getStatus(): AgentStatus;

  /** 优雅停止 */
  shutdown(): Promise<void>;
}

export interface AgentConfig {
  tenantId: string;
  concurrency: number;
  maxRetries: number;
  timeoutMs: number;
  settings: Record<string, unknown>;
}

export interface AgentContext {
  tenantId: string;
  date: string; // YYYY-MM-DD
  plan?: DailyContentPlan;
  triggeredBy: 'scheduler' | 'manual' | 'orchestrator';
}

export interface AgentTask {
  id: string;
  agentName: string;
  type: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  input: Record<string, unknown>;
  deadline?: Date;
  retryCount: number;
}

export interface AgentTaskResult {
  taskId: string;
  success: boolean;
  output?: Record<string, unknown>;
  error?: string;
  metrics: {
    durationMs: number;
    tokensUsed: number;
    cost: number;
  };
}

export type AgentStatus = 'idle' | 'running' | 'paused' | 'error' | 'shutdown';

export interface AgentResult {
  agentName: string;
  success: boolean;
  tasksCompleted: number;
  tasksFailed: number;
  summary: string;
  details: AgentTaskResult[];
}
```

#### A2. AgentRegistry（新建 `packages/server/src/services/agents/base/registry.ts`）

```typescript
import type { IAgent } from './types.js';

/**
 * Agent 注册表 — 管理所有 Agent 实例的生命周期
 */
class AgentRegistry {
  private agents = new Map<string, IAgent>();
  private static instance: AgentRegistry;

  static getInstance(): AgentRegistry {
    if (!this.instance) this.instance = new AgentRegistry();
    return this.instance;
  }

  register(agent: IAgent): void {
    if (this.agents.has(agent.name)) {
      throw new Error(`Agent "${agent.name}" already registered`);
    }
    this.agents.set(agent.name, agent);
  }

  get(name: string): IAgent | undefined {
    return this.agents.get(name);
  }

  getAll(): IAgent[] {
    return Array.from(this.agents.values());
  }

  async initializeAll(tenantId: string): Promise<void> {
    for (const agent of this.agents.values()) {
      await agent.initialize({
        tenantId,
        concurrency: getAgentConcurrency(agent.name),
        maxRetries: 3,
        timeoutMs: 300_000,
        settings: {},
      });
    }
  }

  async shutdownAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      await agent.shutdown();
    }
  }
}

function getAgentConcurrency(name: string): number {
  const map: Record<string, number> = {
    'article-writer': 5,
    'video-creator': 3,
    'customer-service': 2,
    'content-director': 1,
    'competitor-watcher': 1,
    'data-analyst': 1,
  };
  return map[name] || 1;
}

export const agentRegistry = AgentRegistry.getInstance();
```

---

### 模块 B：ContentDirector 总编辑 Agent

#### B1. 新建 `packages/server/src/services/agents/content-director.ts`

```typescript
import type { IAgent, AgentConfig, AgentContext, AgentResult, AgentTask, AgentTaskResult, AgentStatus } from './base/types.js';
import { db } from '../../models/db.js';
import { keywords, journals, platformAccounts, contents, contentMetrics } from '../../models/schema.js';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { getTodayRecommendations } from '../content-engine/topic-recommender.js';
import { chat } from '../ai/chat-service.js';
import { logger } from '../../config/logger.js';
import { nanoid } from 'nanoid';

// ============ 每日内容计划 ============

export interface DailyContentPlan {
  id: string;
  tenantId: string;
  date: string;
  tasks: ContentTask[];
  totalArticles: number;
  totalVideos: number;
  generatedAt: string;
  status: 'draft' | 'approved' | 'executing' | 'completed';
}

export interface ContentTask {
  id: string;
  /** 类型：article=图文 video=视频 repost=二次分发 */
  type: 'article' | 'video' | 'repost';
  /** 关键词/选题 */
  topic: string;
  /** 内容风格 */
  style: 'deep_analysis' | 'popular_science' | 'news_brief' | 'qa_format' | 'listicle' | 'story';
  /** 目标平台 */
  platform: string;
  /** 目标账号 ID */
  accountId: string;
  /** 目标字数 */
  wordCount: number;
  /** 目标受众 */
  audience: string;
  /** 参考期刊 */
  referenceJournals: string[];
  /** 计划发布时间 */
  scheduledPublishAt: string;
  /** 优先级 */
  priority: 'urgent' | 'high' | 'normal' | 'low';
  /** 关联推荐 ID */
  recommendationId?: string;
  /** 执行状态 */
  status: 'pending' | 'writing' | 'quality_check' | 'published' | 'failed';
}

// ============ Agent 实现 ============

export class ContentDirectorAgent implements IAgent {
  readonly name = 'content-director';
  readonly displayName = '总编辑';
  readonly description = '根据热词趋势和账号矩阵，自动生成每日内容计划';

  private config!: AgentConfig;
  private status: AgentStatus = 'idle';

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
    this.status = 'idle';
  }

  getStatus(): AgentStatus { return this.status; }

  async execute(context: AgentContext): Promise<AgentResult> {
    this.status = 'running';
    const startTime = Date.now();

    try {
      const plan = await this.generateDailyPlan(context.tenantId, context.date);

      this.status = 'idle';
      return {
        agentName: this.name,
        success: true,
        tasksCompleted: plan.tasks.length,
        tasksFailed: 0,
        summary: `生成${plan.date}内容计划: ${plan.totalArticles}篇图文 + ${plan.totalVideos}条视频`,
        details: [],
      };
    } catch (err) {
      this.status = 'error';
      throw err;
    }
  }

  async handleTask(task: AgentTask): Promise<AgentTaskResult> {
    // ContentDirector 不处理子任务，它只生成计划
    return { taskId: task.id, success: false, error: 'ContentDirector does not handle subtasks', metrics: { durationMs: 0, tokensUsed: 0, cost: 0 } };
  }

  async shutdown(): Promise<void> { this.status = 'shutdown'; }

  // ============ 核心逻辑 ============

  async generateDailyPlan(tenantId: string, date: string): Promise<DailyContentPlan> {
    logger.info({ tenantId, date }, '[ContentDirector] 开始生成每日内容计划');

    // 1. 获取今日推荐选题
    const recommendations = await getTodayRecommendations(tenantId);
    const topics = recommendations.recommendations.slice(0, 10);

    // 2. 获取所有已验证账号
    const accounts = await db
      .select()
      .from(platformAccounts)
      .where(and(
        eq(platformAccounts.tenantId, tenantId),
        eq(platformAccounts.isVerified, true),
        eq(platformAccounts.status, 'active'),
      ));

    // 3. 获取各平台历史表现数据（用于智能分配）
    const recentPerformance = await this.getRecentPerformance(tenantId);

    // 4. AI 生成内容矩阵策略
    const strategy = await this.generateStrategy(topics, accounts, recentPerformance);

    // 5. 组装任务列表
    const tasks: ContentTask[] = [];

    for (const item of strategy) {
      tasks.push({
        id: nanoid(12),
        type: item.type,
        topic: item.topic,
        style: item.style,
        platform: item.platform,
        accountId: item.accountId,
        wordCount: item.wordCount,
        audience: item.audience,
        referenceJournals: item.referenceJournals,
        scheduledPublishAt: item.publishTime,
        priority: item.priority,
        recommendationId: item.recommendationId,
        status: 'pending',
      });
    }

    const plan: DailyContentPlan = {
      id: nanoid(16),
      tenantId,
      date,
      tasks,
      totalArticles: tasks.filter(t => t.type === 'article').length,
      totalVideos: tasks.filter(t => t.type === 'video').length,
      generatedAt: new Date().toISOString(),
      status: 'approved', // 全自动模式直接 approved
    };

    // 6. 存入数据库
    // 注意：需要新建 daily_content_plans 表
    // await db.insert(dailyContentPlans).values({ ... });

    logger.info({
      tenantId, date,
      articles: plan.totalArticles,
      videos: plan.totalVideos,
      totalTasks: tasks.length,
    }, '[ContentDirector] 每日内容计划生成完成');

    return plan;
  }

  private async getRecentPerformance(tenantId: string) {
    // 获取近7天各平台各话题的表现数据
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const metrics = await db
      .select({
        platform: contentMetrics.platform,
        views: sql<number>`avg(${contentMetrics.views})`,
        likes: sql<number>`avg(${contentMetrics.likes})`,
        comments: sql<number>`avg(${contentMetrics.comments})`,
      })
      .from(contentMetrics)
      .where(and(
        eq(contentMetrics.tenantId, tenantId),
        gte(contentMetrics.createdAt, sevenDaysAgo),
      ))
      .groupBy(contentMetrics.platform);

    return metrics;
  }

  private async generateStrategy(
    topics: any[],
    accounts: any[],
    performance: any[],
  ): Promise<Array<ContentTask & { publishTime: string; recommendationId?: string }>> {
    // 平台分组
    const accountsByPlatform = new Map<string, any[]>();
    for (const acc of accounts) {
      const list = accountsByPlatform.get(acc.platform) || [];
      list.push(acc);
      accountsByPlatform.set(acc.platform, list);
    }

    const platformStyles: Record<string, { style: ContentTask['style']; wordCount: number; audience: string }> = {
      wechat:     { style: 'deep_analysis', wordCount: 2000, audience: '医学专业人士' },
      baijiahao:  { style: 'popular_science', wordCount: 1200, audience: '健康关注人群' },
      toutiao:    { style: 'news_brief', wordCount: 800, audience: '大众读者' },
      zhihu:      { style: 'qa_format', wordCount: 1500, audience: '知识型读者' },
      xiaohongshu:{ style: 'listicle', wordCount: 600, audience: '年轻女性用户' },
    };

    // 最佳发布时间
    const publishSlots: Record<string, string[]> = {
      wechat:     ['08:00', '12:00', '18:00', '21:00'],
      baijiahao:  ['09:00', '14:00', '19:00'],
      toutiao:    ['07:30', '12:30', '18:30', '21:30'],
      zhihu:      ['10:00', '15:00', '20:00'],
      xiaohongshu:['12:00', '18:00', '21:00'],
    };

    const tasks: any[] = [];
    const usedSlots: Record<string, number> = {};

    for (const topic of topics) {
      // 每个话题 → 分发到多个平台（不同风格）
      for (const [platform, style] of Object.entries(platformStyles)) {
        const accs = accountsByPlatform.get(platform) || [];
        if (accs.length === 0) continue;

        const slots = publishSlots[platform] || ['10:00'];
        const slotIdx = (usedSlots[platform] || 0) % slots.length;
        usedSlots[platform] = (usedSlots[platform] || 0) + 1;

        // 图文任务
        tasks.push({
          type: 'article' as const,
          topic: topic.keyword,
          style: style.style,
          platform,
          accountId: accs[slotIdx % accs.length].id,
          wordCount: style.wordCount,
          audience: style.audience,
          referenceJournals: topic.relatedJournals?.map((j: any) => j.name) || [],
          publishTime: `${slots[slotIdx]}`,
          priority: topic.trend === 'exploding' ? 'urgent' as const : 'normal' as const,
          recommendationId: topic.id,
          status: 'pending' as const,
        });
      }

      // 爆发热词额外生成视频
      if (topic.trend === 'exploding' || topic.trend === 'rising') {
        const videoAccs = accountsByPlatform.get('toutiao') || accountsByPlatform.get('wechat') || [];
        if (videoAccs.length > 0) {
          tasks.push({
            type: 'video' as const,
            topic: topic.keyword,
            style: 'popular_science' as const,
            platform: 'toutiao',
            accountId: videoAccs[0].id,
            wordCount: 300, // 视频脚本字数
            audience: '大众读者',
            referenceJournals: topic.relatedJournals?.map((j: any) => j.name) || [],
            publishTime: '18:00',
            priority: 'high' as const,
            recommendationId: topic.id,
            status: 'pending' as const,
          });
        }
      }
    }

    return tasks;
  }
}
```

---

### 模块 C：Orchestrator 调度中心

#### C1. 新建 `packages/server/src/services/agents/orchestrator.ts`

```typescript
import type { IAgent, AgentConfig, AgentContext, AgentResult, AgentTask, AgentTaskResult, AgentStatus } from './base/types.js';
import type { DailyContentPlan, ContentTask } from './content-director.js';
import { agentRegistry } from './base/registry.js';
import { contentQueue } from '../task/queue.js';
import { logger } from '../../config/logger.js';
import { db } from '../../models/db.js';
import { nanoid } from 'nanoid';

/**
 * Orchestrator — 全局调度中心
 *
 * 职责：
 * 1. 按时间线触发各 Agent
 * 2. 监控任务执行进度
 * 3. 处理失败重试和异常上报
 * 4. 汇总每日执行报告
 */
export class OrchestratorAgent implements IAgent {
  readonly name = 'orchestrator';
  readonly displayName = '调度中心';
  readonly description = '编排每日全部 Agent 任务，监控进度，处理异常';

  private config!: AgentConfig;
  private status: AgentStatus = 'idle';
  private currentPlan: DailyContentPlan | null = null;
  private taskResults = new Map<string, AgentTaskResult>();

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
    this.status = 'idle';
  }

  getStatus(): AgentStatus { return this.status; }

  /**
   * 执行每日全流程
   * 被 scheduler 在 7:00 触发
   */
  async execute(context: AgentContext): Promise<AgentResult> {
    this.status = 'running';
    const startTime = Date.now();
    logger.info({ tenantId: context.tenantId, date: context.date }, '[Orchestrator] 启动每日自动化流程');

    try {
      // Phase 1: 总编辑生成计划
      const director = agentRegistry.get('content-director');
      if (!director) throw new Error('ContentDirector agent not found');

      const directorResult = await director.execute(context);
      // 获取计划（实际从 DB 读取）
      // this.currentPlan = await getDailyPlan(context.tenantId, context.date);

      // Phase 2: 分发图文任务到 ArticleWriter 队列
      const articleTasks = this.currentPlan?.tasks.filter(t => t.type === 'article') || [];
      for (const task of articleTasks) {
        await contentQueue.add('article-write', {
          taskId: task.id,
          tenantId: context.tenantId,
          topic: task.topic,
          style: task.style,
          platform: task.platform,
          accountId: task.accountId,
          wordCount: task.wordCount,
          audience: task.audience,
          referenceJournals: task.referenceJournals,
          scheduledPublishAt: task.scheduledPublishAt,
        }, {
          priority: task.priority === 'urgent' ? 1 : task.priority === 'high' ? 2 : 3,
          delay: this.calculateDelay(task.scheduledPublishAt),
          jobId: `article-${task.id}`,
        });
      }

      // Phase 3: 分发视频任务到 VideoCreator 队列
      const videoTasks = this.currentPlan?.tasks.filter(t => t.type === 'video') || [];
      for (const task of videoTasks) {
        await contentQueue.add('video-create', {
          taskId: task.id,
          tenantId: context.tenantId,
          topic: task.topic,
          platform: task.platform,
          accountId: task.accountId,
        }, {
          priority: 2,
          delay: this.calculateDelay(task.scheduledPublishAt),
          jobId: `video-${task.id}`,
        });
      }

      // Phase 4: 启动客服 Agent（如果未运行）
      const customerAgent = agentRegistry.get('customer-service');
      if (customerAgent && customerAgent.getStatus() !== 'running') {
        // 客服 agent 独立运行，不阻塞
        customerAgent.execute(context).catch(err =>
          logger.error({ err }, '[Orchestrator] CustomerService agent error')
        );
      }

      // Phase 5: 触发竞品监控
      const competitorAgent = agentRegistry.get('competitor-watcher');
      if (competitorAgent) {
        competitorAgent.execute(context).catch(err =>
          logger.error({ err }, '[Orchestrator] CompetitorWatcher agent error')
        );
      }

      this.status = 'idle';
      const duration = Date.now() - startTime;

      return {
        agentName: this.name,
        success: true,
        tasksCompleted: articleTasks.length + videoTasks.length,
        tasksFailed: 0,
        summary: `分发 ${articleTasks.length} 篇图文 + ${videoTasks.length} 条视频任务`,
        details: [],
      };

    } catch (err) {
      this.status = 'error';
      logger.error({ err }, '[Orchestrator] 每日流程执行失败');
      throw err;
    }
  }

  async handleTask(task: AgentTask): Promise<AgentTaskResult> {
    // Orchestrator 接收各 Agent 的完成回调
    this.taskResults.set(task.id, {
      taskId: task.id,
      success: true,
      metrics: { durationMs: 0, tokensUsed: 0, cost: 0 },
    });
    return this.taskResults.get(task.id)!;
  }

  async shutdown(): Promise<void> {
    this.status = 'shutdown';
  }

  /**
   * 根据计划发布时间计算延迟毫秒数
   */
  private calculateDelay(scheduledTime: string): number {
    const now = new Date();
    const [hours, minutes] = scheduledTime.split(':').map(Number);
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);

    // 如果目标时间已过，立即执行（减去2小时作为提前量，先写好等发布）
    const writeAheadMs = 2 * 60 * 60 * 1000; // 提前2小时开始写
    const delay = target.getTime() - writeAheadMs - now.getTime();
    return Math.max(0, delay);
  }

  /**
   * 获取今日执行进度（供 Dashboard API 调用）
   */
  async getDailyProgress(tenantId: string): Promise<{
    plan: DailyContentPlan | null;
    completed: number;
    failed: number;
    running: number;
    pending: number;
  }> {
    const plan = this.currentPlan;
    if (!plan) return { plan: null, completed: 0, failed: 0, running: 0, pending: 0 };

    return {
      plan,
      completed: plan.tasks.filter(t => t.status === 'published').length,
      failed: plan.tasks.filter(t => t.status === 'failed').length,
      running: plan.tasks.filter(t => t.status === 'writing' || t.status === 'quality_check').length,
      pending: plan.tasks.filter(t => t.status === 'pending').length,
    };
  }
}
```

---

### 模块 D：ArticleWriter Worker（改造现有 content-worker）

#### D1. 修改 `packages/server/src/services/task/content-worker.ts`

增加对 `article-write` 任务类型的处理，复用现有 ArticleSkill 但传入 ContentDirector 的参数：

```typescript
// 在现有 Worker 的 job processor 中增加分支

if (job.name === 'article-write') {
  const { taskId, tenantId, topic, style, platform, accountId,
          wordCount, audience, referenceJournals, scheduledPublishAt } = job.data;

  // 1. 构造用户指令（模拟老板输入）
  const userInput = buildArticlePrompt({
    topic,
    style,
    platform,
    wordCount,
    audience,
    referenceJournals,
  });

  // 2. 创建虚拟对话
  const conversationId = `auto-${taskId}`;

  // 3. 调用 ArticleSkill（复用现有完整流水线）
  const skill = skillRegistry.get('article');
  const result = await skill.handle(userInput, [], {
    tenantId,
    userId: 'system',
    conversationId,
    provider: await getProviderForTask('content_generation'),
    metadata: {
      autoMode: true,
      publishPlatform: platform,
      publishAccountId: accountId,
      scheduledPublishAt,
    },
  });

  // 4. 定时发布（如果还没到发布时间，加入发布队列）
  if (result.artifact) {
    await schedulePublish({
      contentId: result.artifact.metadata?.contentId,
      platform,
      accountId,
      scheduledAt: scheduledPublishAt,
    });
  }
}

function buildArticlePrompt(params: {
  topic: string;
  style: string;
  platform: string;
  wordCount: number;
  audience: string;
  referenceJournals: string[];
}): string {
  const styleMap: Record<string, string> = {
    deep_analysis: '深度分析文章，需要引用具体研究数据和期刊',
    popular_science: '通俗易懂的科普文章，适合大众阅读',
    news_brief: '简明扼要的资讯快报，突出关键发现',
    qa_format: '问答形式的知识科普，围绕常见疑问展开',
    listicle: '清单体轻量图文，要点分明适合快速浏览',
    story: '故事化叙述，以案例引入专业内容',
  };

  return `请写一篇关于"${params.topic}"的${styleMap[params.style] || '专业文章'}。
目标平台：${params.platform}
目标字数：${params.wordCount}字
目标受众：${params.audience}
${params.referenceJournals.length > 0 ? `参考期刊：${params.referenceJournals.join('、')}` : ''}
写完后自动发布到${params.platform}。`;
}
```

---

### 模块 E：CustomerService 智能客服 Agent

#### E1. 新建 `packages/server/src/services/agents/customer-service.ts`

```typescript
import type { IAgent, AgentConfig, AgentContext, AgentResult, AgentStatus } from './base/types.js';
import { db } from '../../models/db.js';
import { platformAccounts } from '../../models/schema.js';
import { eq, and } from 'drizzle-orm';
import { chat } from '../ai/chat-service.js';
import { logger } from '../../config/logger.js';

interface PlatformMessage {
  id: string;
  platform: string;
  userId: string;
  userName: string;
  content: string;
  receivedAt: Date;
}

interface ReplyDecision {
  shouldReply: boolean;
  reply?: string;
  needHuman: boolean;
  reason: string;
  category: 'faq' | 'consultation' | 'complaint' | 'spam' | 'complex';
}

export class CustomerServiceAgent implements IAgent {
  readonly name = 'customer-service';
  readonly displayName = '智能客服';
  readonly description = '监控各平台消息，AI自动回复，复杂问题转人工';

  private config!: AgentConfig;
  private status: AgentStatus = 'idle';
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
    this.status = 'idle';
  }

  getStatus(): AgentStatus { return this.status; }

  async execute(context: AgentContext): Promise<AgentResult> {
    this.status = 'running';
    let repliedCount = 0;
    let forwardedCount = 0;

    // 启动轮询（每5分钟检查一次各平台新消息）
    const poll = async () => {
      try {
        const accounts = await db
          .select()
          .from(platformAccounts)
          .where(and(
            eq(platformAccounts.tenantId, context.tenantId),
            eq(platformAccounts.isVerified, true),
          ));

        for (const account of accounts) {
          const messages = await this.fetchNewMessages(account);

          for (const msg of messages) {
            const decision = await this.analyzeMessage(msg, context.tenantId);

            if (decision.needHuman) {
              // 推送通知给老板
              await this.notifyBoss(context.tenantId, msg, decision);
              forwardedCount++;
            } else if (decision.shouldReply && decision.reply) {
              await this.sendReply(account, msg, decision.reply);
              repliedCount++;
            }
          }
        }
      } catch (err) {
        logger.error({ err }, '[CustomerService] 轮询失败');
      }
    };

    // 立即执行一次，然后每5分钟一次
    await poll();
    this.pollInterval = setInterval(poll, 5 * 60 * 1000);

    return {
      agentName: this.name,
      success: true,
      tasksCompleted: repliedCount,
      tasksFailed: forwardedCount,
      summary: `客服已启动: 已回复${repliedCount}条, 转人工${forwardedCount}条`,
      details: [],
    };
  }

  async handleTask() {
    return { taskId: '', success: true, metrics: { durationMs: 0, tokensUsed: 0, cost: 0 } };
  }

  async shutdown(): Promise<void> {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.status = 'shutdown';
  }

  private async fetchNewMessages(account: any): Promise<PlatformMessage[]> {
    // 根据平台调用对应 API 获取新消息
    // wechat: 客服消息接口
    // zhihu: 评论通知
    // toutiao: 评论+私信
    // 实现时根据各平台 API 文档接入
    return [];
  }

  private async analyzeMessage(msg: PlatformMessage, tenantId: string): Promise<ReplyDecision> {
    const result = await chat({
      tenantId,
      userId: 'system',
      conversationId: `cs-${msg.id}`,
      message: `你是医学科普账号的客服助手。分析以下用户消息，决定如何回复。

用户消息: "${msg.content}"

判断规则:
1. 简单问候/感谢 → 友好回复
2. 关于文章内容的提问 → 基于知识库回复
3. 咨询具体病情/用药 → 不能回答，标记转人工，提醒用户就医
4. 投诉/负面反馈 → 标记转人工
5. 广告/垃圾信息 → 忽略

回复格式(JSON):
{"shouldReply": true/false, "reply": "回复内容", "needHuman": true/false, "category": "faq|consultation|complaint|spam|complex", "reason": "判断理由"}`,
      skillType: 'customer_service',
    });

    try {
      const match = result.content.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch {}

    return { shouldReply: false, needHuman: true, reason: '无法解析', category: 'complex' };
  }

  private async sendReply(account: any, msg: PlatformMessage, reply: string): Promise<void> {
    // 调用各平台客服回复 API
    logger.info({ platform: account.platform, userId: msg.userId, reply }, '[CustomerService] 自动回复');
  }

  private async notifyBoss(tenantId: string, msg: PlatformMessage, decision: ReplyDecision): Promise<void> {
    // 插入 notifications 表，前端推送给老板
    logger.info({ tenantId, category: decision.category, content: msg.content }, '[CustomerService] 转人工通知');
  }
}
```

---

### 模块 F：DataAnalyst 日报 Agent

#### F1. 新建 `packages/server/src/services/agents/data-analyst.ts`

```typescript
import type { IAgent, AgentConfig, AgentContext, AgentResult, AgentStatus } from './base/types.js';
import { db } from '../../models/db.js';
import { contents, contentMetrics, distributionRecords, platformAccounts } from '../../models/schema.js';
import { eq, and, gte, sql, desc, count } from 'drizzle-orm';
import { chat } from '../ai/chat-service.js';
import { logger } from '../../config/logger.js';

export interface DailyReport {
  date: string;
  tenantId: string;
  // 生产数据
  production: {
    articlesPublished: number;
    videosPublished: number;
    totalWordCount: number;
    platformBreakdown: Record<string, number>;
  };
  // 传播数据
  distribution: {
    totalViews: number;
    totalLikes: number;
    totalComments: number;
    totalShares: number;
    platformMetrics: Array<{
      platform: string;
      views: number;
      likes: number;
      engagement: number;
    }>;
  };
  // 爆款识别
  topContent: Array<{
    title: string;
    platform: string;
    views: number;
    engagement: number;
  }>;
  // 客服数据
  customerService: {
    totalMessages: number;
    autoReplied: number;
    humanForwarded: number;
    avgResponseTime: number;
  };
  // 竞品摘要
  competitorHighlight: string;
  // AI 总结和建议
  aiSummary: string;
  aiSuggestions: string[];
}

export class DataAnalystAgent implements IAgent {
  readonly name = 'data-analyst';
  readonly displayName = '数据分析师';
  readonly description = '采集各平台数据，生成每日经营报告';

  private config!: AgentConfig;
  private status: AgentStatus = 'idle';

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
  }

  getStatus(): AgentStatus { return this.status; }

  async execute(context: AgentContext): Promise<AgentResult> {
    this.status = 'running';

    try {
      const report = await this.generateDailyReport(context.tenantId, context.date);

      // 存入数据库 + 推送通知给老板
      await this.saveAndNotify(report);

      this.status = 'idle';
      return {
        agentName: this.name,
        success: true,
        tasksCompleted: 1,
        tasksFailed: 0,
        summary: report.aiSummary,
        details: [],
      };
    } catch (err) {
      this.status = 'error';
      throw err;
    }
  }

  async handleTask() {
    return { taskId: '', success: true, metrics: { durationMs: 0, tokensUsed: 0, cost: 0 } };
  }

  async shutdown(): Promise<void> { this.status = 'shutdown'; }

  private async generateDailyReport(tenantId: string, date: string): Promise<DailyReport> {
    const todayStart = new Date(`${date}T00:00:00`);
    const todayEnd = new Date(`${date}T23:59:59`);

    // 1. 生产数据
    const publishedContents = await db
      .select()
      .from(contents)
      .where(and(
        eq(contents.tenantId, tenantId),
        eq(contents.status, 'published'),
        gte(contents.createdAt, todayStart),
      ));

    // 2. 传播数据
    const metrics = await db
      .select({
        platform: contentMetrics.platform,
        views: sql<number>`sum(${contentMetrics.views})`,
        likes: sql<number>`sum(${contentMetrics.likes})`,
        comments: sql<number>`sum(${contentMetrics.comments})`,
        shares: sql<number>`sum(${contentMetrics.shares})`,
      })
      .from(contentMetrics)
      .where(and(
        eq(contentMetrics.tenantId, tenantId),
        gte(contentMetrics.createdAt, todayStart),
      ))
      .groupBy(contentMetrics.platform);

    // 3. 爆款识别（阅读量 TOP 3）
    const topContents = await db
      .select()
      .from(contentMetrics)
      .where(and(
        eq(contentMetrics.tenantId, tenantId),
        gte(contentMetrics.createdAt, todayStart),
      ))
      .orderBy(desc(contentMetrics.views))
      .limit(3);

    // 4. AI 生成总结和建议
    const reportData = {
      articlesPublished: publishedContents.filter(c => c.type === 'article').length,
      videosPublished: publishedContents.filter(c => c.type === 'video').length,
      metrics,
      topContents,
    };

    const aiResult = await chat({
      tenantId,
      userId: 'system',
      conversationId: `daily-report-${date}`,
      message: `你是内容运营数据分析师。根据以下数据生成今日经营总结和明日建议。

数据: ${JSON.stringify(reportData)}

输出格式(JSON):
{"summary": "一句话总结今日表现", "suggestions": ["建议1", "建议2", "建议3"]}`,
      skillType: 'daily_chat',
    });

    let aiSummary = '今日数据汇总完成';
    let aiSuggestions: string[] = [];

    try {
      const match = aiResult.content.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        aiSummary = parsed.summary || aiSummary;
        aiSuggestions = parsed.suggestions || [];
      }
    } catch {}

    return {
      date,
      tenantId,
      production: {
        articlesPublished: reportData.articlesPublished,
        videosPublished: reportData.videosPublished,
        totalWordCount: publishedContents.reduce((sum, c) => sum + (c.body?.length || 0), 0),
        platformBreakdown: {},
      },
      distribution: {
        totalViews: metrics.reduce((s, m) => s + (m.views || 0), 0),
        totalLikes: metrics.reduce((s, m) => s + (m.likes || 0), 0),
        totalComments: metrics.reduce((s, m) => s + (m.comments || 0), 0),
        totalShares: metrics.reduce((s, m) => s + (m.shares || 0), 0),
        platformMetrics: metrics.map(m => ({
          platform: m.platform,
          views: m.views || 0,
          likes: m.likes || 0,
          engagement: ((m.likes || 0) + (m.comments || 0)) / Math.max(m.views || 1, 1),
        })),
      },
      topContent: [],
      customerService: { totalMessages: 0, autoReplied: 0, humanForwarded: 0, avgResponseTime: 0 },
      competitorHighlight: '',
      aiSummary,
      aiSuggestions,
    };
  }

  private async saveAndNotify(report: DailyReport): Promise<void> {
    // 1. 存入 daily_reports 表（需新建）
    // 2. 插入 notification 推送老板
    logger.info({ date: report.date, summary: report.aiSummary }, '[DataAnalyst] 日报生成完成');
  }
}
```

---

### 模块 G：Scheduler 集成（修改现有 scheduler.ts）

在现有 scheduler 中增加 Agent 调度时间线：

```typescript
// 新增定时任务

// 07:00 — ContentDirector 生成计划 + Orchestrator 分发任务
await schedulerQueue.add('agent-daily-run', {
  type: 'orchestrator-execute',
}, {
  repeat: { pattern: '0 7 * * *', tz: 'Asia/Shanghai' },
  jobId: 'daily-orchestrator',
});

// 08:00 — CustomerService 启动
await schedulerQueue.add('agent-customer-service', {
  type: 'customer-service-start',
}, {
  repeat: { pattern: '0 8 * * *', tz: 'Asia/Shanghai' },
  jobId: 'daily-customer-service',
});

// 09:00 — CompetitorWatcher 执行
await schedulerQueue.add('agent-competitor-watch', {
  type: 'competitor-watch',
}, {
  repeat: { pattern: '0 9 * * *', tz: 'Asia/Shanghai' },
  jobId: 'daily-competitor',
});

// 21:00 — DataAnalyst 生成日报
await schedulerQueue.add('agent-daily-report', {
  type: 'data-analyst-report',
}, {
  repeat: { pattern: '0 21 * * *', tz: 'Asia/Shanghai' },
  jobId: 'daily-report',
});

// Worker 处理增加 agent 类型
case 'orchestrator-execute': {
  const orchestrator = agentRegistry.get('orchestrator');
  await orchestrator?.execute({
    tenantId: job.data.tenantId || 'default',
    date: new Date().toISOString().slice(0, 10),
    triggeredBy: 'scheduler',
  });
  break;
}
```

---

### 模块 H：Dashboard API + 前端

#### H1. 新增 API 路由 `packages/server/src/routes/agent-status.ts`

```typescript
import { FastifyInstance } from 'fastify';
import { agentRegistry } from '../services/agents/base/registry.js';

export async function agentStatusRoutes(fastify: FastifyInstance) {
  // 获取所有 Agent 状态
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

  // 获取今日执行进度
  fastify.get('/api/v1/agents/daily-progress', async (request) => {
    const orchestrator = agentRegistry.get('orchestrator') as any;
    if (!orchestrator) return { plan: null };
    return orchestrator.getDailyProgress(request.tenantId);
  });

  // 手动触发某个 Agent
  fastify.post('/api/v1/agents/:name/trigger', async (request) => {
    const { name } = request.params as { name: string };
    const agent = agentRegistry.get(name);
    if (!agent) return { error: 'Agent not found' };

    const result = await agent.execute({
      tenantId: request.tenantId,
      date: new Date().toISOString().slice(0, 10),
      triggeredBy: 'manual',
    });

    return result;
  });
}
```

#### H2. 前端 Dashboard 新增 Agent 状态面板

在 DashboardPage.tsx 中添加 `AgentStatusPanel` 组件，显示：
- 6 个 Agent 的实时状态（运行中/空闲/错误）
- 今日内容计划进度条（已完成/进行中/待执行）
- 最新日报摘要
- 一键手动触发按钮

---

### 模块 I：数据库新增表

```sql
-- 每日内容计划表
CREATE TABLE IF NOT EXISTS daily_content_plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  date TEXT NOT NULL,
  tasks JSONB NOT NULL DEFAULT '[]',
  total_articles INTEGER DEFAULT 0,
  total_videos INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, date)
);

-- Agent 执行日志表
CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY DEFAULT nanoid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_name TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  input JSONB,
  output JSONB,
  error TEXT,
  duration_ms INTEGER,
  tokens_used INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_agent_logs_tenant_date ON agent_logs(tenant_id, created_at);

-- 每日运营报告表
CREATE TABLE IF NOT EXISTS daily_reports (
  id TEXT PRIMARY KEY DEFAULT nanoid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  date TEXT NOT NULL,
  report JSONB NOT NULL,
  ai_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, date)
);

-- 客服消息记录表
CREATE TABLE IF NOT EXISTS customer_messages (
  id TEXT PRIMARY KEY DEFAULT nanoid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  platform_user_name TEXT,
  direction TEXT NOT NULL DEFAULT 'incoming',
  content TEXT NOT NULL,
  reply TEXT,
  category TEXT,
  need_human BOOLEAN DEFAULT FALSE,
  replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_customer_messages_tenant ON customer_messages(tenant_id, created_at);

-- 定时发布队列表
CREATE TABLE IF NOT EXISTS scheduled_publishes (
  id TEXT PRIMARY KEY DEFAULT nanoid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  content_id TEXT NOT NULL REFERENCES contents(id),
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending',
  published_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_scheduled_publishes_pending ON scheduled_publishes(status, scheduled_at) WHERE status = 'pending';
```

---

## 四、知识飞轮自动化（KnowledgeEngine Agent）

### 4.0 现状问题

当前知识库 16 个子库的内容来源非常薄弱：
- PubMed 只抓了摘要（前 1500 字），没有全文
- 竞品分析只看已入库数据，不会主动抓同行爆款文章
- 没有定期抓取同行公众号/头条号/知乎的图文和视频内容
- 知识库积累靠人工触发，不是自动化的

**核心理念：知识库是 Agent 写文章的"弹药库"。弹药不够，枪法再准也没用。**

### 4.1 知识飞轮架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     知识飞轮 (Knowledge Flywheel)                  │
│                                                                    │
│   抓取层              提取层              沉淀层          应用层    │
│                                                                    │
│  ┌──────────┐    ┌──────────┐    ┌──────────────┐   ┌─────────┐  │
│  │同行爆款   │───▶│AI结构化  │───▶│知识库16子库   │──▶│RAG检索  │  │
│  │公众号全文 │    │提取      │    │              │   │喂给Agent│  │
│  │头条号全文 │    │标题公式  │    │domain_knowledge│   │         │  │
│  │知乎回答   │    │内容结构  │    │content_format │   │         │  │
│  │小红书笔记 │    │数据引用  │    │style         │   │         │  │
│  │抖音字幕   │    │情感钩子  │    │hot_event     │   │         │  │
│  └──────────┘    │写作手法  │    │insight       │   └─────────┘  │
│                  └──────────┘    └──────┬───────┘         │       │
│  ┌──────────┐                          │                  │       │
│  │PubMed    │────全文获取───────────────┤                  │       │
│  │arXiv     │                          │            ┌─────▼─────┐│
│  │OpenAlex  │                          │            │Agent写文章 ││
│  └──────────┘                          │            └─────┬─────┘│
│                                        │                  │       │
│  ┌──────────┐                   ┌──────▼───────┐   ┌─────▼─────┐│
│  │老板反馈   │──────────────────▶│偏好沉淀      │   │发布+数据  ││
│  │修改记录   │                  │style子库更新  │   │反馈回流   ││
│  │通过/打回  │                  └──────────────┘   └───────────┘│
│  └──────────┘                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 KnowledgeEngine Agent 实现

#### 新建 `packages/server/src/services/agents/knowledge-engine.ts`

```typescript
import type { IAgent, AgentConfig, AgentContext, AgentResult, AgentStatus } from './base/types.js';
import { db } from '../../models/db.js';
import { knowledgeEntries, keywords, journals, competitors } from '../../models/schema.js';
import { createEntries } from '../knowledge/knowledge-service.js';
import { ingestToKnowledge } from '../data-collection/ingest-pipeline.js';
import { chat } from '../ai/chat-service.js';
import { logger } from '../../config/logger.js';
import { eq, and, desc, gte } from 'drizzle-orm';

/**
 * KnowledgeEngine Agent — 知识飞轮引擎
 *
 * 职责：
 * 1. 定期抓取同行优质图文/视频内容
 * 2. AI 结构化提取知识点
 * 3. 沉淀到知识库 16 子库
 * 4. 学习老板反馈优化偏好库
 * 5. 知识库健康度监控
 */
export class KnowledgeEngineAgent implements IAgent {
  readonly name = 'knowledge-engine';
  readonly displayName = '知识引擎';
  readonly description = '自动抓取同行内容、积累知识库、学习老板偏好';

  private config!: AgentConfig;
  private status: AgentStatus = 'idle';

  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
  }

  getStatus(): AgentStatus { return this.status; }

  async execute(context: AgentContext): Promise<AgentResult> {
    this.status = 'running';
    let totalIngested = 0;

    try {
      // ===== Phase 1: 抓取同行爆款内容 =====
      const peerResults = await this.crawlPeerContent(context.tenantId);
      totalIngested += peerResults;

      // ===== Phase 2: 学术全文增强 =====
      const academicResults = await this.enhanceAcademicContent(context.tenantId);
      totalIngested += academicResults;

      // ===== Phase 3: 视频内容提取 =====
      const videoResults = await this.extractVideoKnowledge(context.tenantId);
      totalIngested += videoResults;

      // ===== Phase 4: 老板反馈学习 =====
      const feedbackResults = await this.learnFromBossFeedback(context.tenantId);
      totalIngested += feedbackResults;

      // ===== Phase 5: 知识库健康检查 =====
      await this.healthCheck(context.tenantId);

      this.status = 'idle';
      return {
        agentName: this.name,
        success: true,
        tasksCompleted: totalIngested,
        tasksFailed: 0,
        summary: `知识库新增 ${totalIngested} 条知识，飞轮运转正常`,
        details: [],
      };
    } catch (err) {
      this.status = 'error';
      throw err;
    }
  }

  async handleTask() {
    return { taskId: '', success: true, metrics: { durationMs: 0, tokensUsed: 0, cost: 0 } };
  }

  async shutdown(): Promise<void> { this.status = 'shutdown'; }

  // ===============================================
  // Phase 1: 抓取同行爆款图文内容
  // ===============================================

  private async crawlPeerContent(tenantId: string): Promise<number> {
    logger.info({ tenantId }, '[KnowledgeEngine] 开始抓取同行爆款内容');

    // 1. 从 competitors 表获取要监控的同行账号
    const peerAccounts = await db
      .select()
      .from(competitors)
      .where(eq(competitors.tenantId, tenantId));

    let ingested = 0;

    for (const peer of peerAccounts) {
      // 2. 根据平台调用对应爬虫抓最新内容
      const articles = await this.fetchPeerArticles(peer);

      for (const article of articles) {
        // 3. AI 结构化提取知识点
        const knowledge = await this.extractKnowledge(article, tenantId);

        // 4. 沉淀到对应子库
        for (const entry of knowledge) {
          await ingestToKnowledge({
            tenantId,
            category: entry.category,
            title: entry.title,
            content: entry.content,
            source: `peer:${peer.platform}:${peer.accountName}`,
            metadata: {
              originalTitle: article.title,
              originalUrl: article.url,
              readCount: article.readCount,
              likeCount: article.likeCount,
              crawledAt: new Date().toISOString(),
            },
          });
          ingested++;
        }
      }
    }

    logger.info({ tenantId, ingested }, '[KnowledgeEngine] 同行内容抓取完成');
    return ingested;
  }

  /**
   * 抓取同行最新文章（各平台适配）
   */
  private async fetchPeerArticles(peer: any): Promise<Array<{
    title: string;
    content: string;
    url: string;
    readCount: number;
    likeCount: number;
    publishedAt: string;
    platform: string;
  }>> {
    // 根据平台路由到不同的爬虫实现
    switch (peer.platform) {
      case 'wechat':
        return this.crawlWechatArticles(peer);
      case 'toutiao':
        return this.crawlToutiaoArticles(peer);
      case 'zhihu':
        return this.crawlZhihuArticles(peer);
      case 'xiaohongshu':
        return this.crawlXiaohongshuNotes(peer);
      default:
        return [];
    }
  }

  /**
   * 微信公众号爬虫 — 通过搜狗微信搜索 or 公众号历史消息接口
   */
  private async crawlWechatArticles(peer: any) {
    // 实现方案：
    // 方案A: 搜狗微信搜索 API（weixin.sogou.com）— 免费但有限制
    // 方案B: 新榜/西瓜数据 API — 付费但稳定
    // 方案C: 自建 Puppeteer 爬虫 — 需要维护但免费
    // 先返回空，具体实现根据老板预算决定
    return [];
  }

  private async crawlToutiaoArticles(peer: any) { return []; }
  private async crawlZhihuArticles(peer: any) { return []; }
  private async crawlXiaohongshuNotes(peer: any) { return []; }

  /**
   * AI 结构化提取：一篇文章 → 多条知识
   * 这是知识飞轮的核心步骤
   */
  private async extractKnowledge(article: any, tenantId: string): Promise<Array<{
    category: string;
    title: string;
    content: string;
  }>> {
    const result = await chat({
      tenantId,
      userId: 'system',
      conversationId: 'knowledge-extract',
      message: `你是知识提取专家。从以下文章中提取结构化知识，分类存入知识库。

文章标题: ${article.title}
文章内容(前3000字): ${article.content.slice(0, 3000)}
平台: ${article.platform}
阅读量: ${article.readCount}

请提取以下维度的知识(JSON数组)，每条知识独立成条:

1. content_format(内容格式) — 标题公式、开头钩子、段落结构、CTA手法
2. domain_knowledge(领域知识) — 文中引用的数据、结论、事实
3. style(风格) — 语气特点、修辞手法、过渡衔接方式
4. insight(策略洞察) — 为什么这篇阅读量高？选题角度有什么巧妙之处？
5. hot_event(热点) — 文中提到的时事热点或行业事件

输出JSON:
[{"category":"content_format","title":"标题公式:数字+痛点","content":"文章使用了..."},...]
每类最多提取2条，总共不超过8条。只提取有价值的，不要凑数。`,
      skillType: 'daily_chat',
    });

    try {
      const match = result.content.match(/\[[\s\S]*\]/);
      if (match) {
        const entries = JSON.parse(match[0]);
        return entries.filter((e: any) => e.category && e.title && e.content);
      }
    } catch {}
    return [];
  }

  // ===============================================
  // Phase 2: 学术全文增强
  // ===============================================

  private async enhanceAcademicContent(tenantId: string): Promise<number> {
    logger.info({ tenantId }, '[KnowledgeEngine] 开始增强学术全文');

    // 找到知识库中只有摘要的 PubMed 条目，尝试获取全文
    const abstractOnly = await db
      .select()
      .from(knowledgeEntries)
      .where(and(
        eq(knowledgeEntries.tenantId, tenantId),
        eq(knowledgeEntries.category, 'domain_knowledge'),
      ))
      .orderBy(desc(knowledgeEntries.createdAt))
      .limit(20);

    let enhanced = 0;

    for (const entry of abstractOnly) {
      const pmid = entry.source?.match(/PubMed - (\d+)/)?.[1];
      if (!pmid) continue;
      if ((entry.content?.length || 0) > 2000) continue; // 已经有较完整内容

      // 尝试通过 PMC 获取全文
      try {
        const fullText = await this.fetchPMCFullText(pmid);
        if (fullText && fullText.length > entry.content!.length) {
          // AI 提取全文关键知识点（不存全文，存提炼后的知识）
          const extracted = await this.extractAcademicKnowledge(
            entry.title!,
            fullText,
            tenantId,
          );

          for (const k of extracted) {
            await ingestToKnowledge({
              tenantId,
              category: 'domain_knowledge',
              title: k.title,
              content: k.content,
              source: `PubMed-fulltext:${pmid}`,
              metadata: { pmid, extractedFrom: 'full_text' },
            });
            enhanced++;
          }
        }
      } catch (err) {
        // 全文获取失败不阻塞
        continue;
      }
    }

    logger.info({ tenantId, enhanced }, '[KnowledgeEngine] 学术全文增强完成');
    return enhanced;
  }

  /**
   * 通过 PMC Open Access 获取全文
   */
  private async fetchPMCFullText(pmid: string): Promise<string | null> {
    // PubMed Central 全文API:
    // https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id={PMCID}&rettype=xml
    // 需要先 PMID → PMCID 转换
    // 注意：只有 Open Access 文章才有全文
    return null; // 具体实现
  }

  /**
   * 从学术全文中提取结构化知识
   */
  private async extractAcademicKnowledge(
    title: string,
    fullText: string,
    tenantId: string,
  ): Promise<Array<{ title: string; content: string }>> {
    const result = await chat({
      tenantId,
      userId: 'system',
      conversationId: 'academic-extract',
      message: `从以下学术论文中提取可用于科普文章写作的关键知识点:

论文标题: ${title}
论文内容(前5000字): ${fullText.slice(0, 5000)}

提取要求:
1. 核心发现 — 论文最重要的1-2个结论（用通俗语言）
2. 关键数据 — 可引用的具体数字/百分比/统计量
3. 方法创新 — 研究方法上的亮点（如有）
4. 临床意义 — 对实际应用的影响
5. 背景知识 — 理解这篇论文需要的前置知识

输出JSON: [{"title":"核心发现:...", "content":"..."},...]
每条200字以内，提取3-5条高价值知识即可。`,
      skillType: 'daily_chat',
    });

    try {
      const match = result.content.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
    } catch {}
    return [];
  }

  // ===============================================
  // Phase 3: 视频内容提取
  // ===============================================

  private async extractVideoKnowledge(tenantId: string): Promise<number> {
    logger.info({ tenantId }, '[KnowledgeEngine] 开始提取视频知识');

    // 从竞品视频中提取知识
    // 方案: 抓取字幕/文案 → AI 结构化
    // 抖音/视频号的视频通常有字幕，可以通过:
    // 1. 平台 API 获取字幕文件
    // 2. 第三方转写服务（如讯飞、阿里云语音转文字）
    // 3. 部分平台提供文字版内容

    // 这里先实现框架，具体爬虫后续接入
    return 0;
  }

  // ===============================================
  // Phase 4: 老板反馈学习
  // ===============================================

  private async learnFromBossFeedback(tenantId: string): Promise<number> {
    logger.info({ tenantId }, '[KnowledgeEngine] 开始学习老板反馈');

    // 从审核记录中提取老板偏好
    // 1. 获取最近被老板修改过的文章
    // 2. diff 分析：老板改了什么？
    // 3. 提取模式 → 存入 style 子库

    // 查询最近的审核记录（boss_edits 表，需新建）
    // const recentEdits = await db.select()...

    // AI 分析修改模式
    // const patterns = await this.analyzeEditPatterns(recentEdits);

    // 存入 style 子库
    // for (const pattern of patterns) {
    //   await ingestToKnowledge({ category: 'style', ... });
    // }

    return 0; // 具体实现
  }

  // ===============================================
  // Phase 5: 知识库健康检查
  // ===============================================

  private async healthCheck(tenantId: string): Promise<void> {
    const stats = await db
      .select({
        category: knowledgeEntries.category,
        count: db.$count(knowledgeEntries),
      })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.tenantId, tenantId))
      .groupBy(knowledgeEntries.category);

    const healthReport = {
      totalEntries: stats.reduce((sum, s) => sum + Number(s.count), 0),
      categories: Object.fromEntries(stats.map(s => [s.category, Number(s.count)])),
      warnings: [] as string[],
    };

    // 检查薄弱子库
    const minThresholds: Record<string, number> = {
      domain_knowledge: 50,
      content_format: 20,
      style: 10,
      hot_event: 5,
      insight: 10,
      keyword: 30,
    };

    for (const [cat, min] of Object.entries(minThresholds)) {
      const current = healthReport.categories[cat] || 0;
      if (current < min) {
        healthReport.warnings.push(
          `${cat} 子库只有 ${current} 条（建议 ≥${min}），需要加强积累`
        );
      }
    }

    if (healthReport.warnings.length > 0) {
      logger.warn({ tenantId, warnings: healthReport.warnings }, '[KnowledgeEngine] 知识库健康告警');
      // 推送告警到通知系统
    }

    logger.info({ tenantId, ...healthReport }, '[KnowledgeEngine] 知识库健康检查完成');
  }
}
```

### 4.3 知识飞轮调度集成

在 Scheduler 中增加知识引擎的定时任务：

```typescript
// 每天 6:30 — 知识引擎先于 ContentDirector 运行
// 确保 Agent 写文章时知识库是最新的
await schedulerQueue.add('agent-knowledge-engine', {
  type: 'knowledge-engine-run',
}, {
  repeat: { pattern: '30 6 * * *', tz: 'Asia/Shanghai' },
  jobId: 'daily-knowledge-engine',
});

// 每天 11:00 — 午间补充抓取（同行上午发的内容）
await schedulerQueue.add('agent-knowledge-midday', {
  type: 'knowledge-engine-run',
}, {
  repeat: { pattern: '0 11 * * *', tz: 'Asia/Shanghai' },
  jobId: 'midday-knowledge-engine',
});

// 每天 20:00 — 晚间补充抓取（同行下午发的内容）
await schedulerQueue.add('agent-knowledge-evening', {
  type: 'knowledge-engine-run',
}, {
  repeat: { pattern: '0 20 * * *', tz: 'Asia/Shanghai' },
  jobId: 'evening-knowledge-engine',
});
```

### 4.4 新增数据库表

```sql
-- 老板审核/修改记录表（用于反馈学习）
CREATE TABLE IF NOT EXISTS boss_edits (
  id TEXT PRIMARY KEY DEFAULT nanoid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  content_id TEXT NOT NULL REFERENCES contents(id),
  action TEXT NOT NULL, -- 'approve' | 'edit' | 'reject'
  original_title TEXT,
  edited_title TEXT,
  original_body TEXT,
  edited_body TEXT,
  reject_reason TEXT,
  edit_distance INTEGER, -- 编辑距离，衡量修改幅度
  patterns_extracted JSONB, -- AI 提取的修改模式
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_boss_edits_tenant ON boss_edits(tenant_id, created_at);

-- 同行内容抓取记录表（去重 + 追踪）
CREATE TABLE IF NOT EXISTS peer_content_crawls (
  id TEXT PRIMARY KEY DEFAULT nanoid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  competitor_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  original_url TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL, -- 内容 MD5，用于去重
  read_count INTEGER,
  like_count INTEGER,
  knowledge_extracted BOOLEAN DEFAULT FALSE,
  entries_created INTEGER DEFAULT 0,
  crawled_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, content_hash) -- 同一内容不重复抓取
);
```

### 4.5 完整时间线（更新）

```
06:00  ┌─ 爬虫启动：7平台热词抓取
06:30  ├─ 知识引擎(第1轮)：抓同行昨晚发的内容 → 提取知识 → 入库
07:00  ├─ 总编辑：生成每日内容计划（此时知识库已是最新）
07:30  ├─ 调度中心：分发任务给 5 个写手 Agent + 3 个视频 Agent
08:00  ├─ 智能客服启动
09:00  ├─ 竞品监控
09:00~18:00  ├─ 内容按计划分批发布
11:00  ├─ 知识引擎(第2轮)：抓同行上午内容
20:00  ├─ 知识引擎(第3轮)：抓同行下午内容
21:00  ├─ 数据分析师：生成日报
22:00  └─ 风格学习：从今天发布内容+老板反馈中学习
```

---

## 四-续、实施路线（分 4 期）

### 第 1 期：核心框架 + 知识飞轮（5-7 天）
- [ ] Agent 基础接口（IAgent, AgentConfig, AgentTask）+ AgentRegistry
- [ ] KnowledgeEngine Agent（同行抓取 + AI提取 + 入库 + 健康检查）
- [ ] ContentDirector 实现（每日计划生成）
- [ ] Orchestrator 实现（任务分发 + 进度监控）
- [ ] ArticleWriter Worker 改造（并发5篇，复用 ArticleSkill）
- [ ] 渐进式放权系统（AutomationConfig + ReviewPanel）
- [ ] 新增 6 张数据库表（daily_content_plans, agent_logs, boss_edits, peer_content_crawls, daily_reports, scheduled_publishes）
- [ ] Dashboard: AgentStatusPanel + 待审队列 + 今日计划进度
- [ ] Scheduler 集成完整 Agent 时间线（6:30 知识引擎 → 7:00 总编辑 → 7:30 分发）
- **交付物**：老板看到每日计划 + 审核队列 + 知识库自动增长

### 第 2 期：智能客服 + 日报 + 反馈学习（5-7 天）
- [ ] CustomerService Agent（消息轮询 + AI分类 + 自动回复 + 转人工）
- [ ] DataAnalyst Agent（数据采集 + 日报生成 + 明日建议）
- [ ] 老板反馈学习闭环（boss_edits → 模式提取 → style 子库更新）
- [ ] 知识引擎增强：学术全文增强（PMC Open Access 全文获取）
- [ ] 通知推送系统（WebSocket + 微信模板消息）
- [ ] Dashboard: 日报展示 + 老板调试控制面板
- **交付物**：老板每晚收到日报 + 修改反馈自动学习

### 第 3 期：视频 + 竞品 + 定时发布（5-7 天）
- [ ] VideoCreator Agent（脚本 + 字幕 + TTS配音框架）
- [ ] CompetitorWatcher Agent（竞品爆款抓取 + 策略分析 + 知识沉淀）
- [ ] 定时发布系统（按最佳时间段自动分批发布）
- [ ] 知识引擎增强：视频字幕提取 → 知识入库
- [ ] Agent 异常自愈 + 告警 + 降级策略
- **交付物**：视频自动化 + 竞品情报 + 全时段智能发布

### 第 4 期：优化 + 规模化（3-5 天）
- [ ] Token 预算管理（每日上限 + 各 Agent 配额）
- [ ] 并发控制优化（20篇→100篇的扩展能力）
- [ ] 知识库自动清理（过期条目淘汰 + 去重优化）
- [ ] 阶段自动升级（学习期→半自动→全自动的智能判断）
- [ ] 全链路监控 Dashboard（Agent 实时状态 + 知识库增长曲线 + 成本追踪）
- **交付物**：可规模化运行的完整 AI 内容工厂

---

## 五、渐进式放权 + 老板调试系统

### 5.0 三阶段自动化模式

```typescript
// 新增 tenant 级配置
interface AutomationConfig {
  /** 当前阶段 */
  stage: 'learning' | 'semi_auto' | 'full_auto';
  /** 自动发布的质检分数阈值（仅 semi_auto 使用） */
  autoPublishThreshold: number; // 默认 85
  /** 异常暂停阈值（低于此分不发布，通知老板） */
  pauseThreshold: number; // 默认 60
  /** 老板偏好标签（从审核反馈中自动学习） */
  bossPreferences: {
    preferredStyles: string[];     // 喜欢的风格
    avoidPatterns: string[];       // 不喜欢的表达
    platformTone: Record<string, string>; // 各平台语气偏好
    avgEditDistance: number;       // 老板平均修改幅度（越小=越信任AI）
  };
  /** 统计 */
  stats: {
    totalReviewed: number;
    approvedRate: number;      // 直接通过率
    editedRate: number;        // 修改后通过率
    rejectedRate: number;      // 打回率
  };
  /** 自动升级条件：连续7天通过率>90%自动进入下一阶段 */
  autoUpgrade: boolean;
}
```

### 阶段 1: 学习期（前 1-2 周）

```
Agent 写完文章
  ↓
质检通过 → 进入"待审队列"（不发布）
  ↓
老板在 Dashboard 看到待审列表
  ↓
三种操作：
  ✅ 直接通过 → 发布 + 记录"老板认可此风格"
  ✏️ 修改后发布 → 发布 + diff 记录老板改了什么
  ❌ 打回 → 不发布 + 记录原因
  ↓
系统学习老板偏好（style-learning-enhanced 已有此能力）
```

**老板调试面板（ReviewPanel 组件）核心功能：**

```typescript
// GET /api/v1/review/pending — 待审核内容列表
interface ReviewItem {
  id: string;
  title: string;
  platform: string;
  qualityScore: number;
  preview: string;        // 前200字预览
  generatedAt: string;
  topic: string;
  style: string;
}

// POST /api/v1/review/:id/approve — 直接通过
// POST /api/v1/review/:id/edit — 修改后通过（body包含修改后的内容）
// POST /api/v1/review/:id/reject — 打回（body包含打回原因）

// 修改记录会自动传入 style-learning 系统：
interface BossEdit {
  contentId: string;
  originalText: string;
  editedText: string;
  editType: 'title' | 'body' | 'structure' | 'tone';
  timestamp: string;
}
// → 系统从 diff 中提取模式：
//   "老板把所有'据研究表明'改成了'最新研究发现'" → 记住这个偏好
//   "老板总是删掉结尾的免责声明" → 下次不加
//   "老板在小红书的文章里加了emoji" → 小红书风格加emoji
```

### 阶段 2: 半自动期（2-4 周）

```
Agent 写完文章
  ↓
质检评分
  ↓
≥ 85分 → 自动发布（但日报中标记）
60-84分 → 进待审队列
< 60分 → 自动暂停 + 推送告警
  ↓
老板只审核中间段（每天约 3-5 篇）
```

**自动升级条件：** 连续 7 天，老板的"直接通过率" > 90% → 系统自动建议升级到全自动，老板确认即可。

### 阶段 3: 全自动期

```
Agent 写完文章
  ↓
质检通过 → 自动发布
质检 < 60 → 暂停 + 告警
  ↓
老板只看日报 + 处理异常
```

### 调试工具集

**老板可调的参数（Settings 页面）：**

```typescript
interface BossControlPanel {
  // 1. 全局开关
  automationStage: 'learning' | 'semi_auto' | 'full_auto';

  // 2. 每日产量控制
  dailyArticleLimit: number;     // 默认 20
  dailyVideoLimit: number;       // 默认 5

  // 3. 平台开关（可以关掉某个平台）
  enabledPlatforms: {
    wechat: boolean;
    baijiahao: boolean;
    toutiao: boolean;
    zhihu: boolean;
    xiaohongshu: boolean;
  };

  // 4. 话题黑名单（不想碰的话题）
  topicBlacklist: string[];      // 如 ["政治", "争议"]

  // 5. 发布时间偏好
  publishTimePreference: 'morning' | 'spread' | 'evening' | 'custom';

  // 6. 质量阈值
  qualityThreshold: number;      // 60-100 可调

  // 7. 风格偏好（从学习期自动填充，老板也可手动调）
  tonePreference: 'professional' | 'casual' | 'storytelling' | 'academic';

  // 8. 单篇 Token 预算上限
  maxTokensPerArticle: number;   // 控制成本
}
```

**调试快捷操作：**
- 「暂停所有 Agent」— 一键停止所有自动化
- 「重新生成今日计划」— 不满意计划时重新来
- 「跳过这个话题」— 从今日计划中移除某个选题
- 「立即发布」— 手动触发待审内容发布
- 「查看 Agent 日志」— 看每个 Agent 做了什么，为什么做这个决定

---

## 六、关键设计决策

### 6.1 为什么不用 LangChain/AutoGPT 框架？
BossMate 的 Agent 是**业务流程编排**，不是通用推理。用 BullMQ + IAgent 接口 = 更轻量、更可控、更容易调试。

### 6.2 Token 成本控制
- 20篇文章/天 × 2000字 × 输入输出 ≈ 每日 80万 tokens
- 用 cheap tier（DeepSeek/Qwen）做客服和日报
- 用 expensive tier（Claude/GPT-4o）做文章质检和生成
- 预估月成本：¥500-1500（取决于模型选择）

### 6.3 并发和吞吐
- ArticleWriter 并发 5 → 每篇约 3-5 分钟 → 1小时写 60-100 篇
- 20篇/天对系统毫无压力，可轻松扩展到 100+

### 6.4 容错设计
- 每个 Agent 独立运行，一个挂了不影响其他
- BullMQ 自带重试（指数退避，最多3次）
- Orchestrator 监控全局，异常推送老板
- Agent 日志全部入库，可追溯排查
