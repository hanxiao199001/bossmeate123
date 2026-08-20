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
  numeric,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// ============ 租户表 ============
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 50 }).unique().notNull(), // 租户标识，如 "journal-pub-01"
  plan: varchar("plan", { length: 20 }).notNull().default("trial"), // trial | basic | pro
  status: varchar("status", { length: 20 }).notNull().default("active"), // active | suspended
  config: jsonb("config").default({}), // 租户级别配置（模型偏好、Token限额等）
  // 6-20 企业实名(KYC): 帮客户注册时录营业执照。creditCode 唯一(防同企业重复建租户; PG 唯一约束允许多个 NULL)。
  creditCode: varchar("credit_code", { length: 30 }).unique(), // 统一社会信用代码
  legalPerson: varchar("legal_person", { length: 50 }), // 法人代表
  businessLicenseUrl: text("business_license_url"), // 营业执照图 URL
  verifiedStatus: varchar("verified_status", { length: 20 }).default("unverified"), // unverified | verified
  verifiedAt: timestamp("verified_at"),
  verifiedBy: varchar("verified_by", { length: 100 }), // 认证操作的平台管理员标识
  /**
   * 联系信息（shunshi-style 区块 21 等模板渲染源；admin UI 5-13 后维护）。
   * Shape: { contactName, wechatId?, workingHours?, qrCodeUrl?, email?, phone?, lastUpdatedAt? }
   * null → 模板走 hardcoded fallback 文案。
   */
  contactMeta: jsonb("contact_meta"),
  /** B.6: 罐头消息双轨注入的自服务平台 URL（hard guard 命中时引导客户进站） */
  bossmatePlatformUrl: varchar("bossmate_platform_url", { length: 200 }).default("https://boss-mates.com/try"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============ 用户表 ============
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    email: varchar("email", { length: 255 }), // 6-20: 改可空(手机号优先注册无 email)
    phone: varchar("phone", { length: 20 }),
    passwordHash: text("password_hash"), // 6-20: 改可空(手机号验证码登录用户无密码)
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
    index("idx_users_phone").on(table.phone), // 6-20: 手机号登录查找
  ]
);

// ========== 6-20 Phase2 多租户: 手机验证码 + 员工邀请 ==========

/** 手机验证码(登录/注册/邀请)。只存 hash; attemptCount 防爆破; 限频靠 createdAt 窗口查询。 */
export const smsCodes = pgTable(
  "sms_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: varchar("phone", { length: 20 }).notNull(),
    codeHash: text("code_hash").notNull(),
    purpose: varchar("purpose", { length: 30 }).notNull(), // login | register | invite
    attemptCount: integer("attempt_count").notNull().default(0), // 错误校验次数, 超限锁定
    consumedAt: timestamp("consumed_at"), // 一码一用: 用过即置
    ip: varchar("ip", { length: 50 }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_sms_phone_created").on(table.phone, table.createdAt),
  ]
);

/** 员工邀请: 老板/管理员按手机号邀请, 员工验证码登录时匹配 pending 邀请自动加入并绑角色。 */
export const tenantInvites = pgTable(
  "tenant_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    phone: varchar("phone", { length: 20 }).notNull(),
    role: varchar("role", { length: 40 }).notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | accepted | expired | revoked
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_invites_tenant").on(table.tenantId),
    index("idx_invites_phone_status").on(table.phone, table.status),
  ]
);

// ============ 对话/会话表 ============
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
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
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    conversationId: uuid("conversation_id")
      .references(() => conversations.id, { onDelete: "cascade" })
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
    /**
     * 8-17：产出本行的 batch_row。**部分唯一索引的键** —— 一个 batch_row 最多一条 content。
     * 历史行为 NULL（不受约束）；新行由 batch-worker 写入。
     * metadata.batchRowId 仍保留（历史查询用），但**被 DB 约束的是这一列**。
     */
    batchRowId: uuid("batch_row_id"),
    /**
     * 发布提交时刻。
     *
     * 🔴 **这个字段的确切含义，一个字都不要省：**
     *
     * > 「运营点了批量分发，账号是 full 能力，提交发布的调用返回成功」
     *
     * 它**不是**下面任何一个：
     * ```
     * ✗ 读者收到了        —— freepublish/submit 是**异步**接口
     * ✗ 微信审核通过了    —— 提交成功 ≠ 审核通过
     * ✗ 内容已公开可见    —— 审核通过之后才推送
     * ✗ 进了草稿箱        —— 那是 draft_only 能力的账号，本字段**不填**它们
     * ```
     *
     * 三个月后如果有人想拿它当"已触达读者"用：**它不是**。
     * 要那个数得等 `published_by_operator` 那条链路真正接上
     * （目前是死代码：它依赖的 `wechat_stats` 表根本没建过）。
     *
     * 之所以把这段写这么死 —— 今天修的正是这类病：
     * dashboard 有个字段**叫 `publishedAt`、取的却是 `updatedAt`**，
     * 名字很像那么回事，前端照着信了三个月。
     *
     *
     * 🔴 与 `updatedAt` 严格区分：`updatedAt` 是「最后被任何人/任何脚本改过」，
     * 会被批量运维操作刷新（8-13 摘 body、8-18 救 35 条都刷过它）。
     * 拿它当发布时间用，等于让运维动作改写业务指标。
     *
     * NULL = 没发布过（诚实）。**不要用任何推断值填充它。**
     */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    type: varchar("type", { length: 20 }).notNull(), // article | video_script | reply
    title: varchar("title", { length: 300 }),
    body: text("body"), // 正文内容（Markdown）
    // P0 lifecycle (7 状态): draft | generating | failed | generated | needs_review | published | archived
    //   needs_review = PR-U2 质检未过, 待人工复核(不可直接发)。
    // 旧 reviewing/approved 已 migration 回填为 generated（详见 migrate.ts 末尾 P0 段）
    // ⚠️ 值域的唯一真相源是 services/articles/state-machine.ts 的 ARTICLE_STATUSES;
    //    本注释若与之不符, 以那边为准(注释漏列 needs_review 曾让前端词表跟着漏, 详情页直接显示英文原码)。
    //    DB CHECK 约束是阶段3 的事, 现在没有约束 —— 别以为写在这里就管得住。
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    errorMessage: text("error_message"), // P0：generating → failed 时记录失败原因
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }), // P0：状态机变更时间戳
    platforms: jsonb("platforms").default([]), // 发布到的平台 [{platform, publishedAt, url}]
    tokensTotal: integer("tokens_total").default(0), // 生成消耗的Token总量
    metadata: jsonb("metadata").default({}),
    pinned: boolean("pinned").default(false), // PR #178: 防自动清理
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_content_tenant").on(table.tenantId),
    index("idx_content_user").on(table.userId),
    index("idx_content_type").on(table.type),
    // P0：主列表查询（按租户 + 状态 + 最近变更倒序）
    index("idx_content_tenant_status_updated").on(
      table.tenantId,
      table.status,
      table.statusUpdatedAt,
    ),
  ]
);

