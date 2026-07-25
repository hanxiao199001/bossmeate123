import { config } from "dotenv";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Monorepo 根 .env 绝对路径（src/config 或 dist/config 上 4 级 = monorepo root）。
 * task #1 root cause：旧 walk-up 模糊查找会先命中影子 `packages/server/.env`，
 * 导致 4-30 root .env JWT 48 字符 fix 从未生效。改绝对路径锁死后杜绝 cwd 影响。
 */
const DEFAULT_ENV_PATH = resolve(__dirname, "../../../../.env");

/**
 * 解析 .env 路径：优先 process.env.ENV_FILE_PATH override，否则用 DEFAULT_ENV_PATH 绝对路径。
 * 不存在直接 throw（fail fast，杜绝 silent fallback 导致的鬼故事）。
 * Exported for unit testing.
 */
export function findEnvFile(envFilePath: string | undefined = process.env.ENV_FILE_PATH): string {
  const target = envFilePath && envFilePath.trim() ? envFilePath : DEFAULT_ENV_PATH;
  if (!existsSync(target)) {
    throw new Error(
      `❌ .env file not found at ${target}. Set ENV_FILE_PATH env var or place .env at monorepo root.`,
    );
  }
  return target;
}

const ENV_FILE = findEnvFile();
console.log(`[env] Loaded env from: ${ENV_FILE}`);
config({ path: ENV_FILE });

