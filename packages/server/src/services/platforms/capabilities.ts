/**
 * 平台特性收单表 —— 全系统唯一真相源 (7-28 阶段1-B)。
 *
 * ## 病根(同一个知识被复制了 30 次)
 * 「这个平台是什么样的」原本散在服务端 17 处 + 前端 13 处, 每处只抄自己当下需要的那一维:
 *   - `AGENT_PLATFORMS` 抄了两份 (agent-dispatch.ts 与 publish-pacing.ts, 后者压根没 import 前者)
 *   - `SEMI_AUTO_PLATFORMS` 在 routes/accounts.ts **同一个文件里写了两遍** (:207 与 :409)
 *   - `VIDEO_PLATFORMS` 三份 (publisher/index.ts / content-director.ts / TodayPage.tsx)
 *   - 凭证字段表两份 (routes/accounts.ts 的 credentialFields 与 AccountsPage 的 CREDENTIAL_FIELDS)
 *   - 中文名/图标四份以上
 * 后果是加一个平台要改 30 个地方, 改漏一个就是静默错路由(如视频打到没凭证的 /publish)。
 *
 * ## 收口规则
 * 1. 「平台是什么样的」= 纯数据, 一律进本表, 零 IO 零依赖(可被任何层 import, 不会成环)。
 * 2. 「平台怎么做事」= 行为(适配器实例 / puppeteer 登录判定 / 推草稿函数)留在各自模块,
 *    但它们的 **key 集合必须由本表校验** —— 用 `definePlatformMap()` 在模块加载时断言,
 *    键漏了/多了直接抛错, 不等到线上静默走错分支。
 * 3. 前端有一份镜像 `apps/web/src/utils/platforms.ts` (跨端不共享包的理由见那个文件头),
 *    由 `__tests__/platform-capabilities.test.ts` 做前后端一致性守卫。
 *
 * ## 新增一个平台要改哪儿
 * 只改本表 + 前端镜像 + 补上行为实现(adapter / pusher / 登录配置)。其余全部自动跟随。
 */

/** 发布通道: server=服务器持凭证直发 / agent=登录态在客户本机, 派单给本地 Agent */
export type PublishVia = "server" | "agent";
/** 内容形态: article=图文 / video=视频 */
export type PlatformContentKind = "article" | "video";
/** 发布能力: full=可群发 / draft_only=只能进草稿箱 */
export type PublishCapability = "full" | "draft_only";
/** 获客文案注入方式 */
export type LeadCaptureStyle = "none" | "xiaohongshu" | "article";

export interface CredentialField {
  key: string;
  label: string;
  /** 前端控件类型 */
  type: "input" | "textarea" | "password";
  placeholder: string;
  required: boolean;
}

export interface PlatformCapability {
  /** platform_accounts.platform / contents.platforms[].platform 的取值 */
  id: string;

  // ---- 显示层(前端镜像同步这三项 + color) ----
  /** 全称: 账号管理 / 详情页发布面板 */
  label: string;
  /** 简称: 工坊卡片 / 推荐面板等紧凑场景(缺省=label) */
  shortLabel?: string;
  icon: string;
  /** 前端 badge 配色 class(仅前端用, 放这里是为了让前后端镜像可逐字段比对) */
  color: string;

  // ---- 路由/调度判据 ----
  /** 内容形态智能路由: 视频只发 video 平台, 图文只发 article 平台 */
  contentKind: PlatformContentKind;
  /** 派单通道 — 决定走 dispatchVideoToAgent 还是 adapter.publish */
  publishVia: PublishVia;
  /**
   * 半自动平台: 第三方无稳定发布 API, 内容最终由人工在平台后台发布。
   * 账号只是矩阵"名字标签" → 空凭证也算就绪, 不去调 API 验证。
   * 注意 ≠ publishVia==="agent": 小红书是半自动但没有 Agent 推草稿实现。
   */
  semiAuto: boolean;
  /** 服务器侧扫码登录(puppeteer 拿登录态) */
  browserLogin: boolean;
  /** 支持"推草稿到创作后台"(draft-push.ts 有实现) */
  supportsDraftPush: boolean;
  /** 创作后台 origin(注入 localStorage 前必须先停在该域); 无则 null */
  creatorOrigin: string | null;
  /** OAuth 开放平台授权(目前只有抖音) */
  supportsOAuth: boolean;
  /** 有服务器发布适配器(services/publisher/adapters/*) */
  hasAdapter: boolean;