// ============ Token 用量日志 ============
export const tokenLogs = pgTable(
  "token_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
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
      .references(() => tenants.id, { onDelete: "cascade" })
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
    lastRecommendedAt: timestamp("last_recommended_at"), // PR #172: 上次被 daily-cron 推荐的时间 (NULL = 从未推荐)
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
    // PR B.12：tenant_id NULL = 全局共享 reference data（46 enriched 期刊，所有 tenant 共享）；
    // 非 NULL = 该 tenant 的自定义期刊。collector 用 OR(isNull, eq) 同时拉两类。
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    name: varchar("name", { length: 300 }).notNull(), // 期刊名称
    nameEn: varchar("name_en", { length: 300 }), // 英文名
    issn: varchar("issn", { length: 20 }),
    publisher: varchar("publisher", { length: 200 }), // 出版社/主办方
    discipline: varchar("discipline", { length: 100 }), // 学科领域(原始值: 国内刊为中文分类名, 国际刊为英文码)
    // 7-20 学科码归一(migration 026): discipline 归一成 ALL_DISC_CODES 之一或 'generic'。
    //   **Postgres 生成列, 只读** — 不要 insert/update 这一列, DB 会随 discipline 自动重算。
    //   规则源: services/recommendation/discipline-mapping.ts
    disciplineCode: varchar("discipline_code", { length: 20 }),
    // 7-28 体系归一(migration 029): 'intl' 纯国外 | 'both' 骑墙(国际指标+国内目录) | 'cn' 国内 | 'unknown' 无信号。
    //   **Postgres 生成列, 只读** — 不要 insert/update, DB 随 IF/分区/目录字段自动重算。
    //   规则源: services/journals/journal-kind.ts (四套"国内刊"启发式定义的收口)
    journalKind: varchar("journal_kind", { length: 12 }).$type<"intl" | "both" | "cn" | "unknown">(),
    partition: varchar("partition", { length: 20 }), // 分区: Q1 | Q2 | Q3 | Q4
    impactFactor: real("impact_factor"), // 影响因子
    annualVolume: integer("annual_volume"), // 年发文量
    acceptanceRate: real("acceptance_rate"), // 录用率 (0-1 ratio, LetPub 精确值; ablesci 不给精确数, 见 acceptanceDifficulty)
    acceptanceDifficulty: varchar("acceptance_difficulty", { length: 20 }), // PR #235: 投稿难度模糊词 (容易/较易/中等/较难/困难), 来自 ablesci
    reviewCycle: varchar("review_cycle", { length: 50 }), // 审稿周期
    isWarningList: boolean("is_warning_list").notNull().default(false), // 是否在中科院预警名单
    warningYear: varchar("warning_year", { length: 10 }), // 预警年份
    letpubViews: integer("letpub_views").default(0), // LetPub查看数
    peerWriteCount: integer("peer_write_count").default(0), // 同行近期写作次数
    status: varchar("status", { length: 20 }).notNull().default("active"),
    source: varchar("source", { length: 50 }), // 数据来源: letpub | manual | crawl
    abbreviation: varchar("abbreviation", { length: 50 }), // 简称如 EHO
    foundingYear: integer("founding_year"), // 创刊年份
    country: varchar("country", { length: 50 }), // 出版国家
    website: text("website"), // 期刊官网
    apcFee: real("apc_fee"), // 版面费（美元）
    selfCitationRate: real("self_citation_rate"), // 自引率 %
    casPartition: varchar("cas_partition", { length: 50 }), // 中科院分区 如 "医学2区"
    casPartitionNew: varchar("cas_partition_new", { length: 50 }), // 新锐分区 如 "医学1区TOP"
    jcrSubjects: text("jcr_subjects"), // JCR学科分区详情 JSON 如 [{"subject":"Oncology","rank":"Q1","position":"9/100"}]
    topInstitutions: text("top_institutions"), // 国内投稿活跃机构 JSON
    scopeDescription: text("scope_description"), // 收稿范围描述（AI生成后缓存）
    coverImageUrl: text("cover_image_url"), // 期刊封面图 URL（LetPub 缩略图缓存）
    coverUrlHd: text("cover_url_hd"), // 高清封面 URL（Springer CDN 316×419 等）
    coverImageSource: varchar("cover_image_source", { length: 50 }), // 封面来源
    coverFetchedAt: timestamp("cover_fetched_at"), // 封面抓取时间
    springerFetchedAt: timestamp("springer_fetched_at"), // Springer 数据抓取时间

    // === 国内核心期刊字段 ===
    catalogType: varchar("catalog_type", { length: 30 }), // "sci" | "pku-core" | "cssci" | "sci-core" | "cscd"
    catalogYear: varchar("catalog_year", { length: 20 }), // 目录版本: "2023" | "2025-2026"
    cnNumber: varchar("cn_number", { length: 30 }), // 国内统一刊号 CN
    coreLevel: varchar("core_level", { length: 20 }), // "核心" | "扩展" | "来源"
    catalogs: jsonb("catalogs").default([]), // 所属多个目录 ["cssci","pku-core"]
    frequency: varchar("frequency", { length: 20 }), // 刊期: 月刊/双月刊/季刊
    // 6-20: 知网复合影响因子(国内刊影响力指标)。独立列, 绝不并入 impact_factor —— 否则 hasWosData 会把国内刊误判成国外刊。
    compositeImpactFactor: real("composite_impact_factor"),

    // B.4-1: 中文核心目录标签（CSCD 中国科学引文数据库 + 北大核心总览，目录类静态字段）
    // cscdLevel: "核心库" | "扩展库" | null
    // pkuCoreLevel: "北大核心" | null（北大核心总览 2023 第 10 版）
    cscdLevel: varchar("cscd_level", { length: 30 }),
    pkuCoreLevel: varchar("pku_core_level", { length: 30 }),

    // === Springer Link 批量爬取字段 ===
    springerJournalId: varchar("springer_journal_id", { length: 20 }), // Springer Link 期刊 ID
    citeScore: real("cite_score"), // CiteScore
    timeToFirstDecisionDays: integer("time_to_first_decision_days"), // 首次审稿决定天数
    isHybrid: boolean("is_hybrid").default(false), // 是否混合 OA
    isOA: boolean("is_oa").default(false), // 是否完全 OA

    // === B 阶段扩展字段（顺仕美途风格模板需要）===
    // 全部 nullable jsonb，旧 46 条数据不动；B.2 数据采集器 + B.3 回填脚本会逐步填上。

    // 近 10 年 IF 历史 + 预测值
    // { data: [{year: 2024, if: 4.7}, ...], predicted: {year: 2025, if: 5.5, source: "letpub|model"}, lastUpdatedAt }
    ifHistory: jsonb("if_history"),

    // CAR 指数 3 年历史 + 风险等级
    // { data: [{year: 2024, carIndex: 0.85}, ...], riskLevel: "low"|"mid"|"high", lastUpdatedAt }
    carIndexHistory: jsonb("car_index_history"),

    // 发文统计：刊期 + 年发文量历史 + 国内活跃机构
    // { frequency, annualVolumeHistory: [{year, count}, ...], topInstitutions: [{name, paperCount, percentile}, ...], lastUpdatedAt }
    publicationStats: jsonb("publication_stats"),

    // 完整 JCR 分区：WOS 等级 + JIF/JCI 多维度 + isTopJournal/isReviewJournal
    // { wosLevel, jifSubjects: [{subject, zone, rank, percentile}, ...], jciSubjects: [...], isTopJournal, isReviewJournal, lastUpdatedAt }
    jcrFull: jsonb("jcr_full"),

    // 引用前 10 种期刊（饼图数据）
    // { topJournals: [{name, percent, count}, ...], totalCitations, lastUpdatedAt }
    citingJournalsTop10: jsonb("citing_journals_top10"),

    // 推荐指数 1-5 星（INTEGER，1=不推荐 / 5=强推荐）
    recommendationScore: integer("recommendation_score"),

    // 收稿范围详细分类 + 学科分布
    // { categories: [{title, description}], articleTypes: [...], submissionNote, subjectDistribution: [{subject, percent}], lastUpdatedAt }
    scopeDetails: jsonb("scope_details"),

    // 版面费详细（OA + 订阅模式 + APC + VAT）
    // { apc, currency, openAccess, fastTrack, extras: [...], lastUpdatedAt }
    publicationCosts: jsonb("publication_costs"),

    // === 期刊数据可信度治理 PR 1（5-8 P0++）===
    // dataSource：数据来源 ('manual_seed_2024' | 'letpub_only' | 'token_fuzzy' | 'ai_fabricated' | 'multi_source_verified' | 'legacy_unknown')
    dataSource: text("data_source"),
    // sourceUrl：原始数据 URL（如 letpub detail 页 / crossref API URL）
    sourceUrl: text("source_url"),
    // lastVerifiedAt：最近一次 enricher / 人工审核时间戳
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    // confidence：可信度分（0-100；NULL=未评分；ai_fabricated=30；多源 verified 最高 95）
    confidence: integer("confidence").default(50),
    // fieldProvenance：每个字段的来源映射 JSONB（如 {if: 'jcr_letpub_2024', issn: 'crossref'}）
    fieldProvenance: jsonb("field_provenance"),

    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_journal_tenant").on(table.tenantId),
    index("idx_journal_discipline").on(table.discipline),
    index("idx_journal_partition").on(table.partition),
    index("idx_journal_warning").on(table.isWarningList),
    index("idx_journal_catalog_type").on(table.catalogType),
    index("idx_journal_springer_id").on(table.springerJournalId),
    // PR 1：审计页主排序索引 + data_source 过滤
    index("idx_journals_confidence").on(table.confidence),
    index("idx_journals_data_source").on(table.dataSource),
  ]
);