const envSchema = z.object({
  // 服务
  PORT: z.coerce.number().default(3000),
  API_PREFIX: z.string().default("/api/v1"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // 数据库
  DATABASE_URL: z.string().min(1, "DATABASE_URL 必须配置"),
  DATABASE_POOL_SIZE: z.coerce.number().default(10),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // JWT
  JWT_SECRET: z.string().min(8, "JWT_SECRET 至少8位"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  // 7-05 多租户开通 P0: 平台管理员手机号白名单(逗号分隔)。默认空=无人可见平台管理功能(/platform/*)。
  PLATFORM_ADMIN_PHONES: z.string().default(""),
  // 7-05 生产自注册闸: production 下默认关闭 POST /auth/register(-company), 客户由平台开通;
  //   设 true 可重开。非 production(dev/test)不受此闸影响, 保持放行以免破坏本地开发与测试。
  ALLOW_SELF_REGISTER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // 凭证加密密钥
  CREDENTIALS_KEY: z.string().optional(),

  // AI - 便宜模型
  DEEPSEEK_API_KEY: z.string().optional(),
  QWEN_API_KEY: z.string().optional(),

  // 模型路由
  DEFAULT_EXPENSIVE_MODEL: z.string().default("deepseek-chat"),
  DEFAULT_CHEAP_MODEL: z.string().default("deepseek-chat"),
  MODEL_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(5),
  AI_FALLBACK_STRATEGY: z.enum(["serial", "race"]).default("serial"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().default(60000),
  AI_ARTICLE_TIMEOUT_MS: z.coerce.number().default(120000),

  // 7-06: LLM 单价覆盖(JSON, 单位: 分/1M token), 如 {"deepseek-chat":{"in":200,"out":800}}
  //   默认价目在 services/billing/llm-cost.ts(2026-07 手抄, 以百炼账单为准); 改价/补新模型不用改代码
  LLM_PRICE_OVERRIDES: z.string().optional(),

  // 7-05 ④ AI 审稿员 (services/review/ai-reviewer.ts)
  //   off=完全关闭; shadow=只记建议不动状态(默认, 影子期); live=达信心阈值自动采用/驳回
  AI_REVIEWER_MODE: z.enum(["off", "shadow", "live"]).default("shadow"),
  // live 模式 approve 的最低 confidence, 低于只记建议
  AI_REVIEWER_MIN_CONFIDENCE: z.coerce.number().default(0.75),
  // live 模式每租户每日自动裁决上限(安全阀), 超了退回 shadow 行为
  AI_REVIEWER_DAILY_CAP: z.coerce.number().default(10),

  // 7-05 ⑤ 公众号草稿箱分发 (services/publisher/draft-distributor.ts)
  DRAFT_PUSH_PER_ACCOUNT: z.coerce.number().default(2), // 每号每日推草稿"上限"(ceiling / top-N)
  // 7-14 保底分发: 每号每日草稿"下限"(floor)。分发两轮保底填到该数, 生成量也按此×号数动态定。
  //   语义: DRAFT_TARGET_PER_ACCOUNT(下限) ≤ DRAFT_PUSH_PER_ACCOUNT(上限)。
  DRAFT_TARGET_PER_ACCOUNT: z.coerce.number().default(2),
  // 7-14 生成缓冲乘数: 按"号数×下限"提量时留分配损耗(配不上/冷却枯竭/质检剔除)的余量。
  DRAFT_GEN_BUFFER: z.coerce.number().default(1.3),
  // 7-14 每日生成硬上限: 账号驱动保底定向生成的总篇数天花板, 防号多时 LLM 调用失控。
  DAILY_GEN_HARD_CAP: z.coerce.number().int().min(1).default(40),
  DRAFT_PUSH_CRON_HOUR: z.coerce.number().min(0).max(23).default(8), // 每日几点(BJ)推

  // 7-06 ① 公众号效果数据回流 (services/metrics/wechat-stats-collector.ts)
  WECHAT_STATS_CRON_HOUR: z.coerce.number().min(0).max(23).default(9), // 每日几点(BJ)拉"昨日"getarticlesummary (T+1)

  // 模型直映射（T2）— TaskType → 具体模型名
  DEEPSEEK_MODEL_CHAT: z.string().default("deepseek-chat"),
  DEEPSEEK_MODEL_REASONER: z.string().default("deepseek-reasoner"),
  QWEN_MODEL_PLUS: z.string().default("qwen-plus"),
  QWEN_MODEL_MAX: z.string().default("qwen-max"),

  // 知识库
  LANCEDB_PATH: z.string().default("./data/lancedb"),

  // 文件
  UPLOAD_DIR: z.string().default("./data/uploads"),
  MAX_FILE_SIZE: z.string().default("50mb"),

  // Springer Nature API
  SPRINGER_API_KEY: z.string().optional(),
  SPRINGER_PROXY: z.string().optional(), // 代理地址（如 http://127.0.0.1:7890）

  // DVH 数字人字幕 + 语速 (PR-E 配置化: 改 .env 重启 pm2 即可生效, 不用改码部署; 仅影响新生成视频)
  DVH_SPEECH_RATE: z.coerce.number().default(50),                       // 阿里云 -500~500, 0=1.0x, 50≈1.1x
  DVH_SUBTITLE_FONT_NAME: z.string().default("Noto Sans CJK SC"),       // 中文字体
  // 7-02 重校准: 字号在 288 坐标系 → 实际像素 = 值/288×视频高。36 在 1080×1920 上=240px/字(4.5字占满屏宽,
  //   老韩截图实锤溢出), 15≈100px≈抖音正常字幕(11字/行)。调之前先算像素账, 别再肉眼盲调。
  DVH_SUBTITLE_FONT_SIZE: z.coerce.number().default(15),
  DVH_SUBTITLE_PRIMARY_COLOUR: z.string().default("&H00FFFFFF&"),       // 字色 ASS &HAABBGGRR& (白)
  DVH_SUBTITLE_OUTLINE_COLOUR: z.string().default("&H00000000&"),       // 描边色 (黑)
  DVH_SUBTITLE_OUTLINE: z.coerce.number().default(2),                   // 描边宽度
  DVH_SUBTITLE_ALIGNMENT: z.coerce.number().default(2),                 // 1-9 九宫格, 2=居中下方, 8=居中上方
  DVH_SUBTITLE_MARGIN_V: z.coerce.number().default(84),                // 7-02: 200/288=距底69%(快到画面中间)→84≈29%, 避抖音底部UI又不压人脸
  DVH_SUBTITLE_BOLD: z.coerce.number().default(1),                      // 0/1 粗体
  // 7-02 混剪提质②: 字幕关键词强调 — SRT→ASS 内联标签(数字/分区/硬词黄色加粗放大 1.35 倍)。
  //   默认开; 出问题设 false 一键回老 subtitles+force_style 路径(仅影响新生成视频)。
  DVH_SUBTITLE_EMPHASIS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  DVH_SUBTITLE_EMPHASIS_MAX: z.coerce.number().default(2),              // 7-02: 每条字幕最多强调几处(按信息量权重挑, 防满屏黄字); 0=不限
  DVH_FFMPEG_TIMEOUT_MS: z.coerce.number().default(300000),             // PR-F: ffmpeg 后处理超时(5min), 超时 kill
  DVH_DOWNLOAD_TIMEOUT_MS: z.coerce.number().default(60000),            // PR-F: 下载 mp4/srt 超时(1min)
  DVH_DOWNLOAD_MAX_MB: z.coerce.number().default(600),                  // PR-F: 下载大小上限(MB)

  // 文章排版库 (PR-G)
  ARTICLE_TEMPLATE_ROTATION: z.string().default("true"),                // 主版本模板轮换: true=4模板随机, false=固定默认 shunshi

  // P0四件套（7-03 公众号图文质量）—— 每个 pass 都可独立开关, LLM 失败一律用原文兜底不阻塞
  ARTICLE_CONDENSE: z.string().default("true"),                         // ④压缩去水分: false=跳过
  ARTICLE_CONDENSE_RATIO: z.coerce.number().default(0.72),              // ④目标压缩比(压到原文的72%)
  ARTICLE_DECLICHE: z.string().default("true"),                         // ③AI腔检测+段落级清洗: false=跳过
  ARTICLE_SIXDIM_QC: z.string().default("true"),                        // ①老韩六维质检+定向重写闭环: false=跳过
  ARTICLE_QUALITY_REWRITE_MAX: z.coerce.number().default(2),            // ①质检未过时定向重写最多几轮(0=不重写只打分)
  ARTICLE_HOOK_INJECT: z.string().default("true"),                      // ②生成prompt注入钩子模式库: false=不注入

  // CORS
  // PR #108（5-9 hotfix 永久）：default 含 boss-mates.com 防新部署忘加 .env 导致跨域白屏。
  // 5-9 prod 事故 root cause：.env 缺 ALLOWED_ORIGINS → fallback 仅 localhost → 浏览器 CORS reject。
  ALLOWED_ORIGINS: z.string().default(
    "https://boss-mates.com,https://api.boss-mates.com,http://localhost:5173,http://localhost:3000",
  ),

  // 日志
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  LOG_DIR: z.string().default("./logs"),

  // === V3 新增 ===

  // CEO Agent 开关（false=走旧 Orchestrator，true=走新 CEO Agent + EventBus）
  USE_CEO_AGENT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // 对象存储 (OSS)
  OSS_ENDPOINT: z.string().optional(),
  OSS_BUCKET: z.string().optional(),
  OSS_ACCESS_KEY: z.string().optional(),
  OSS_SECRET_KEY: z.string().optional(),

  // TTS 配音
  //   siliconflow = SiliconFlow 托管 CosyVoice2; dashscope = 阿里云百炼 qwen-tts(复用 QWEN_API_KEY, 同一账号好核算成本)。6-22 接入。
  TTS_PROVIDER: z.enum(["aliyun", "azure", "siliconflow", "dashscope"]).default("aliyun"),
  TTS_API_KEY: z.string().optional(),
  // SiliconFlow CosyVoice2(OpenAI 兼容 /audio/speech)
  SILICONFLOW_API_KEY: z.string().optional(),
  SILICONFLOW_BASE_URL: z.string().default("https://api.siliconflow.cn/v1"),
  TTS_SILICONFLOW_MODEL: z.string().default("FunAudioLLM/CosyVoice2-0.5B"),
  // 音色: alex/benjamin/charles/david(男) anna/bella/claire/diana(女), 均多语种含中文。默认 diana(女声)。
  TTS_SILICONFLOW_VOICE: z.string().default("FunAudioLLM/CosyVoice2-0.5B:diana"),
  TTS_SILICONFLOW_SPEED: z.coerce.number().default(1),
  // 阿里云百炼 qwen-tts(自然中文): 复用 QWEN_API_KEY, 一套阿里云账号统一计费/核算成本。
  //   音色: Cherry(女,活泼)/Serena(女,沉稳)/Ethan(男)/Chelsie 等; 模型 qwen-tts / qwen-tts-latest。
  TTS_DASHSCOPE_MODEL: z.string().default("qwen-tts"),
  TTS_DASHSCOPE_VOICE: z.string().default("Cherry"),
  // 6-22 语速: 合成后用 ffmpeg atempo 提速(保音调), 通用于所有 provider。1=原速; 科普建议 1.15~1.25。
  TTS_SPEED: z.coerce.number().default(1.15),
  /**
   * 阿里云 NLS 音色 ID。default 'siqi'（亲和女声，自然不机械）。
   * 历史 default 是 'xiaoyun'（早期童音，机械感重）。
   * 推荐: siqi（商业默认）/ ruoxi（清脆）/ zhibei_emo（情感男声）/ aiyue（教学男声）。
   */
  TTS_VOICE_ID: z.string().default("siqi"),
  // 阿里云 NLS 凭证（AccessKey 动态换 Token）
  ALIYUN_AK_ID: z.string().optional(),
  ALIYUN_AK_SECRET: z.string().optional(),
  ALIYUN_NLS_APPKEY: z.string().optional(),
  // 阿里云访问密钥别名: DVH 用 ACCESS_KEY 命名、TTS 历史用 AK 命名 — 等价, 代码已跨兜底, 配任一对即可。
  ALIYUN_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_ACCESS_KEY_SECRET: z.string().optional(),
  // DVH 数字人 / Azure / 种子脚本: 运行时直读 process.env, 此处注册供 fail-fast 校验 + 文档。
  DVH_TENANT_ID: z.string().optional(),
  DVH_APP_ID: z.string().optional(),
  DVH_REAL_MODE: z.string().optional(),
  DVH_DEFAULT_BG_URL: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().optional(),
  HANXIAO_TENANT_ID: z.string().optional(),

  // 视频
  VIDEO_RESOLUTION: z.string().default("1080x1920"),
  /**
   * BGM 默认路径。生产部署推荐写绝对路径
   *   `/home/projects/bossmate/data/bgm/default.mp3`
   * 因为 pm2 cwd = packages/server，相对路径基于 cwd 解析会找错位置。
   * composer.ts:resolveBgmPath 已加 fallback 链，即使本字段失败也会兜底。
   */
  BGM_DEFAULT_PATH: z.string().default("data/bgm/default.mp3"),
  // 6-22 BGM 曲库目录: 放多个 .mp3, 每条视频随机选一首(增加变化/不同账号不同感觉)。空则回退单文件。
  BGM_DIR: z.string().default("data/bgm"),

  // 素材图库
  PEXELS_API_KEY: z.string().optional(),

  // 企业微信
  WECHAT_WORK_CORP_ID: z.string().optional(),
  WECHAT_WORK_SECRET: z.string().optional(),
  WECHAT_WORK_TOKEN: z.string().optional(),
  WECHAT_WORK_AES_KEY: z.string().optional(),
  // 企微微信客服「接待链接」(kf/add_contact_way 生成或客服控制台取)，用于公众号欢迎语/被动回复给客户真人客服入口。留空则文案里不含客服链接。
  WECOM_KF_URL: z.string().optional(),
  // 企微客服接待链接的二维码 PNG(OSS URL, scripts/upload-kf-qr.mjs 生成上传)，混剪片尾 outro 叠加。留空则片尾不叠二维码。
  WECOM_KF_QR_URL: z.string().optional(),
  // B-kf 自助化: FAQ 批量导入单次上限（防误粘超大文本）
  KF_FAQ_IMPORT_MAX: z.coerce.number().int().min(1).default(200),
  // B-kf 自助化:「从历史对话生成建议」单次扫描会话数上限（成本护栏，每次一趟 LLM）
  KF_SUGGEST_MAX_CONVERSATIONS: z.coerce.number().int().min(1).default(30),

  // 期刊检索小程序：wx.login + getPhoneNumber 登录所需（小程序后台「开发管理-开发设置」）
  WECHAT_MINI_APPID: z.string().optional(),
  WECHAT_MINI_SECRET: z.string().optional(),

  // B.1: 公众号入站 webhook 校验 token（公众号管理后台「开发-基本配置」 token）
  DVH_MOCK_FIXTURE_BASE: z.string().default(""),                     // 7-13 收尾: DVH兜底样片base URL(空=用OSS占位桶); 生产应开 DVH_REAL_MODE 极少走兜底
  WECHAT_VERIFY_TOKEN: z.string().default("ai_butler_token_2026"), // 7-13: 保留默认防启动崩, 但生产 .env 必须覆盖真值(见下方 assertProd 校验)

  // 抖音开放平台官方 OAuth 代发（6-10 双轨 A 轨, scope video.create.bind）
  // 全局应用凭证（一个 BossMate 企业应用服务所有租户）; 账号级 credentials.clientKey/clientSecret 可覆盖
  DOUYIN_CLIENT_KEY: z.string().optional(),
  DOUYIN_CLIENT_SECRET: z.string().optional(),
  // OAuth 回调地址, 须与开放平台控制台配置一致, 如 https://<domain>/api/v1/douyin/oauth/callback
  DOUYIN_OAUTH_REDIRECT_URL: z.string().optional(),
  // create_video 默认可见范围: 0=公开 1=自见(草稿模式, 人工App里改公开) 2=好友可见
  DOUYIN_PRIVATE_STATUS: z.coerce.number().int().min(0).max(2).default(1),

  // 质量检查
  QUALITY_MIN_SCORE: z.coerce.number().default(70),

  // 视频合成
  VIDEO_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  VIDEO_MAX_IMAGES: z.coerce.number().int().default(15),
  VIDEO_MAX_DURATION_SEC: z.coerce.number().int().default(120),
  VIDEO_TENANT_MAX_CONCURRENT: z.coerce.number().int().default(2),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  VIDEO_FONT_PATH: z.string().optional(),

  // 销售自动跟进
  SALES_AUTO_FOLLOWUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // AI 销售对话模块总开关（腾讯云上线时先关闭）
  SALES_AGENT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // PR Q.7 B 方案：V3 batch agent 总开关（5-7 user 拍板默认关闭）
  // orchestrator + knowledge-engine + content-director 三个定时调度依此判断是否触发
  V3_BATCH_AGENT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // 7-20 合规红线：知网(CNKI)抓取总开关，**默认 false（关闭）**。
  //   背景：journal-content-collector 在国内刊分支上会调 scrapeCnkiJournal 打 navi.cnki.net，
  //   但库里零知网数据痕迹（field_provenance/metadata/source_url/data_source 全 0），
  //   且失败只打 logger.debug（线上 LOG_LEVEL=info 看不见）→ 静默发请求、拿不到数据。
  //   老韩 7-20 拍板：知网是合规红线，立即熔断。生产 .env 不配置此项 = 永久关闭。
  //   ⚠️ 不要为了补数据打开它。万方(wanfangdata)不受此开关影响，是允许的源。
  CNKI_SCRAPE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // OpenAlex polite-pool email（B.2.1.B.2）。配置后请求带 ?mailto=<email>
  // 享受 10K req/day 免费 quota；不配置走 anonymous pool（更低额度）。
  OPENALEX_MAILTO: z.string().email().optional(),

  // 7-14 P1 图片内容审核 (services/compliance/image-moderation.ts) — 阿里云内容安全 ImageModeration(baselineCheck)
  //   复用 ALIYUN_ACCESS_KEY_ID/SECRET 凭证; 走 openapi-client 通用调用, 不新增 green 专用 SDK。
  IMAGE_MODERATION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // 失败兜底策略: false(默认)=审核挂了放行(不因审核抖动发不出内容); true=审核挂了拦截(合规要求高时开)
  IMAGE_MODERATION_STRICT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // 内容安全区域 endpoint (green20220302): cn-shanghai / cn-beijing / cn-hangzhou
  IMAGE_MODERATION_ENDPOINT: z.string().default("green-cloud.cn-shanghai.aliyuncs.com"),
  // Confidence(0-100) 阈值: ≥block→拦截, ≥review→警告放行, 否则放行
  IMAGE_MODERATION_BLOCK_SCORE: z.coerce.number().default(90),
  IMAGE_MODERATION_REVIEW_SCORE: z.coerce.number().default(60),
  IMAGE_MODERATION_CONCURRENCY: z.coerce.number().int().min(1).default(10), // 批量审核并发上限
  IMAGE_MODERATION_MAX_IMAGES: z.coerce.number().int().min(1).default(20),  // 单条内容最多审核几张(封面+正文内嵌)
  IMAGE_MODERATION_TIMEOUT_MS: z.coerce.number().int().default(8000),       // 单图审核读/连超时

  // ============ 7-25 运维告警三件套 (services/ops/*) ============
  // 每日运营简报: 每天固定时间汇总"过去 24h 的异常 + 要人动手的事", 企微推给运营。
  //   正常也发(不发就分不清"没事"还是"简报本身挂了"); 推送失败会降级落库 + 今日驾驶舱展示。
  OPS_BRIEFING_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  OPS_BRIEFING_PUSH_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"), // 只落库不推企微时设 false
  OPS_BRIEFING_CRON_HOUR: z.coerce.number().int().min(0).max(23).default(9),    // 每日几点(BJ)发简报
  OPS_BRIEFING_CRON_MINUTE: z.coerce.number().int().min(0).max(59).default(30), // 默认 09:30 — 生成(03:00)/分发(07:00)/草稿(08:00)/数据回流(09:10) 都跑完之后
  // 阈值: 今日生成低于该篇数 → 黄色; 等于 0 → 红色
  OPS_MIN_DAILY_CONTENT: z.coerce.number().int().min(0).default(5),
  // 预算使用率超该百分比 → 黄色; ≥100% → 红色(预算闸已在拒绝花钱动作)
  OPS_BUDGET_WARN_PCT: z.coerce.number().int().min(1).max(100).default(80),
  // AI 客服今日转人工达到该次数 → 黄色(提醒补 FAQ)
  OPS_HANDOFF_WARN_COUNT: z.coerce.number().int().min(1).default(5),

  // 供应商余额监控 — 阿里云 BSS OpenAPI QueryAccountBalance。
  //   ⚠️ 默认关闭: 需 AK 具备 bss:QueryAccountBalance(AliyunBSSReadOnlyAccess), 子账号还须主账号授"财务权限"。
  //   查不到也不影响简报 — 自动退回"消耗速率异常检测"(纯自有 cost_ledger 数据, 不依赖任何外部 API)。
  OPS_ALIYUN_BALANCE_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  OPS_ALIYUN_BSS_ENDPOINT: z.string().default("business.aliyuncs.com"),
  OPS_BALANCE_WARN_YUAN: z.coerce.number().min(0).default(200),  // 余额低于此 → 黄色
  OPS_BALANCE_ALERT_YUAN: z.coerce.number().min(0).default(50),  // 余额低于此 → 红色
  // 消耗骤降判定: 今日消耗 / 近7日日均 < 该比例 → 黄色; 今日 = 0 → 红色(疑似欠费/额度耗尽)
  OPS_SPEND_DROP_RATIO: z.coerce.number().min(0).max(1).default(0.2),
  // 近7日日均消耗低于此(分)不做骤停判定 — 本来就不怎么花钱, 一天没花很正常, 别误报
  OPS_SPEND_MIN_AVG_CENTS: z.coerce.number().int().min(0).default(100),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ 环境变量校验失败:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const data = result.data;

  // JWT_SECRET 强度校验
  if (data.NODE_ENV === "production") {
    if (data.JWT_SECRET.length < 32) {
      console.error(
        "❌ 生产环境 JWT_SECRET 必须至少 32 位，当前长度: " + data.JWT_SECRET.length
      );
      process.exit(1);
    }
  } else if (data.JWT_SECRET.length < 32) {
    console.warn(
      "⚠️ 开发环境: JWT_SECRET 建议至少 32 位，当前长度: " + data.JWT_SECRET.length
    );
  }

  // 7-13 收尾: 生产环境微信回调校验 token 不得用仓库硬编码默认值(否则任何读到源码的人都能伪造公众号回调签名)
  if (data.NODE_ENV === "production" && data.WECHAT_VERIFY_TOKEN === "ai_butler_token_2026") {
    console.error("❌ 生产环境 WECHAT_VERIFY_TOKEN 仍是仓库默认值，必须在 .env 覆盖为随机值");
    process.exit(1);
  }

  // 检查是否至少有一个可用的 Embedding API Key
  const hasEmbeddingKey =
    (data.QWEN_API_KEY && data.QWEN_API_KEY !== "your-qwen-api-key") ||
    (data.DEEPSEEK_API_KEY && data.DEEPSEEK_API_KEY !== "your-deepseek-api-key");

  if (!hasEmbeddingKey) {
    if (data.NODE_ENV === "production") {
      console.error(
        "❌ 生产环境必须配置至少一个 Embedding API Key (QWEN_API_KEY / DEEPSEEK_API_KEY)"
      );
      process.exit(1);
    } else {
      console.warn(
        "⚠️ 未配置 Embedding API Key，知识库功能将使用本地 hash 向量（仅开发环境）"
      );
    }
  }

  // 检查关键凭证变量的有效性
  if (data.NODE_ENV === "production") {
    if (!data.DATABASE_URL || data.DATABASE_URL === "postgresql://localhost") {
      console.error("❌ 生产环境必须配置有效的 DATABASE_URL");
      process.exit(1);
    }
  }

  return data;
}

export const env = loadEnv();
