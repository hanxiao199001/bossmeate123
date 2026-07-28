/**
 * 平台特性收单表 —— **前端唯一真相源** (7-28 阶段1-B)。
 *
 * ## 为什么是"镜像"而不是从后端共享一份
 * 试过的三条路各自的挡路石:
 *   1. `@bossmate/shared` 共享包 —— 该包 `main` 直指裸 `src/types.ts`(无 build 脚本),
 *      而 server 是 `tsc → dist` 后用 node 跑, 引入未编译的 workspace 包会在**部署后**
 *      静默炸(和 7-23 "词库 txt 只部署 dist 就空转" 同一类事故)。要修得先给 shared 加构建、
 *      改两个包的依赖与部署脚本 —— 收益不抵风险。
 *   2. 走 API 下发 —— 平台判据在前端是**同步**用的(`AGENT_PLATFORMS.has(...)` 在渲染分支里),
 *      改成 async 要动 6 个页面的加载态, 且首屏拿不到表时无从渲染。
 *   3. 本方案: 前后端各一份纯数据, 由 `packages/server/src/__tests__/platform-capabilities.test.ts`
 *      逐平台逐字段比对, 任一边改了另一边没跟 → 测试变红并打印差异。
 *
 * 也就是说: 复制被允许, 但**漂移不被允许**。这与"判据必须有唯一归宿"的目标一致 ——
 * 归宿是 `packages/server/src/services/platforms/capabilities.ts`, 本文件是它的受检投影。
 *
 * ## 前端改动规则
 * - 页面/组件**不许**再写平台字面量数组/Set/Record, 一律 import 本文件的常量或 helper。
 *   (由 `platform-capabilities.test.ts` 的全量扫描守着 `apps/web/src/**`)
 * - `utils/i18n.ts` 的 `PLATFORM_META` 现在从本文件派生, 不再是第二份定义。
 */

/** 发布通道: server=服务器持凭证直发 / agent=登录态在客户本机, 派单给本地 Agent */
export type PublishVia = "server" | "agent";
/** 内容形态: article=图文 / video=视频 */
export type PlatformContentKind = "article" | "video";

export interface CredentialField {
  key: string;
  label: string;
  type: "input" | "textarea" | "password";
  placeholder: string;
  required: boolean;
}

export interface PlatformCapability {
  id: string;
  label: string;
  shortLabel?: string;
  icon: string;
  color: string;
  contentKind: PlatformContentKind;
  publishVia: PublishVia;
  /** 半自动: 无稳定发布 API, 凭证选填(账号=矩阵号标签) */
  semiAuto: boolean;
  /** 支持服务器侧扫码登录(账号管理页显示扫码入口/登录态) */
  browserLogin: boolean;
  credentialFields: readonly CredentialField[];
  credentialHint: string;
}

/** 与后端 PLATFORM_CAPABILITIES 逐字段一致(测试守卫)。顺序即平台选择器展示顺序。 */
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
    credentialFields: [
      { key: "appId", label: "AppID", type: "input", placeholder: "微信公众号AppID", required: true },
      { key: "appSecret", label: "AppSecret", type: "password", placeholder: "微信公众号AppSecret", required: true },
    ],
    credentialHint: "需要AppID和AppSecret",
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
    credentialFields: [
      { key: "accessToken", label: "AccessToken", type: "textarea", placeholder: "百家号开放平台的AccessToken", required: true },
    ],
    credentialHint: "需要百家号开放平台AccessToken",
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
    credentialFields: [
      { key: "accessToken", label: "AccessToken", type: "textarea", placeholder: "头条号开放平台的AccessToken", required: true },
    ],
    credentialHint: "需要头条号开放平台AccessToken",
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
    credentialFields: [
      { key: "cookie", label: "Cookie", type: "textarea", placeholder: "浏览器登录知乎后获取的Cookie", required: true },
      { key: "columnId", label: "专栏ID（可选）", type: "input", placeholder: "如 my-column", required: false },
    ],
    credentialHint: "需要登录Cookie和专栏ID（可选）",
  },
  xiaohongshu: {
    id: "xiaohongshu",
    label: "小红书",
    icon: "📕",
    color: "bg-pink-100 text-pink-700",
    contentKind: "article",
    publishVia: "server",
    semiAuto: true,
    browserLogin: false,
    credentialFields: [
      { key: "cookie", label: "Cookie", type: "textarea", placeholder: "浏览器登录小红书后获取的Cookie", required: true },
    ],
    credentialHint: "需要登录Cookie",
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
    credentialFields: [
      { key: "clientKey", label: "Client Key", type: "input", placeholder: "抖音开放平台 Client Key", required: true },
      { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "抖音开放平台 Client Secret", required: true },
      { key: "accessToken", label: "Access Token", type: "textarea", placeholder: "OAuth2 授权获取的 access_token", required: true },
      { key: "openId", label: "Open ID", type: "input", placeholder: "用户 open_id（授权回调返回）", required: false },
    ],
    credentialHint: "需要抖音开放平台OAuth授权",
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
    credentialFields: [
      { key: "appId", label: "AppID", type: "input", placeholder: "公众号 AppID（需绑定视频号）", required: true },
      { key: "appSecret", label: "AppSecret", type: "password", placeholder: "公众号 AppSecret", required: true },
    ],
    credentialHint: "需要公众号绑定视频号",
  },
};

/** 全部平台 id(展示顺序) */
export const PLATFORM_IDS: readonly string[] = Object.keys(PLATFORM_CAPABILITIES);

export function getPlatformCapability(platform: string): PlatformCapability | undefined {
  return PLATFORM_CAPABILITIES[platform];
}

function idsWhere(pred: (c: PlatformCapability) => boolean): readonly string[] {
  return PLATFORM_IDS.filter((id) => pred(PLATFORM_CAPABILITIES[id]!));
}

/** 登录态在客户本机 → 派单给本地 Agent(视频链路) */
export const AGENT_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.publishVia === "agent"));
/** 视频平台 */
export const VIDEO_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.contentKind === "video"));
/** 图文平台 */
export const ARTICLE_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.contentKind === "article"));
/** 半自动平台(凭证选填) */
export const SEMI_AUTO_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.semiAuto));
/** 支持扫码登录(账号卡片显示登录态/扫码按钮) */
export const BROWSER_LOGIN_PLATFORMS: ReadonlySet<string> = new Set(idsWhere((c) => c.browserLogin));

export const isAgentPlatform = (p: string): boolean => AGENT_PLATFORMS.has(p);
export const isVideoPlatform = (p: string): boolean => VIDEO_PLATFORMS.has(p);
export const isSemiAutoPlatform = (p: string): boolean => SEMI_AUTO_PLATFORMS.has(p);
export const isBrowserLoginPlatform = (p: string): boolean => BROWSER_LOGIN_PLATFORMS.has(p);

/** 平台全称(未知平台兜底显示原值) */
export function platformLabel(platform: string): string {
  return PLATFORM_CAPABILITIES[platform]?.label ?? platform;
}

/** 平台简称(无简称时退全称, 未知平台兜底显示原值) */
export function platformShortLabel(platform: string): string {
  const c = PLATFORM_CAPABILITIES[platform];
  return c?.shortLabel ?? c?.label ?? platform;
}

/** 平台图标(未知平台给个中性地球) */
export function platformIcon(platform: string): string {
  return PLATFORM_CAPABILITIES[platform]?.icon ?? "🌐";
}

/** 平台 badge 配色 class */
export function platformColor(platform: string): string {
  return PLATFORM_CAPABILITIES[platform]?.color ?? "bg-gray-100 text-gray-600";
}