  // ---- 内容策略 ----
  /** 风控词典组合: common ∪ 这些 key 对应的词库(见 risk-control/dictionaries) */
  riskDictionaries: readonly string[];
  /** 获客文案注入方式(视频统一走 digest, 由内容类型决定, 不看本字段) */
  leadCapture: LeadCaptureStyle;
  /** 默认发布能力(仅 wechat 区分 full/draft_only; 其余保守给 draft_only) */
  defaultCapability: PublishCapability;
  /** content-director 的文章风格/字数(视频平台为 null) */
  styleProfile: { style: string; wordCount: number } | null;
  /** content-director 默认排期时刻 HH:mm */
  defaultPublishHour: string;

  // ---- 接入 ----
  credentialFields: readonly CredentialField[];
  /** 凭证获取说明(账号管理页 + GET /accounts/platforms) */
  credentialHint: string;
  /** 聊天里用户会怎么称呼它(routes/chat.ts 自然语言解析) */
  aliases: readonly string[];
}

/**
 * 唯一定义。顺序即前端账号管理页平台选择器的展示顺序。
 */
export const PLATFORM_CAPABILITIES: Readonly<Record<string, PlatformCapability>> = {
  wechat: {
    id: "wechat",
    label: "微信公众号",
    shortLabel: "公众号",
    icon: "💬",
    color: "bg-green-100 text-green-700",
    contentKind: "article",
    publishVia: "server",
    semiAuto: false,
    browserLogin: false,
    supportsDraftPush: false,
    creatorOrigin: null,
    supportsOAuth: false,
    hasAdapter: true,
    riskDictionaries: ["wechat"],
    // 公众号正文已有服务卡片, 不重复注入获客尾部
    leadCapture: "none",
    defaultCapability: "draft_only",
    styleProfile: { style: "deep_analysis", wordCount: 2000 },
    defaultPublishHour: "08:30",
    credentialFields: [
      { key: "appId", label: "AppID", type: "input", placeholder: "微信公众号AppID", required: true },
      { key: "appSecret", label: "AppSecret", type: "password", placeholder: "微信公众号AppSecret", required: true },
    ],
    credentialHint: "需要AppID和AppSecret",
    aliases: ["微信", "公众号"],
  },
  baijiahao: {
    id: "baijiahao",
    label: "百家号",
    icon: "📰",
    color: "bg-blue-100 text-blue-700",
    contentKind: "article",
    publishVia: "server",
    semiAuto: false,
    browserLogin: false,
    supportsDraftPush: false,
    creatorOrigin: null,
    supportsOAuth: false,
    hasAdapter: true,
    riskDictionaries: [],
    leadCapture: "article",
    defaultCapability: "draft_only",
    styleProfile: { style: "popular_science", wordCount: 1200 },
    defaultPublishHour: "09:00",
    credentialFields: [
      { key: "accessToken", label: "AccessToken", type: "textarea", placeholder: "百家号开放平台的AccessToken", required: true },
    ],
    credentialHint: "需要百家号开放平台AccessToken",
    aliases: ["百家号", "百家"],
  },
  toutiao: {
    id: "toutiao",
    label: "头条号",
    icon: "📱",
    color: "bg-red-100 text-red-700",
    contentKind: "article",
    publishVia: "server",
    semiAuto: false,
    browserLogin: false,
    supportsDraftPush: false,
    creatorOrigin: null,
    supportsOAuth: false,
    hasAdapter: true,
    riskDictionaries: [],
    leadCapture: "article",
    defaultCapability: "draft_only",
    styleProfile: { style: "news_brief", wordCount: 800 },
    defaultPublishHour: "10:00",
    credentialFields: [
      { key: "accessToken", label: "AccessToken", type: "textarea", placeholder: "头条号开放平台的AccessToken", required: true },
    ],
    credentialHint: "需要头条号开放平台AccessToken",
    aliases: ["头条", "今日头条"],
  },
  zhihu: {
    id: "zhihu",
    label: "知乎",
    icon: "🔍",
    color: "bg-blue-100 text-blue-600",
    contentKind: "article",
    publishVia: "server",
    semiAuto: false,
    browserLogin: false,
    supportsDraftPush: false,
    creatorOrigin: null,
    supportsOAuth: false,
    hasAdapter: true,
    riskDictionaries: [],
    leadCapture: "article",
    defaultCapability: "draft_only",
    styleProfile: { style: "qa_format", wordCount: 1500 },
    defaultPublishHour: "11:00",
    credentialFields: [
      { key: "cookie", label: "Cookie", type: "textarea", placeholder: "浏览器登录知乎后获取的Cookie", required: true },
      { key: "columnId", label: "专栏ID（可选）", type: "input", placeholder: "如 my-column", required: false },
    ],
    credentialHint: "需要登录Cookie和专栏ID（可选）",
    aliases: ["知乎"],
  },
  xiaohongshu: {
    id: "xiaohongshu",
    label: "小红书",
    icon: "📕",
    color: "bg-pink-100 text-pink-700",
    contentKind: "article",
    // 服务器侧有 adapter, 但无稳定发布 API → 实质半自动
    publishVia: "server",
    semiAuto: true,
    browserLogin: false,
    supportsDraftPush: false,
    creatorOrigin: null,
    supportsOAuth: false,
    hasAdapter: true,
    riskDictionaries: [],
    leadCapture: "xiaohongshu",
    defaultCapability: "draft_only",
    styleProfile: { style: "listicle", wordCount: 600 },
    defaultPublishHour: "12:00",
    credentialFields: [
      { key: "cookie", label: "Cookie", type: "textarea", placeholder: "浏览器登录小红书后获取的Cookie", required: true },
    ],
    credentialHint: "需要登录Cookie",
    aliases: ["小红书", "红书"],
  },
  douyin: {
    id: "douyin",
    label: "抖音",
    icon: "🎵",
    color: "bg-gray-100 text-gray-800",
    contentKind: "video",
    publishVia: "agent",
    semiAuto: true,
    browserLogin: true,
    supportsDraftPush: true,
    creatorOrigin: "https://creator.douyin.com",
    supportsOAuth: true,
    hasAdapter: true,
    riskDictionaries: ["douyin"],
    leadCapture: "none",
    defaultCapability: "draft_only",
    styleProfile: null,
    defaultPublishHour: "18:00",
    credentialFields: [
      { key: "clientKey", label: "Client Key", type: "input", placeholder: "抖音开放平台 Client Key", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "抖音开放平台 Client Secret", required: true },
      { key: "accessToken", label: "Access Token", type: "textarea", placeholder: "OAuth2 授权获取的 access_token", required: true },
      { key: "openId", label: "Open ID", type: "input", placeholder: "用户 open_id（授权回调返回）", required: false },
    ],
    credentialHint: "需要抖音开放平台OAuth授权",
    aliases: ["抖音"],
  },
  wechat_video: {
    id: "wechat_video",
    label: "视频号",
    icon: "📹",
    color: "bg-green-100 text-green-600",
    contentKind: "video",
    publishVia: "agent",
    semiAuto: true,
    browserLogin: true,
    supportsDraftPush: true,
    creatorOrigin: "https://channels.weixin.qq.com",
    supportsOAuth: false,
    hasAdapter: true,
    // 视频号继承 wechat 的营销/导流红线 + 自身专有
    riskDictionaries: ["wechat", "wechat_video"],
    leadCapture: "none",
    defaultCapability: "draft_only",
    styleProfile: null,
    defaultPublishHour: "19:00",
    credentialFields: [
      { key: "appId", label: "AppID", type: "input", placeholder: "公众号 AppID（需绑定视频号）", required: true },
      { key: "appSecret", label: "AppSecret", type: "password", placeholder: "公众号 AppSecret", required: true },
    ],
    credentialHint: "需要公众号绑定视频号",
    aliases: ["视频号"],
  },
} as const;