// ============ 竞品内容库（Agent 3）============
export const competitors = pgTable(
  "competitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    accountId: varchar("account_id", { length: 200 }).notNull(), // 竞品账号标识
    accountName: varchar("account_name", { length: 200 }), // 账号名称
    platform: varchar("platform", { length: 50 }).notNull(), // 竞品来源平台(自由文本, 非 PLATFORM_CAPABILITIES 值域)
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
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    contentId: uuid("content_id")
      .references(() => contents.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 50 }).notNull(), // 值域见 services/platforms/capabilities.ts (旧注释里的 video/weibo 是历史遗留, 系统里不存在)
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
      .references(() => tenants.id, { onDelete: "cascade" })
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
    .references(() => tenants.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  appId: varchar("app_id", { length: 100 }).notNull(),
  appSecret: varchar("app_secret", { length: 200 }).notNull(),
  accessToken: text("access_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  accountName: varchar("account_name", { length: 100 }), // 公众号名称
  isVerified: boolean("is_verified").default(false),     // 是否已验证可用
  thumbMediaId: text("thumb_media_id"),                  // 默认封面图的media_id（缓存）
  // B.1: 服务号 vs 订阅号（影响 reply 通道选择，B.3 hard guard 罐头消息走客服接口需服务号）
  accountType: varchar("account_type", { length: 20 }).default("service"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// B.1: 公众号 webhook 幂等表 — (tenant_id, msg_id) 复合主键，TTL 7 day（cron 清理 — B.5 内）
export const dedupMsgs = pgTable("dedup_msgs", {
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  msgId: varchar("msg_id", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.msgId] }),
  index("idx_dedup_msgs_created_at").on(table.createdAt),
]);

// B.2: 企业微信配置表 — encodingAESKey 用现有 credentialsKey 加密机制存（参考 wechatConfigs.appSecret）
export const workWechatConfigs = pgTable("work_wechat_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull().unique(),
  corpId: varchar("corp_id", { length: 100 }).notNull(),
  agentId: varchar("agent_id", { length: 50 }).notNull(),
  token: varchar("token", { length: 100 }).notNull(),
  encodingAesKeyEnc: text("encoding_aes_key_enc").notNull(), // 密文存储（credentialsKey AES）
  kfSecretEnc: text("kf_secret_enc"), // B-kf: 微信客服 Secret（gettoken 用），同 encodingAesKey 走 credentialsKey 加密
  agentSecretEnc: text("agent_secret_enc"), // B-kf: 自建应用 Secret（handoff 通知运营用 message/send），credentialsKey 加密
  notifyUserids: text("notify_userids"), // B-kf: handoff 通知接收人（企微 userid 逗号分隔；空 = "@all"）
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============ B-kf: 企微「微信客服」AI 客服 ============

// kf/sync_msg 游标 — 每 (tenant, open_kfid) 一条；断点续拉，避免全量重放
export const kfSyncCursors = pgTable("kf_sync_cursors", {
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  openKfid: varchar("open_kfid", { length: 64 }).notNull(),
  cursor: text("cursor").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.openKfid] }),
]);

