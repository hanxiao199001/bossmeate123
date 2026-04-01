import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uuid,
  index,
  date,
  real,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ============ 租户表 ============
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 50 }).unique().notNull(), // 租户标识，如 "journal-pub-01"
  plan: varchar("plan", { length: 20 }).notNull().default("trial"), // trial | basic | pro
  status: varchar("status", { length: 20 }).notNull().default("active"), // active | suspended
  config: jsonb("config").default({}), // 租户级别配置（模型偏好、Token限额等）
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============ 用户表 ============
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 20 }),
    passwordHash: text("password_hash").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    role: varchar("role", { length: 20 }).notNull().default("member"), // owner | admin | member
    avatar: text("avatar"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_users_tenant").on(table.tenantId),
    index("idx_users_email").on(table.email),
  ]
);

// ============ 对话/会话表 ============
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    title: varchar("title", { length: 200 }).default("新对话"),
    skillType: varchar("skill_type", { length: 50 }), // article | video | customer_service
    status: varchar("status", { length: 20 }).notNull().default("active"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_conv_tenant").on(table.tenantId),
    index("idx_conv_user").on(table.userId),
  ]
);

// ============ 消息表 ============
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    conversationId: uuid("conversation_id")
      .references(() => conversations.id)
      .notNull(),
    role: varchar("role", { length: 20 }).notNull(), // user | assistant | system
    content: text("content").notNull(),
    model: varchar("model", { length: 50 }), // 哪个模型生成的
    tokensUsed: integer("tokens_used").default(0),
    metadata: jsonb("metadata").default({}), // 附加信息（图片URL、引用来源等）
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_msg_conv").on(table.conversationId),
    index("idx_msg_tenant").on(table.tenantId),
  ]
);

// ============ 内容资产表（图文线产出）============
export const contents = pgTable(
  "contents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id),
    type: varchar("type", { length: 20 }).notNull(), // article | video_script | reply
    title: varchar("title", { length: 300 }),
    body: text("body"), // 正文内容（Markdown）
    status: varchar("status", { length: 20 }).notNull().default("draft"), // draft | reviewing | approved | published
    platforms: jsonb("platforms").default([]), // 发布到的平台 [{platform, publishedAt, url}]
    tokensTotal: integer("tokens_total").default(0), // 生成消耗的Token总量
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_content_tenant").on(table.tenantId),
    index("idx_content_user").on(table.userId),
    index("idx_content_type").on(table.type),
  ]
);

// ============ Token 用量日志 ============
export const tokenLogs = pgTable(
  "token_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    model: varchar("model", { length: 50 }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: integer("cost_usd_cents").default(0), // 美分
    skillType: varchar("skill_type", { length: 50 }), // 哪条业务线
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_token_tenant").on(table.tenantId),
    index("idx_token_created").on(table.createdAt),
  ]
);

// ============ 关键词库（Agent 1 & 2）============
export const keywords = pgTable(
  "keywords",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    keyword: varchar("keyword", { length: 200 }).notNull(),
    sourcePlatform: varchar("source_platform", { length: 50 }).notNull(), // wechat | baidu | zhihu | douyin | xiaohongshu | weibo | baijiahao | toutiao
    heatScore: real("heat_score").notNull().default(0), // 单平台原始热度分
    compositeScore: real("composite_score").default(0), // 跨平台加权综合分
    category: varchar("category", { length: 50 }), // 学科分类: medicine | education | engineering ...
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | cooling | archived
    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    appearCount: integer("appear_count").notNull().default(1), // 累计出现天数
    usedInArticles: jsonb("used_in_articles").default([]), // 关联的文章ID列表
    metadata: jsonb("metadata").default({}), // 原始数据快照等附加信息
    crawlDate: date("crawl_date").notNull(), // 抓取日期（用于滚动窗口）
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kw_tenant").on(table.tenantId),
    index("idx_kw_platform").on(table.sourcePlatform),
    index("idx_kw_category").on(table.category),
    index("idx_kw_crawl_date").on(table.crawlDate),
    index("idx_kw_composite").on(table.compositeScore),
  ]
);