/** 全部平台 id(展示顺序) */
export const PLATFORM_IDS: readonly string[] = Object.keys(PLATFORM_CAPABILITIES);

/** 未知平台返回 undefined —— 调用方必须自己决定兜底(别偷偷当成某个平台) */
export function getPlatformCapability(platform: string): PlatformCapability | undefined {
  return PLATFORM_CAPABILITIES[platform];
}

/** 按布尔维度取平台 id 列表 */
function idsWhere(pred: (c: PlatformCapability) => boolean): readonly string[] {
  return PLATFORM_IDS.filter((id) => pred(PLATFORM_CAPABILITIES[id]!));
}

/** 登录态在客户本机、服务器无凭证 → 走本地 Agent 推草稿, 不走服务器凭证发布 */
export const AGENT_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.publishVia === "agent"));
/** 视频平台(视频内容只往这里发) */
export const VIDEO_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.contentKind === "video"));
/** 图文平台(图文内容只往这里发) */
export const ARTICLE_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.contentKind === "article"));
/** 半自动平台: 空凭证也算就绪(人工发布) */
export const SEMI_AUTO_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.semiAuto));
/** 支持服务器侧扫码登录的平台 */
export const BROWSER_LOGIN_PLATFORM_IDS: readonly string[] = idsWhere((c) => c.browserLogin);
/** 支持推草稿的平台 */
export const DRAFT_PUSH_PLATFORM_IDS: readonly string[] = idsWhere((c) => c.supportsDraftPush);
/** 有服务器发布适配器的平台 */
export const ADAPTER_PLATFORM_IDS: readonly string[] = idsWhere((c) => c.hasAdapter);