// kf 会话 — (tenant, open_kfid, external_userid) 唯一；mode=manual 时 AI 静默只落库
export const kfConversations = pgTable("kf_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  openKfid: varchar("open_kfid", { length: 64 }).notNull(),
  externalUserid: varchar("external_userid", { length: 64 }).notNull(),
  mode: varchar("mode", { length: 10 }).notNull().default("auto"), // auto | manual
  lastMsgAt: timestamp("last_msg_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_kf_conv_uniq").on(table.tenantId, table.openKfid, table.externalUserid),
]);

// kf 消息 — wx_msgid 唯一兜底防重（sync_msg 可能与游标重叠重放）
export const kfMessages = pgTable("kf_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => kfConversations.id, { onDelete: "cascade" }).notNull(),
  direction: varchar("direction", { length: 5 }).notNull(), // in | out
  msgType: varchar("msg_type", { length: 20 }).notNull().default("text"),
  content: text("content").notNull().default(""),
  aiIntent: varchar("ai_intent", { length: 30 }), // journal_query | service_faq | chitchat | handoff
  aiAction: varchar("ai_action", { length: 20 }), // answered | transferred | skipped | manual
  wxMsgid: varchar("wx_msgid", { length: 100 }).unique(), // 微信侧 msgid；出站消息为空
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_kf_msg_conv").on(table.conversationId, table.createdAt),
]);

// kf FAQ — 租户维护的服务问答，responder 全量(≤30)塞 prompt
export const kfFaqs = pgTable("kf_faqs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// B.3: hard guard 白名单 — 命中 pattern 则跳过 4 类硬规则（让正常 LLM 路径走）
export const hardGuardWhitelist = pgTable("hard_guard_whitelist", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  pattern: text("pattern").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// B.5: tenant 级 feature flag — 新租户默认 false（白名单制，合规护城河）
export const tenantFeatureFlags = pgTable("tenant_feature_flags", {
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  flagName: varchar("flag_name", { length: 60 }).notNull(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.flagName] }),
]);

// ============ 关键词热度历史（每日快照）============
export const keywordHistory = pgTable(
  "keyword_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
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
      .references(() => tenants.id, { onDelete: "cascade" })
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
      .references(() => tenants.id, { onDelete: "cascade" })
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
      .references(() => tenants.id, { onDelete: "cascade" })
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
      .references(() => tenants.id, { onDelete: "cascade" })
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
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "cascade" }), // 关联原始内容
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
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "cascade" }),
    distributionId: uuid("distribution_id").references(() => distributionRecords.id, { onDelete: "set null" }),
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
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    columnName: varchar("column_name", { length: 200 }).notNull(),  // 栏目名称
    frequency: varchar("frequency", { length: 50 }).notNull(),      // daily | weekly | biweekly | monthly
    platforms: jsonb("platforms").default([]),             // 目标平台列表
    contentFormats: jsonb("content_formats").default([]), // 内容形式列表
    topicPool: jsonb("topic_pool").default([]),           // 选题池
    scheduledDate: date("scheduled_date"),                 // 计划发布日期
    assignee: varchar("assignee", { length: 100 }),        // 负责人
    status: varchar("status", { length: 20 }).notNull().default("planned"), // planned | in_progress | ready | published | cancelled
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "set null" }), // 关联已生产内容
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

// ============ V4.5: 异步任务表 ============
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    type: varchar("type", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    progress: integer("progress").default(0),
    input: jsonb("input").default({}).notNull(),
    output: jsonb("output").default({}),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_tasks_tenant").on(table.tenantId),
    index("idx_tasks_status").on(table.status),
    index("idx_tasks_user").on(table.userId, table.status),
  ]
);

// ============ V4.5: 任务执行日志表 ============
export const taskLogs = pgTable(
  "task_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    step: varchar("step", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    inputTokens: integer("input_tokens").default(0),
    outputTokens: integer("output_tokens").default(0),
    model: varchar("model", { length: 50 }),
    durationMs: integer("duration_ms"),
    detail: jsonb("detail").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_task_logs_task").on(table.taskId),
  ]
);