// ============ 期刊库 ============
export const journals = pgTable(
  "journals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    name: varchar("name", { length: 300 }).notNull(), // 期刊名称
    nameEn: varchar("name_en", { length: 300 }), // 英文名
    issn: varchar("issn", { length: 20 }),
    publisher: varchar("publisher", { length: 200 }), // 出版社/主办方
    discipline: varchar("discipline", { length: 100 }), // 学科领域
    partition: varchar("partition", { length: 20 }), // 分区: Q1 | Q2 | Q3 | Q4
    impactFactor: real("impact_factor"), // 影响因子
    annualVolume: integer("annual_volume"), // 年发文量
    acceptanceRate: real("acceptance_rate"), // 录用率
    reviewCycle: varchar("review_cycle", { length: 50 }), // 审稿周期
    isWarningList: boolean("is_warning_list").notNull().default(false), // 是否在中科院预警名单
    warningYear: varchar("warning_year", { length: 10 }), // 预警年份
    letpubViews: integer("letpub_views").default(0), // LetPub查看数
    peerWriteCount: integer("peer_write_count").default(0), // 同行近期写作次数
    status: varchar("status", { length: 20 }).notNull().default("active"),
    source: varchar("source", { length: 50 }), // 数据来源: letpub | manual | crawl
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_journal_tenant").on(table.tenantId),
    index("idx_journal_discipline").on(table.discipline),
    index("idx_journal_partition").on(table.partition),
    index("idx_journal_warning").on(table.isWarningList),
  ]
);

// ============ 竞品内容库（Agent 3）============
export const competitors = pgTable(
  "competitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    accountId: varchar("account_id", { length: 200 }).notNull(), // 竞品账号标识
    accountName: varchar("account_name", { length: 200 }), // 账号名称
    platform: varchar("platform", { length: 50 }).notNull(), // 平台: wechat | douyin | xiaohongshu ...
    articleTitle: varchar("article_title", { length: 500 }),
    articleContent: text("article_content"), // 正文/文案
    articleUrl: varchar("article_url", { length: 1000 }),
    contentType: varchar("content_type", { length: 50 }), // single_journal | multi_compare | hot_analysis | guide
    hookWords: jsonb("hook_words").default([]), // 提取的噱头关键词列表
    journalMentioned: jsonb("journal_mentioned").default([]), // 提及的期刊名列表
    publicMetrics: jsonb("public_metrics").default({}), // { views, likes, comments, shares }
    crawlDate: date("crawl_date").notNull(),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_comp_tenant").on(table.tenantId),
    index("idx_comp_platform").on(table.platform),
    index("idx_comp_crawl_date").on(table.crawlDate),
    index("idx_comp_content_type").on(table.contentType),
  ]
);

// ============ 分发记录库（Agent 6）============
export const distributionRecords = pgTable(
  "distribution_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    contentId: uuid("content_id")
      .references(() => contents.id),
    platform: varchar("platform", { length: 50 }).notNull(), // wechat | video | douyin | xiaohongshu | zhihu | weibo | baijiahao | toutiao
    accountName: varchar("account_name", { length: 200 }),
    publishedTitle: varchar("published_title", { length: 500 }),
    publishedUrl: varchar("published_url", { length: 1000 }),
    adaptedContent: text("adapted_content"), // 平台适配后的内容
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | published | failed
    publishedAt: timestamp("published_at"),
    metrics: jsonb("metrics").default({}), // { views, likes, comments, shares, completionRate, inquiries }
    metricsUpdatedAt: timestamp("metrics_updated_at"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_dist_tenant").on(table.tenantId),
    index("idx_dist_content").on(table.contentId),
    index("idx_dist_platform").on(table.platform),
    index("idx_dist_status").on(table.status),
  ]
);

// ============ 知识库条目（RAG 元数据）============
export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    category: varchar("category", { length: 50 }).notNull(), // journal | sop | customer | competitor
    title: varchar("title", { length: 300 }),
    content: text("content").notNull(),
    source: varchar("source", { length: 500 }), // 来源URL或描述
    vectorId: varchar("vector_id", { length: 100 }), // LanceDB 中的向量ID
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_knowledge_tenant").on(table.tenantId),
    index("idx_knowledge_category").on(table.category),
  ]
);