export const isAgentPlatform = (p: string): boolean => AGENT_PLATFORMS.has(p);
export const isVideoPlatform = (p: string): boolean => VIDEO_PLATFORMS.has(p);
export const isArticlePlatform = (p: string): boolean => ARTICLE_PLATFORMS.has(p);
export const isSemiAutoPlatform = (p: string): boolean => SEMI_AUTO_PLATFORMS.has(p);

/** 平台全称(未知平台兜底显示原值) */
export function platformLabel(platform: string): string {
  return PLATFORM_CAPABILITIES[platform]?.label ?? platform;
}

/** 平台简称(无简称时退全称, 未知平台兜底显示原值) */
export function platformShortLabel(platform: string): string {
  const c = PLATFORM_CAPABILITIES[platform];
  return c?.shortLabel ?? c?.label ?? platform;
}

/** 创作后台 origin(推草稿注入 localStorage 用) */
export function platformCreatorOrigin(platform: string): string | null {
  return PLATFORM_CAPABILITIES[platform]?.creatorOrigin ?? null;
}

/** 中文别名 → platform id(routes/chat.ts 自然语言解析; "所有/全部/全平台" 由调用方另行处理) */
export const PLATFORM_ALIAS_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    PLATFORM_IDS.flatMap((id) => PLATFORM_CAPABILITIES[id]!.aliases.map((a) => [a, id] as const)),
  ),
);

/**
 * 按平台特性构建"行为表", 并在模块加载时断言 key 集合与本表一致。
 *
 * 用途: 适配器实例 / puppeteer 登录配置 / 推草稿函数这些**含行为**的东西不能进本表
 * (会把 puppeteer 拖进每个 import 本表的模块), 但它们覆盖哪些平台必须由本表说了算。
 * 少一个键 → 该平台静默走不到; 多一个键 → 表和实现打架。两种都在启动时直接抛错。
 */
export function definePlatformMap<T>(
  dimension: keyof Pick<
    PlatformCapability,
    "hasAdapter" | "browserLogin" | "supportsDraftPush"
  >,
  map: Record<string, T>,
): Record<string, T> {
  const expected = new Set(idsWhere((c) => c[dimension] === true));
  const actual = new Set(Object.keys(map));
  const missing = [...expected].filter((k) => !actual.has(k));
  const extra = [...actual].filter((k) => !expected.has(k));
  if (missing.length || extra.length) {
    throw new Error(
      `平台行为表与 PLATFORM_CAPABILITIES.${dimension} 不一致: ` +
        (missing.length ? `缺 [${missing.join(", ")}] ` : "") +
        (extra.length ? `多 [${extra.join(", ")}] ` : "") +
        `— 改 services/platforms/capabilities.ts 的 ${dimension} 或补上实现, 两边必须同时改。`,
    );
  }
  return map;
}