// ============ 平台账号管理（多账号+多平台）============
export const platformAccounts = pgTable(
  "platform_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    // 值域唯一真相源 = services/platforms/capabilities.ts 的 PLATFORM_CAPABILITIES:
    //   wechat | baijiahao | toutiao | zhihu | xiaohongshu | douyin | wechat_video
    // (旧注释漏了 douyin/wechat_video —— 无 DB 约束, 注释漂了也没人拦。CHECK 见阶段3)
    platform: varchar("platform", { length: 50 }).notNull(),
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
    // 发布能力: full = 全流程自动群发；draft_only = 仅建草稿，需人工到公众号后台手动发送
    // 未认证订阅号 freepublish 接口无权限（errcode 48001），默认走 draft_only 保守
    capability: varchar("capability", { length: 20 }).notNull().default("draft_only"),
    // 7-27 无人值守: **发布模式** — 这个号的内容最终是"系统自动发"还是"人工下载后自己传"。
    //   auto   = 客户端发布助手(Agent)自动发 → 客户端心跳断掉才是真故障, agent_offline 有意义
    //   manual = 运营下载视频/文案后, 在自己手机或浏览器上传 → 客户端**根本不需要开**,
    //            再按心跳判健康就是每天固定几条噪音告警(7-27 简报报了 11 条"助手离线", 全是假的,
    //            还把"公众号今天全挂"这个真问题淹了)。
    //   与 capability 的区别: capability 说的是"公众号 API 有没有群发权限"(平台授权层),
    //   publishMode 说的是"这条内容由谁按下发布键"(运营流程层) —— 两者正交, 不可复用。
    publishMode: varchar("publish_mode", { length: 10 }).notNull().default("auto"),
    groupName: varchar("group_name", { length: 100 }), // 分组标签（如"医学组"、"教育组"）
    remark: varchar("remark", { length: 100 }), // 6-19 用户手动备注名(扫码后自己标, 不被自动昵称覆盖)
    // PR-A16: 账号↔设备绑定 — 该账号浏览器登录态在哪台客户机 (NULL=未绑定, 任意设备可领;
    // 设备首次成功完成该账号任务时自动绑定; 设备 ON DELETE SET NULL 自动解绑)
    agentDeviceId: uuid("agent_device_id").references(() => agentDevices.id, { onDelete: "set null" }),
    // PR-K: 账号期刊定位 — domestic=只做国内核心 / international=只做国外期刊 / both=两者都做(默认)
    journalScope: varchar("journal_scope", { length: 20 }).notNull().default("both"),
    // PR-W5: 账号领域定位 — 该账号只生成此学科内容 (medicine/psychology/...; NULL=不限, 按日轮换)
    discipline: varchar("discipline", { length: 20 }),
    // PR-W5b: 领域定位多选 — 数组, 空=不限按日轮换 (取代单选 discipline)
    disciplines: jsonb("disciplines").default([]).notNull(),
    // PR-X1: 人设画像 — 自由文本(语气/自称/受众/口头禅/禁忌), 生成时注入 prompt
    persona: text("persona"),
    dvhTemplate: varchar("dvh_template", { length: 40 }), // 6-19 该账号数字人形象(目录key), 不同号不同形象防查重
    clonedVoiceId: varchar("cloned_voice_id", { length: 120 }), // 6-26 该账号克隆音色 voice_id(百炼); 空=用全局/预置音色
    // PR-X3: 风格画像 — 喂范文后 LLM 提炼的风格描述, 生成时注入 prompt
    styleProfile: text("style_profile"),
    // 6-22 剪辑风格预设: academic/popsci/marketing/data。空=系统按领域/范围/人设自动匹配。
    clipStyle: varchar("clip_style", { length: 20 }),
    // PR Q.2: 该账号绑定的模板（NULL = 用全局默认 shunshi-default）
    templateId: uuid("template_id").references((): any => contentTemplates.id),
    metadata: jsonb("metadata").default({}), // 扩展信息
    // PR-S1: 浏览器登录态 (半自动平台扫码登录 → 推草稿箱)。login_state = 加密的 cookies+localStorage JSON
    loginState: text("login_state"),
    loginStatus: varchar("login_status", { length: 20 }).notNull().default("none"), // none | logged_in | expired
    loginAt: timestamp("login_at", { withTimezone: true }),
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

// ============ 音色库（7-10 迁移024: 音色成库 — 多条克隆音+预置音色, 账号从库里挑）============
// tenant_id NULL = 全局共享预置音色(照抄 journals 的 NULL=共享模式); 非 NULL = 该租户自己的克隆音。
// voice_id 即 platform_accounts.cloned_voice_id 存的同一种字符串(克隆 voice_id 或 qwen-tts 预置音色名), 语义不变。
export const voiceCatalog = pgTable(
  "voice_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 60 }).notNull(), // 如 "韩肖本人" / "芊悦·阳光女声"
    voiceId: varchar("voice_id", { length: 120 }).notNull(), // 克隆 voice_id(含 -vc-) 或预置音色名(Cherry 等)
    type: varchar("type", { length: 10 }).notNull().default("cloned"), // cloned | preset
    sampleUrl: text("sample_url"), // 试听样音(克隆时的试听 mp3), 可空
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_voice_catalog_tenant").on(table.tenantId, table.type)]
);

// ============ PR Q.2: content_templates 4 系统模板（user 5-5 拍板：A+B+C+E）============
// 4 套：shunshi-style 学术权威 / marketing-conversion 营销转化 / popular-science 科普轻松 /
// industry-vertical 行业垂直。D 学术深度推 5-14 后。
// jsonb 字段在 D2/D3/D4/D5 接到对应消费层后真生效；本 PR 仅 schema + admin UI list。
export const contentTemplates = pgTable("content_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  styleTag: varchar("style_tag", { length: 50 }).notNull(),
  sectionCount: integer("section_count").notNull(),
  structureJson: jsonb("structure_json").notNull(),
  promptOverrides: jsonb("prompt_overrides").notNull(),
  chartConfig: jsonb("chart_config").notNull(),
  cssTheme: jsonb("css_theme").notNull(),
  imageStrategy: jsonb("image_strategy").notNull(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============ 每日选题推荐 ============
export const dailyRecommendations = pgTable(
  "daily_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    date: date("date").notNull(),
    recommendations: jsonb("recommendations").default([]).notNull(),
    generatedAt: timestamp("generated_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_daily_rec_tenant_date").on(table.tenantId, table.date),
  ]
);

// ============ Agent 系统表 ============

// 1. 每日内容计划
export const dailyContentPlans = pgTable(
  "daily_content_plans",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    date: varchar("date", { length: 10 }).notNull(),
    tasks: jsonb("tasks").notNull().default([]),
    totalArticles: integer("total_articles").default(0),
    totalVideos: integer("total_videos").default(0),
    status: varchar("status", { length: 20 }).default("draft"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_dcp_tenant_date").on(table.tenantId, table.date),
  ]
);

// 2. Agent 执行日志
export const agentLogs = pgTable(
  "agent_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    agentName: varchar("agent_name", { length: 50 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    tokensUsed: integer("tokens_used").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_agent_logs_tenant_date").on(table.tenantId, table.createdAt),
  ]
);

// 3. 老板审核/修改记录
export const bossEdits = pgTable(
  "boss_edits",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "cascade" }).notNull(),
    action: varchar("action", { length: 20 }).notNull(),
    originalTitle: text("original_title"),
    editedTitle: text("edited_title"),
    originalBody: text("original_body"),
    editedBody: text("edited_body"),
    rejectReason: text("reject_reason"),
    editDistance: integer("edit_distance"),
    patternsExtracted: jsonb("patterns_extracted"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_boss_edits_tenant").on(table.tenantId, table.createdAt),
  ]
);

// 4. 每日运营报告
export const dailyReports = pgTable(
  "daily_reports",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    date: varchar("date", { length: 10 }).notNull(),
    report: jsonb("report").notNull(),
    aiSummary: text("ai_summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_daily_reports_tenant_date").on(table.tenantId, table.date),
  ]
);

// 5. 同行内容抓取记录
export const peerContentCrawls = pgTable(
  "peer_content_crawls",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    competitorId: varchar("competitor_id", { length: 100 }).notNull(),
    platform: varchar("platform", { length: 30 }).notNull(),
    originalUrl: text("original_url").notNull(),
    title: text("title").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    readCount: integer("read_count"),
    likeCount: integer("like_count"),
    knowledgeExtracted: boolean("knowledge_extracted").default(false),
    entriesCreated: integer("entries_created").default(0),
    crawledAt: timestamp("crawled_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_pcc_tenant_hash").on(table.tenantId, table.contentHash),
  ]
);

// ============ AI 销售模块 (V3) ============