// ============ 微信公众号配置 ============
export const wechatConfigs = pgTable("wechat_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .references(() => tenants.id)
    .notNull()
    .unique(),
  appId: varchar("app_id", { length: 100 }).notNull(),
  appSecret: varchar("app_secret", { length: 200 }).notNull(),
  accessToken: text("access_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  accountName: varchar("account_name", { length: 100 }), // 公众号名称
  isVerified: boolean("is_verified").default(false),     // 是否已验证可用
  thumbMediaId: text("thumb_media_id"),                  // 默认封面图的media_id（缓存）
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============ 关键词热度历史（每日快照）============
export const keywordHistory = pgTable(
  "keyword_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    keyword: varchar("keyword", { length: 200 }).notNull(),
    snapshotDate: date("snapshot_date").notNull(), // 快照日期
    heatScore: real("heat_score").notNull().default(0), // 当日热度分
    compositeScore: real("composite_score").default(0), // 当日综合分
    platforms: jsonb("platforms").default([]), // 当日出现的平台列表
    platformCount: integer("platform_count").default(1), // 跨平台数
    category: varchar("category", { length: 50 }),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kwh_tenant").on(table.tenantId),
    index("idx_kwh_keyword").on(table.keyword),
    index("idx_kwh_date").on(table.snapshotDate),
    uniqueIndex("idx_kwh_tenant_keyword_date").on(
      table.tenantId,
      table.keyword,
      table.snapshotDate
    ),
  ]
);

// ============ 行业关键词库（动态词库，替代硬编码）============
export const industryKeywords = pgTable(
  "industry_keywords",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    word: varchar("word", { length: 200 }).notNull(), // 关键词
    level: varchar("level", { length: 20 }).notNull(), // primary | secondary | context
    category: varchar("category", { length: 50 }), // 分类标签：期刊类型/发表相关/学术工具...
    weight: real("weight").default(1.0), // 权重（人工标记可调整）
    isSystem: boolean("is_system").default(true), // 是否系统预置（vs 人工添加）
    isActive: boolean("is_active").default(true), // 是否启用
    source: varchar("source", { length: 50 }).default("system"), // system | manual | learned
    hitCount: integer("hit_count").default(0), // 累计命中次数
    lastHitAt: timestamp("last_hit_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ik_tenant").on(table.tenantId),
    index("idx_ik_level").on(table.level),
    index("idx_ik_active").on(table.isActive),
    uniqueIndex("idx_ik_tenant_word_level").on(
      table.tenantId,
      table.word,
      table.level
    ),
  ]
);

// ============ 风格分析结果 ============
export const styleAnalyses = pgTable(
  "style_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    accountName: varchar("account_name", { length: 200 }).notNull(),
    source: varchar("source", { length: 20 }).notNull(), // self | peer
    articleCount: integer("article_count").default(0),
    titlePatterns: jsonb("title_patterns").default({}),
    contentStyle: jsonb("content_style").default({}),
    layoutFeatures: jsonb("layout_features").default({}),
    overallSummary: text("overall_summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_sa_tenant").on(table.tenantId),
    index("idx_sa_source").on(table.source),
  ]
);

// ============ 学习生成的模版库 ============
export const learnedTemplates = pgTable(
  "learned_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    desc: text("description"),
    icon: varchar("icon", { length: 10 }).default("📝"),
    source: varchar("source", { length: 50 }).notNull(), // self_style | peer_style | ai_generated
    sourceAccount: varchar("source_account", { length: 200 }),
    sections: jsonb("sections").default([]),
    titleFormula: text("title_formula"),
    styleTags: jsonb("style_tags").default([]),
    sampleTitle: text("sample_title"),
    prompt: text("prompt"), // 给AI的风格指令
    isActive: boolean("is_active").default(true),
    usageCount: integer("usage_count").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_lt_tenant").on(table.tenantId),
    index("idx_lt_source").on(table.source),
    index("idx_lt_active").on(table.isActive),
  ]
);

// ============ 租户 IP 定位（V4 子库10）============
export const tenantIpProfiles = pgTable(
  "tenant_ip_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    brandName: varchar("brand_name", { length: 200 }).notNull(),
    industry: varchar("industry", { length: 100 }).notNull(),
    subIndustry: varchar("sub_industry", { length: 100 }),
    targetAudience: text("target_audience"),              // 目标受众描述
    toneOfVoice: varchar("tone_of_voice", { length: 100 }), // 调性：专业严谨 | 轻松幽默 ...
    contentGoals: jsonb("content_goals").default([]),     // 内容目标列表
    tabooTopics: jsonb("taboo_topics").default([]),       // 禁忌话题列表
    referenceAccounts: jsonb("reference_accounts").default([]), // 参考对标账号
    visualStyle: jsonb("visual_style").default({}),       // 视觉风格偏好
    status: varchar("status", { length: 20 }).notNull().default("active"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ip_tenant").on(table.tenantId),
    index("idx_ip_industry").on(table.industry),
  ]
);

