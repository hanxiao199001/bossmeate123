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