/** 潜在客户 / 意向线索 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    /** 来源渠道: comment_wechat | comment_zhihu | dm | wechat_work | manual ... */
    channel: varchar("channel", { length: 50 }).notNull(),
    /** 渠道方原始ID（用于去重） */
    externalId: varchar("external_id", { length: 200 }),
    /** 展示名 */
    name: varchar("name", { length: 200 }),
    /** 企业微信 userId / openId */
    contactId: varchar("contact_id", { length: 200 }),
    phone: varchar("phone", { length: 50 }),
    email: varchar("email", { length: 200 }),
    /** 触达内容 */
    sourceContentId: uuid("source_content_id").references(() => contents.id, { onDelete: "set null" }),
    /** 客户画像 JSON (学科/学历/意向期刊等) */
    profile: jsonb("profile").default({}),
    /** 销售阶段: new | contacted | qualified | negotiating | won | lost | need_human */
    stage: varchar("stage", { length: 30 }).notNull().default("new"),
    /** 意向分 0-100 */
    intentScore: integer("intent_score").default(0),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    lastMessageAt: timestamp("last_message_at"),
    /** 对话模式：ai | human */
    handoverMode: varchar("handover_mode", { length: 10 }).notNull().default("ai"),
    /** 真人接管者的 userId */
    takenOverBy: uuid("taken_over_by").references(() => users.id, { onDelete: "set null" }),
    /** 接管时间戳 */
    takenOverAt: timestamp("taken_over_at"),
    /** 销售最后一次查看该 lead 的时间（用于计算未读数） */
    lastReadAt: timestamp("last_read_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_leads_tenant").on(table.tenantId),
    index("idx_leads_stage").on(table.stage),
    uniqueIndex("idx_leads_channel_external").on(
      table.tenantId,
      table.channel,
      table.externalId
    ),
  ]
);

/** 销售对话消息（与 conversations 区分：这是客户↔AI Sales 的对外沟通） */
export const salesMessages = pgTable(
  "sales_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }).notNull(),
    /** inbound (客户发来) | outbound (AI/人工回复) */
    direction: varchar("direction", { length: 10 }).notNull(),
    /** text | image | card | link */
    kind: varchar("kind", { length: 20 }).notNull().default("text"),
    content: text("content").notNull(),
    /** AI 生成标记: true 表示此条由 ConversationAgent 生成，待发或已发 */
    isAiGenerated: boolean("is_ai_generated").default(false),
    sentAt: timestamp("sent_at"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_sm_lead").on(table.leadId),
    index("idx_sm_tenant").on(table.tenantId),
  ]
);

// PR P1（5-9 砍定时发布）：scheduledPublishes 表 + publish-worker 已删除。
// migrate.ts 加 DROP TABLE IF EXISTS 清理 prod 残留 row。
// 用户改为审核通过后手动一键发布（走 publisher.publishToAccounts）。

// ============ PR #123 V2 P6 tenant 偏好（5-15）============
// 业务：用户上次选的 template 下次默认填这个（"用户上次选 B 营销 → 下次进 chat 默认 B"）。
// 通用 key/value 结构（PK 复合 tenant_id + key），未来可加 default_journal / default_priority 等。
export const tenantPreferences = pgTable(
  "tenant_preferences",
  {
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    preferenceKey: varchar("preference_key", { length: 60 }).notNull(),
    preferenceValue: text("preference_value").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.preferenceKey] }),
  ]
);

// ============ PR #118 V2 P4 批量 csv 导入（5-12）============
// 业务：行业代发场景一次 csv 跑 50-100 个客户期刊。
// batch 主表 + batch_rows 子表（一行 = 一篇 article 任务）。
// 状态机接入 P0：每 row 创建 article 走 transitionStatus 完整链路。
export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    filename: varchar("filename", { length: 200 }),
    total: integer("total").notNull().default(0),
    completed: integer("completed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    // status: pending | running | completed | failed | cancelled
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_batches_tenant").on(table.tenantId),
    index("idx_batches_status").on(table.status),
  ]
);

export const batchRows = pgTable(
  "batch_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").references(() => batches.id, { onDelete: "cascade" }).notNull(),
    rowIndex: integer("row_index").notNull(), // csv 第几行（从 1 开始）
    topic: text("topic").notNull(),
    journalId: uuid("journal_id"), // 选填，缺则 AI 自动推荐
    template: varchar("template", { length: 30 }), // A/B/C/E（缺 = default）
    // PR-X1: 独家生成时绑定账号 — worker 据此注入该账号的人设/风格画像
    accountId: uuid("account_id").references(() => platformAccounts.id, { onDelete: "set null" }),
    priority: integer("priority").default(3), // 1-5（决定队列顺序）
    // status: pending | generating | generated | failed
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    articleId: uuid("article_id").references(() => contents.id, { onDelete: "set null" }), // 创建后 FK
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_batch_rows_batch").on(table.batchId),
    index("idx_batch_rows_status").on(table.status),
  ]
);

// ============ PR #133 V2.5 Day 1 (5-12): user 跳过推荐 article 日志 ============
// 用户在 "📅 今日推荐" tab 点 ⏭ 跳过，记入此表。GET /content/recommendations 默认排除已 skip。
// PK (tenant_id, content_id) 保 idempotent。tenant_id 是 user 自己 tenant 不是 system。
export const userSkipLog = pgTable(
  "user_skip_log",
  {
    tenantId: uuid("tenant_id").notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "cascade" }).notNull(), // 7-18 审计: 补外键防孤儿(migration 025)
    skippedAt: timestamp("skipped_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_skip_log_tenant").on(table.tenantId),
  ]
);

// ============ PR #165 enrichment 观察日志 (0 风险, 仅记录 source 命中/耗时) ============
// 每次 enrichJournal 调多源 fetcher, 每源写一行 (含 status / duration / fields_written).
// 用于 PR #165c/d 决策基线 (失败率 / 字段贡献分布).
export const journalEnrichmentLog = pgTable(
  "journal_enrichment_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journalId: uuid("journal_id").references(() => journals.id, { onDelete: "cascade" }).notNull(),
    source: varchar("source", { length: 20 }).notNull(), // letpub | crossref | doaj | scimago | openalex | wanfang | fenqubiao
    status: varchar("status", { length: 20 }).notNull(), // success | failed | timeout | skipped
    fieldsWritten: jsonb("fields_written"),
    errorMessage: varchar("error_message", { length: 500 }),
    durationMs: integer("duration_ms"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_jel_journal").on(table.journalId),
    index("idx_jel_source").on(table.source),
    index("idx_jel_status").on(table.status),
    index("idx_jel_attempted").on(table.attemptedAt),
  ]
);

