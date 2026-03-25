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