// ============ 生产记录+衍生追踪（V4 子库11）============
export const productionRecords = pgTable(
  "production_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    contentId: uuid("content_id").references(() => contents.id), // 关联原始内容
    parentId: uuid("parent_id"),                          // 衍生来源（自引用，原始稿为 null）
    format: varchar("format", { length: 50 }).notNull(),  // 形式：long_article | short_video | poster | thread | ...
    platform: varchar("platform", { length: 50 }),        // 目标平台
    title: varchar("title", { length: 500 }),
    body: text("body"),
    wordCount: integer("word_count").default(0),
    status: varchar("status", { length: 20 }).notNull().default("draft"), // draft | in_review | approved | published
    producedBy: varchar("produced_by", { length: 50 }).default("ai"), // ai | human | hybrid
    tokensUsed: integer("tokens_used").default(0),
    metadata: jsonb("metadata").default({}),              // 衍生参数、模型配置等
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_prod_tenant").on(table.tenantId),
    index("idx_prod_content").on(table.contentId),
    index("idx_prod_parent").on(table.parentId),
    index("idx_prod_format").on(table.format),
    index("idx_prod_status").on(table.status),
  ]
);

// ============ 内容数据表现（V4 子库12）============
export const contentMetrics = pgTable(
  "content_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    contentId: uuid("content_id").references(() => contents.id),
    distributionId: uuid("distribution_id").references(() => distributionRecords.id),
    platform: varchar("platform", { length: 50 }).notNull(),
    snapshotDate: date("snapshot_date").notNull(),         // 数据快照日期
    views: integer("views").default(0),
    likes: integer("likes").default(0),
    comments: integer("comments").default(0),
    shares: integer("shares").default(0),
    saves: integer("saves").default(0),
    followers: integer("followers").default(0),            // 该内容带来的新关注
    inquiries: integer("inquiries").default(0),            // 咨询/私信转化
    completionRate: real("completion_rate"),                // 完播率（视频）
    ctr: real("ctr"),                                      // 点击率
    metadata: jsonb("metadata").default({}),               // 平台特有指标
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_cm_tenant").on(table.tenantId),
    index("idx_cm_content").on(table.contentId),
    index("idx_cm_distribution").on(table.distributionId),
    index("idx_cm_platform").on(table.platform),
    index("idx_cm_date").on(table.snapshotDate),
  ]
);

// ============ 栏目规划日历（V4 子库16）============
export const columnCalendars = pgTable(
  "column_calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    columnName: varchar("column_name", { length: 200 }).notNull(),  // 栏目名称
    frequency: varchar("frequency", { length: 50 }).notNull(),      // daily | weekly | biweekly | monthly
    platforms: jsonb("platforms").default([]),             // 目标平台列表
    contentFormats: jsonb("content_formats").default([]), // 内容形式列表
    topicPool: jsonb("topic_pool").default([]),           // 选题池
    scheduledDate: date("scheduled_date"),                 // 计划发布日期
    assignee: varchar("assignee", { length: 100 }),        // 负责人
    status: varchar("status", { length: 20 }).notNull().default("planned"), // planned | in_progress | ready | published | cancelled
    contentId: uuid("content_id").references(() => contents.id), // 关联已生产内容
    notes: text("notes"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_cal_tenant").on(table.tenantId),
    index("idx_cal_column").on(table.columnName),
    index("idx_cal_date").on(table.scheduledDate),
    index("idx_cal_status").on(table.status),
  ]
);

// ============ 平台账号管理（多账号+多平台）============
export const platformAccounts = pgTable(
  "platform_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    platform: varchar("platform", { length: 50 }).notNull(), // wechat | baijiahao | toutiao | zhihu | xiaohongshu
    accountName: varchar("account_name", { length: 200 }).notNull(), // 账号名称/昵称
    accountId: varchar("account_id", { length: 200 }), // 平台方的账号ID
    credentials: jsonb("credentials").default({}).notNull(), // 平台凭证 (加密存储)
    // wechat: { appId, appSecret }
    // baijiahao: { appId, appSecret, accessToken }
    // toutiao: { appId, appSecret }
    // zhihu: { cookie, token }
    // xiaohongshu: { cookie, token }
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | disabled | expired
    isVerified: boolean("is_verified").default(false),
    groupName: varchar("group_name", { length: 100 }), // 分组标签（如"医学组"、"教育组"）
    metadata: jsonb("metadata").default({}), // 扩展信息
    lastPublishedAt: timestamp("last_published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_pa_tenant").on(table.tenantId),
    index("idx_pa_platform").on(table.platform),
    index("idx_pa_group").on(table.groupName),
  ]
);