// ============ PR #161 Workbench v2: bulk-distribute 永久去重日志 ============
// POST /admin/bulk-distribute 笛卡尔积入 queue, worker 完成后 INSERT ... ON CONFLICT UPDATE.
// UNIQUE (content_id, account_id) 让重复发布"已成功"对自动 skipped, 节省 API 调用 + 防重发.
// initiated_by: 'bulk_distribute' (本 PR 主路径) | 'manual' (单文章 publish) | 'system' (cron)
export const contentPublishLog = pgTable(
  "content_publish_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "cascade" }).notNull(), // 7-18 审计: 补外键防孤儿(migration 025)
    accountId: uuid("account_id").references(() => platformAccounts.id, { onDelete: "cascade" }).notNull(),
    // 7-06 ② 扩到 30 (migration 023): success | failed | skipped | draft | draft_pushed | dispatched
    //   | published_by_operator (推的草稿被运营群发 = 市场选择正信号) | draft_expired (推了7天没发 = 负信号)
    status: varchar("status", { length: 30 }).notNull(),
    mediaId: varchar("media_id", { length: 200 }),
    errorMessage: varchar("error_message", { length: 500 }),
    initiatedBy: varchar("initiated_by", { length: 20 }),
    initiatedUserId: uuid("initiated_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * 🔴 8-20 分发时点的质量快照 —— 'passed' | 'below_bar' | 'unscored'。
     * 语义、为什么记在这张表、为什么三档不能合成两档：见
     * `services/publisher/quality-verdict.ts` 的文件头。
     *
     * **NULL = 这行早于打标机制（8-20 之前），不是"没判断"。** 存量刻意不回填：
     * 回填只能拿 metadata 的**当前**值冒充**当时**值，而"冻结当时的判断"正是本字段的全部意义。
     *
     * 用途是将来接上 wechat_stats 后按它分组，回答
     * 「发 14 篇不达标的 vs 发 2 篇达标的，哪个对生意更好」—— 这个问题今天答不了。
     */
    qualityVerdict: varchar("quality_verdict", { length: 16 }),
    /** 分发时点的六维总分快照；unscored 时为 NULL。与 qualityVerdict 同批写入。 */
    sixDimTotal: numeric("six_dim_total", { precision: 5, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_cpl_dedup").on(table.contentId, table.accountId),
    index("idx_cpl_tenant").on(table.tenantId),
    index("idx_cpl_status").on(table.status),
    index("idx_cpl_created").on(table.createdAt),
  ]
);

// PR-N: 期刊使用记录 — 每次生成内容(盘点等)选到的刊记一笔, 用于"15天不重复"冷却。
export const journalUsage = pgTable(
  "journal_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    journalId: uuid("journal_id").references(() => journals.id, { onDelete: "cascade" }).notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "set null" }),
    usedAt: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_ju_lookup").on(table.tenantId, table.journalId, table.usedAt),
  ]
);

// ============ Agent-1 (B轨): 本地发布 Agent — 设备表 ============
// 本地 Agent 跑在客户电脑(家用IP+有头浏览器), 轮询服务器领发布任务。
// token 明文只在配对响应出现一次, 服务端只存 sha256 hex (token_hash)。
// ============ PR-W1: 成本台账 — 真金白银扣费流水 ============
// kind: dvh(数字人合成 0.165元/秒) | tts | render | llm。amount_cents 人民币分。
// quantity: 计量数 (dvh=秒)。今日/本月消耗 = SUM(amount_cents) WHERE created_at 范围。
export const costLedger = pgTable(
  "cost_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "set null" }),
    amountCents: integer("amount_cents").notNull(),
    quantity: integer("quantity"),
    note: varchar("note", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_cost_ledger_tenant_time").on(table.tenantId, table.createdAt),
  ]
);

export const agentDevices = pgTable(
  "agent_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    name: varchar("name", { length: 100 }).notNull(), // "老韩的MacBook"
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(), // sha256(token) hex
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | disabled
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    version: varchar("version", { length: 20 }), // agent 客户端版本
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_agent_devices_tenant").on(table.tenantId),
  ]
);

// ============ Agent-1 (B轨): 本地发布 Agent — 发布任务队列 ============
// 派单(agent-admin dispatch)建行 → Agent claim(FOR UPDATE SKIP LOCKED 原子领单) → 回报 result。
export const agentPublishTasks = pgTable(
  "agent_publish_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "cascade" }).notNull(),
    accountId: uuid("account_id").references(() => platformAccounts.id, { onDelete: "cascade" }).notNull(),
    platform: varchar("platform", { length: 20 }).notNull(), // 派单给本地 Agent 的平台 = capabilities 表里 publishVia==="agent" 的那些(当前 douyin | wechat_video)
    accountName: varchar("account_name", { length: 200 }),
    videoSource: text("video_source").notNull(), // /storage/相对路径 或 http(s) url
    caption: text("caption"),
    title: varchar("title", { length: 200 }),
    // pending | claimed | success | failed | login_expired | canceled
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    agentDeviceId: uuid("agent_device_id").references(() => agentDevices.id, { onDelete: "set null" }),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_apt_tenant_status").on(table.tenantId, table.status),
    index("idx_apt_content").on(table.contentId),
  ]
);

// ============ 7-25 运维告警三件套: 事件流水 + 每日简报快照 ============
// 设计原则: 系统失败必须"喊出来", 不能只躺日志里静默。
//   ops_incidents  = 原子异常事件流水(记账失败 / LLM 额度不足 / 零产出 / 推送失败…)
//                    这些点原先只有 logger.error, 运营看不见; 落库后进每日简报 + 今日驾驶舱。
//   ops_briefings  = 每日运营简报快照(推送成功与否都落库), 保证"告警本身挂了也看得到"。
export const opsIncidents = pgTable(
  "ops_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 可为空: LLM 额度不足这类"平台级"故障不属于任何租户
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    // ledger_write_failed | llm_quota | zero_output | briefing_push_failed | supplier_balance_low ...
    kind: varchar("kind", { length: 40 }).notNull(),
    severity: varchar("severity", { length: 10 }).notNull().default("error"), // error | warn
    message: varchar("message", { length: 500 }).notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_ops_incidents_time").on(table.createdAt),
    index("idx_ops_incidents_kind_time").on(table.kind, table.createdAt),
  ],
);

export const opsBriefings = pgTable(
  "ops_briefings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    briefDate: date("brief_date").notNull(), // 北京时间日期 YYYY-MM-DD
    level: varchar("level", { length: 10 }).notNull().default("ok"), // ok | warn | alert
    /** 结构化快照(BriefingSnapshot), 前端卡片直接渲染 */
    summary: jsonb("summary").notNull(),
    /** 渲染好的企微纯文本(推送失败时前端也能原样展示) */
    text: text("text").notNull(),
    pushed: boolean("pushed").notNull().default(false),
    pushError: varchar("push_error", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_ops_briefings_tenant_date").on(table.tenantId, table.briefDate),
  ],
);

// ============ Golden Set 人工标注（评估体系基准）============
/**
 * 8-02 Golden Set: 老板/运营对内容质量的**人工判断**落库, 是整个评估体系的基准线。
 *
 * 为什么单独建表而不是塞 contents.metadata:
 *   ① 一篇内容会被**多个人**标(老板定标尺 → 运营续标), metadata 是单值坑;
 *   ② 标注要能改(同一人对同一篇只有一条, 靠 UNIQUE(content_id, annotator_id) 兜);
 *   ③ 这批数据的用途是**跟六维分做相关性**, 混进 metadata 会跟被评估对象耦合,
 *      日后想"重算相关性/换评分器再跑一遍"就没有干净的对照组了。
 *
 * ⚠️ 防锚定铁律: 标注**采集**过程绝不能让标注人看见系统分(见 services/golden-set/anchor-guard.ts)。
 *   这张表只存人的判断; 系统分留在 contents.metadata, 分析时再 JOIN。
 */
export const goldenSetAnnotations = pgTable(
  "golden_set_annotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentId: uuid("content_id")
      .references(() => contents.id, { onDelete: "cascade" })
      .notNull(),
    tenantId: uuid("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    /** 谁标的 — 老板 vs 运营的尺子日后要能分开算(标注者间信度) */
    annotatorId: uuid("annotator_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    /** good | fair | poor — 值域真相源见 services/golden-set/labels.ts GOLDEN_LABELS */
    label: varchar("label", { length: 10 }).notNull(),
    /** 一句话理由(自由文本, 不强制)。**将来用它提炼"驳回原因分类词表"**, 别做成下拉框。 */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_golden_content_annotator").on(table.contentId, table.annotatorId),
    index("idx_golden_tenant_annotator").on(table.tenantId, table.annotatorId),
    index("idx_golden_content").on(table.contentId),
  ],
);

/**
 * 检查器台账（8-14 方法论移植 Phase 1）。**聚合计数，不逐条落行。**
 *
 * 命中明细继续走各闸自己的 metadata / ops_incidents；本表只做按周聚合，
 * 每个 checker 每周一行（upsert），给 DB 的写入压力接近零。
 *
 * 🔴 `confirmedTrue + confirmedFalse` = **已裁决数**，是台账成熟度的唯一度量。
 * 所有自动判定都以它为门槛，未裁决的命中不计入任何结论 ——
 * 「没有被确认为真」不等于「被确认为假」。
 */
export const checkerLedger = pgTable(
  "checker_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 与 services/ops/checker-registry.ts 的 id 对齐 */
    checkerId: varchar("checker_id", { length: 80 }).notNull(),
    /** 该周周一(UTC)。按周聚合 */
    periodStart: date("period_start").notNull(),
    /** 闸跑过几次 */
    evaluated: integer("evaluated").notNull().default(0),
    /** 报了几条 */
    hits: integer("hits").notNull().default(0),
    /** 人工裁决为真阳性（Phase 3 反馈入口写入） */
    confirmedTrue: integer("confirmed_true").notNull().default(0),
    /** 人工裁决为误报 */
    confirmedFalse: integer("confirmed_false").notNull().default(0),
    /** 本该拦而没拦（漏网举报） */
    confirmedMiss: integer("confirmed_miss").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_checker_ledger_period").on(table.checkerId, table.periodStart),
    index("idx_checker_ledger_period").on(table.periodStart),
  ],
);

/**
 * 人工裁决记录（8-14 Phase 3 后端数据路径）。
 *
 * **只存裁决，不存命中。** 命中实例由 `checkOutputHealth` 现算 ——
 * 判据永远等于当前代码。命中一旦落表就会与闸的当前判据漂移：
 * 裁决一条三周前按旧判据命中的记录，结论对今天的闸没有意义。
 */
/**
 * 决策留痕（8-17，第一批：选刊链路）。**纯观测。**
 *
 * 两类行：`intent`（调用选刊器**之前**记"我要请求了"）与 `consumption`（每消耗一本刊一行）。
 * 只记选中的话，遇到空白分不清「这条路没跑」还是「跑了但没接留痕」——
 * 意图与消耗对不上的就是漏接路径。
 *
 * 🔴 两个学科口径都在这张表里，**绝不能互换**：
 *   · `slotDiscipline`（需求侧）—— 配额按它计
 *   · `journalDiscipline`（供给侧）—— 池子余量按它算
 * generic 通配刊被 education 槽位选中时，消耗的是 education 的配额、减少的是 generic 池的余量。
 */
/**
 * 运行时参数（8-18 Phase 4）。**定义在代码，值在库。**
 *
 * 有哪些参数、什么类型、边界多少、给运营怎么解释 —— 由 `services/ops/runtime-params.ts`
 * 的注册表决定；本表只存**值**。读取顺序：DB → env → 代码默认，
 * 三层都在，所以没被配过的参数行为零变化。
 */
export const runtimeParams = pgTable("runtime_params", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 参数变更审计。**参数能被运营改，就必须能回答「谁把它改成这样的」** */
export const runtimeParamAudits = pgTable(
  "runtime_param_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 64 }).notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value").notNull(),
    /** 不做外键：用户删了审计仍要保留，否则「谁改的」会凭空消失 */
    changedBy: uuid("changed_by"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_runtime_param_audits_key").on(table.key, table.createdAt)],
);

export const decisionTraces = pgTable(
  "decision_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    point: varchar("point", { length: 40 }).notNull(),
    /** intent | consumption */
    phase: varchar("phase", { length: 16 }).notNull(),
    correlationId: uuid("correlation_id"),
    /** unknown = 调用方没传上下文 = 漏接的路径 */
    requestedBy: varchar("requested_by", { length: 40 }).notNull().default("unknown"),
    slotDiscipline: varchar("slot_discipline", { length: 32 }),
    journalDiscipline: varchar("journal_discipline", { length: 32 }),
    scope: varchar("scope", { length: 24 }),
    journalId: uuid("journal_id"),
    contentId: uuid("content_id"),
    /** 降级链，任意层数：[{layer, tier, reason}] */
    fallback: jsonb("fallback").notNull().default([]),
    genericWildcard: boolean("generic_wildcard").notNull().default(false),
    tenantId: uuid("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_decision_traces_created").on(table.createdAt),
    index("idx_decision_traces_point").on(table.point, table.phase),
    index("idx_decision_traces_corr").on(table.correlationId),
  ],
);

export const checkerAdjudications = pgTable(
  "checker_adjudications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkerId: varchar("checker_id", { length: 80 }).notNull(),
    contentId: uuid("content_id").notNull(),
    /** true_positive=拦对了 / false_positive=拦错了 / miss=本该拦没拦 */
    verdict: varchar("verdict", { length: 20 }).notNull(),
    /** 不做外键：用户删了裁决仍应保留，否则台账会凭空缩水 */
    annotatorId: uuid("annotator_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_checker_adjudication").on(table.checkerId, table.contentId, table.annotatorId),
    index("idx_checker_adjudication_created").on(table.createdAt),
  ],
);
