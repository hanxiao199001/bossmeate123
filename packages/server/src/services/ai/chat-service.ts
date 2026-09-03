/**
 * AI 对话服务
 *
 * 负责：
 * 1. 接收用户消息
 * 2. 通过模型路由器选择合适模型
 * 3. 调用模型 API 获取回复（支持 DeepSeek / OpenAI 兼容接口）
 * 4. 记录 Token 使用
 *
 * ## 🔴 别关 deepseek-v4-pro 的推理预算（8-14 实测记录）
 *
 * **推理预算与正文丰富度正相关，不是纯开销。** 10 刊同刊 A/B 实测：
 *
 * ```
 * 推理开   均 tok 1746(推理 609)   均字数 889   章节 1.8/4   口播 10/10
 * 推理关   均 tok  831(推理   0)   均字数 585   章节 1.9/4   口播 10/10
 * ```
 *
 * 字数 **-34%**，直接跌出 800-1200 目标区间；章节/口播/健康问题/JSON 成功率全部持平。
 * 换句话说：关掉它是拿三分之一的正文长度去换 900 token。
 *
 * 会有人（包括我）再想关一次 —— 动机很充分：百炼的 `reasoning_tokens` **算在
 * completion_tokens 里**，与正文共用 `maxTokens` 预算，日志里 3 条
 * `outputTokens=6001 / rawLength=0` 就是预算被推理吃光、正文一个字都没轮上。
 * 但"烧了钱"不等于"没用"。**想省它之前，先跑
 * `scripts/compare-thinking.ts` 复现这组数字。**
 *
 * 开关本身留着（`env.LLM_DISABLE_THINKING`，默认 false）—— 留的是复现实验的能力，
 * 不是留一个"随时可以打开省钱"的口子。
 *
 * **8-15 追加：`reasoning_effort=low` 也试过了，同样不采用。**
 * 18 次同刊 A/B（含日志里真撞过顶的 2 本各 5 次）：实验组在字数、章节、
 * 健康问题上都**略好或持平**，但推理量峰值只从 3599 压到 3115 ——
 * **这个参数对长尾几乎没有约束力**，而"压住撞顶"正是做它的唯一动机。
 * 现状臂 10 次一次都没复现撞顶（生产频率 0.17%），判据③ 无法裁决。
 * 结论：不改参数。撞顶已由 `empty_output` 守卫兜住（→ deferred → 自动重跑），
 * 代价是 0.17% 的文章多一次调用，没有废稿流到下游。降级为观察项。
 *
 * 附带纪律：实验组在字数(+24)、章节(1.5→1.8)、健康问题(1→0)上**看着更好**，
 * 但 n=18 的小样本改善 + 预注册判据判「不过」——**不采纳**。
 * 事后把好看的维度捡回来，与事后改判据同罪。将来若要为省那 19% 推理成本
 * 采纳 low，另立实验、用修正后的判据写法（见 CLAUDE.md 红线 #18）。

 */

import { modelRouter, type TaskType } from "./model-router.js";
import { logger } from "../../config/logger.js";
import { env } from "../../config/env.js";
import { withRetry } from "../../utils/retry.js";
import { createTimeoutController } from "../../utils/timeout.js";
import { recordLlmUsage } from "../billing/llm-cost.js";
import { AI_FALLBACK_NO_MODEL, AI_FALLBACK_UNAVAILABLE } from "./fallback-messages.js";

/**
 * 7-27: AI 调用失败 → 落 ops_incidents(旁路, 绝不影响原有返回/抛错行为)。
 *
 * 为什么必须记: 7-27 线上 49 次 `This operation was aborted`(60s 超时掐断), ops_incidents
 *   一条都没有 —— 而这批超时正是"20/25 条内容评分为 0、零进草稿箱"的根因。日志里有, 但日志
 *   没人天天看; 昨天刚建的告警体系恰好漏了这一类。
 *
 * 节流: 一次故障会连锁触发几十次(每篇内容都撞), 走 recordIncidentThrottled(10 分钟一条,
 *   被压掉的次数带在 detail.suppressedSinceLastAlert), 免得把别的告警淹了。
 */
function reportAiCallFailure(err: unknown, ctx: { provider: string; model: string; taskType: string; tenantId?: string | null }): void {
  void (async () => {
    try {
      const { isTimeoutLikeError, recordIncidentThrottled } = await import("../ops/incidents.js");
      const { isQuotaLikeError } = await import("../ops/failure-kind.js");
      const msg = err instanceof Error ? err.message : String(err);

      /**
       * 🔴 8-17：欠费必须落 incident，否则整条线停摆没人知道要去充值。
       *
       * 原来这里是 `if (!isTimeoutLikeError(err)) return`，注释写着"额度类由
       * openai-compatible 的 llm_quota 覆盖" —— **但生产链路根本不走那个文件**，
       * 它走本文件的 executeAICall 直连 fetch。于是额度类在两边都没人记：
       * 那边覆盖不到，这边直接 return。
       *
       * 实况：百炼欠费从 7-23 起断续发作 6 次（7-23/7-24/7-30/7-31/8-02~8-06/8-16~8-17），
       * 8-16 单日 154 次 400 Arrearage，`ops_incidents` **零条**，简报一个字没提。
       */
      if (isQuotaLikeError(0, msg)) {
        await recordIncidentThrottled({
          kind: "llm_quota",
          severity: "error",
          // 红线 #13：只写事实 + 可执行动作，不猜"大概是谁忘了充"
          message: `LLM 账户额度不可用: ${ctx.provider}/${ctx.model} — 调用被拒。需去阿里云百炼充值后自动恢复。原文: ${msg.slice(0, 160)}`,
          tenantId: ctx.tenantId ?? null,
          detail: { provider: ctx.provider, model: ctx.model, taskType: ctx.taskType, raw: msg.slice(0, 400) },
        }, { key: `llm_quota:${ctx.provider}:${ctx.model}` });
        return;
      }

      if (!isTimeoutLikeError(err)) return; // 其余非超时类不记(噪声太大)
      await recordIncidentThrottled({
        kind: "llm_timeout",
        severity: "warn",
        message: `AI 调用超时/中断: ${ctx.provider}/${ctx.model} (${ctx.taskType}) — ${msg.slice(0, 160)}`,
        tenantId: ctx.tenantId ?? null,
        detail: { provider: ctx.provider, model: ctx.model, taskType: ctx.taskType },
      }, { key: `llm_timeout:${ctx.provider}:${ctx.model}` });
    } catch {
      /* 告警旁路失败不影响主流程 */
    }
  })();
}

/**
 * 7-28 ②b: AI 主备全挂 —— 供**生产链路**捕获的显式失败。
 *
 * 为什么要有它: chat() 历史行为是主备全挂时**不抛错**, 返回一句中文兜底文案当 content。
 *   对聊天场景这是友好提示; 对生成/质检链路却是"把故障伪装成正常输出" ——
 *   7-27 事故的原型正是 title-generator 把这句兜底文案当成了候选标题, 一篇标题=占位文的
 *   文章拿着六维 80 分溜进公众号草稿箱。28 个 chat() 调用点里当时只有 3 个检查这个文案。
 *
 * 改造策略(**折中, 不全量抛异常**, 理由见 chat() 的 throwOnExhausted 注释):
 *   - 默认行为**零变化**(仍返回兜底文案) → 28 个调用点无一被动受影响;
 *   - 新增 `throwOnExhausted: true` 逐点开启, 已开启的是"内容会落库/会对外"的生产链路;
 *   - 另外新增结构化字段 `ChatResponse.ok` —— 不想改控制流的调用点可以只读它, 不必再抄字符串判据。
 */
export class AiUnavailableError extends Error {
  /** 触发时选中的 provider/model(可能为 "none": 路由表空/全熔断) */
  readonly provider: string;
  readonly model: string;
  /** no_model = 压根没选出模型; exhausted = 主备都调用失败 */
  readonly kind: "no_model" | "exhausted";
  /**
   * 🔴 最后一次底层错误的原文。**必须带上，否则失败分类会把欠费判成"服务挂了"。**
   *
   * 8-17 实测：原始 `API 400 ... "type":"Arrearage"` → classifyFailure = quota_exceeded ✓；
   * 一旦被本类包住而不带原文 → service_down ✗。
   * 而 failure-kind 的文件头早就写着这句预言：「欠费时下游表现常常是'超时'或'主备全挂'，
   * 若先判 service_down，探测会一直探到服务'不通'却永远说不出'是因为没钱'」——
   * 包装丢掉原文，就是亲手制造它预言的那个情形。
   */
  readonly lastError: string;
  constructor(kind: "no_model" | "exhausted", provider: string, model: string, lastError?: unknown) {
    const tail = lastError === undefined ? "" : ` | 底层: ${lastError instanceof Error ? lastError.message : String(lastError)}`.slice(0, 300);
    super((kind === "no_model"
      ? `AI 不可用: 无可用模型(路由表空或全部熔断) [${provider}/${model}]`
      : `AI 不可用: 主备模型全部调用失败 [${provider}/${model}]`) + tail);
    this.lastError = tail;
    this.name = "AiUnavailableError";
    this.kind = kind;
    this.provider = provider;
    this.model = model;
  }
}

/** 判定一个异常是不是"AI 主备全挂"(跨 vitest 模块实例也成立, 不靠 instanceof) */
export function isAiUnavailableError(err: unknown): boolean {
  return err instanceof AiUnavailableError || (err instanceof Error && err.name === "AiUnavailableError");
}

export interface ChatRequest {
  tenantId: string;
  userId: string;
  conversationId: string;
  message: string;
  skillType?: string;
  context?: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  /** 7-06 生成参数透传(RoutedProvider/skills 链路用): 不传保持原默认(temperature 0.7 / 路由表 maxTokens) */
  temperature?: number;
  maxTokens?: number;
  /**
   * 7-28 ②b: 主备全挂时**抛 AiUnavailableError**, 而不是返回中文兜底文案当 content。
   *
   * 默认 false = 老行为(返回兜底文案)。**刻意不全量改成抛异常**:
   *   - 客服/工坊对话(kf-responder / routes/chat / routes/work-wechat-kf)是实时链路,
   *     用户在对面等着 —— 那里要的就是"一句人话兜底", 抛异常只会变成 500 白屏/无回复,
   *     体验更差且这些链路的产物不会落进 contents 表对外发布;
   *   - 28 个调用点里大多数是"分析/富化/打标"类旁路(data-collection / journal-enricher /
   *     style-learning 等), 它们本就各有 JSON 解析失败的兜底路径, 强行抛异常等于把
   *     "旁路降级"升级成"主流程报错", 与本次目标(堵 fail-open)方向相反。
   *   - 真正危险的是**产物会落库、会对外**的链路(六维质检/红线校验/标题生成/正文生成):
   *     那里"返回一句道歉文案"会被当成合法产物一路放行。这些点逐个开 true。
   */
  throwOnExhausted?: boolean;
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * 9-03: 命中输入缓存的 token 数，**已含在 inputTokens 内**。
   * 缓存单价是未命中的 1/12（¥1 vs ¥12 每 1M），不区分会把成本高估。
   * provider 未返回时为 undefined —— 记账侧按 0 处理（全部按未命中计价，不给静默折扣）。
   */
  cachedInputTokens?: number;
  /**
   * 7-28 ②b: 这次调用**是否真的拿到了模型输出**。
   *   false = content 是系统兜底文案(主备全挂/无可用模型), 不是模型说的话。
   * 不想改控制流的调用点可以只读它做判断, 不必再各自抄一份兜底文案字符串
   * (检查器与被检查方各写一套判据 = fallback-messages.ts 注释里那种经典失效)。
   * 老调用点不读它 → 行为与改造前完全一致。
   */
  ok?: boolean;
  /**
   * 8-13 新增：模型侧真实结束原因。`"max_tokens"` = 被截断。
   * `ok===false`（主备全挂、content 是兜底文案）时恒为 `"error"` —— 兜底文案不是模型输出，
   * 绝不能报成 `"stop"` 冒充正常结束。
   */
  finishReason?: "stop" | "max_tokens" | "error";
}

// OpenAI 兼容接口的响应格式（DeepSeek / Qwen / OpenAI 均使用此格式）
interface OpenAICompatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    // 9-03: 缓存命中量。百炼与 DeepSeek 两种字段名都见过, 都认。
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
}

/**
 * skillType → TaskType 映射表
 *
 * 清单来自 `grep -rn "skillType:" packages/server/src --include="*.ts"`，
 * 覆盖所有当前代码实际传入的字符串值。未命中时走兜底（长文本→content_generation，否则→daily_chat）。
 */
const SKILL_TO_TASK_TYPE: Record<string, TaskType> = {
  // 内容生成类
  article: "content_generation",
  video: "content_generation",
  content_generation: "content_generation",
  // 知识检索类
  knowledge_extract: "knowledge_search",
  knowledge_search: "knowledge_search",
  // 质检类
  style_analysis: "quality_check",
  quality_check: "quality_check",
  // 7-27 质检降级槽: 主评分模型(推理型 v4-pro)超时/挂了时改走这个 skillType → 路由到快模型
  quality_check_fast: "quality_check_fast",
  // 其他
  customer_service: "customer_service",
  formatting: "formatting",
  requirement_analysis: "requirement_analysis",
  daily_chat: "daily_chat",
  translation: "translation",
};

/**
 * 根据 skillType 推断任务类型
 */
export function inferTaskType(skillType?: string, message?: string): TaskType {
  let inferredType: TaskType;
  if (skillType && SKILL_TO_TASK_TYPE[skillType]) {
    inferredType = SKILL_TO_TASK_TYPE[skillType];
  } else if (message && message.length > 200) {
    inferredType = "content_generation";
  } else {
    inferredType = "daily_chat";
  }
  logger.debug({ skillType, inferredType }, "TaskType 推断");
  return inferredType;
}

/**
 * 调用 OpenAI 兼容 API（DeepSeek / Qwen / OpenAI）
 *
 * 支持：
 * - 可配置的请求超时（通过 AbortController）
 * - 指数退避重试（仅对速率限制和 5xx 错误）
 */
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  timeoutMs: number = env.AI_REQUEST_TIMEOUT_MS,
  temperature: number = 0.7
): Promise<{ content: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number; finishReason: "stop" | "max_tokens" | "error" }> {
  return withRetry(async () => {
    const { controller, cleanup } = createTimeoutController({
      timeoutMs,
      description: `OpenAI compatible API call to ${model}`,
    });

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          /**
           * 8-14 思维链开关。**默认不变（不传 = 保持推理开启）** ——
           * 关掉是个待验证的假设，不是既定结论，验证前不许偷偷改行为。
           *
           * 为什么需要它：百炼实测 `reasoning_tokens` **算在 completion_tokens 里**
           * （探针：默认 completion 40 / reasoning 29；关掉后 completion 9，
           * 可见输出一字不差）。所以 maxTokens 是推理与正文**共用**的预算，
           * 日志里那 3 条 `outputTokens=6001 / rawLength=0` 就是预算被推理吃光、
           * 正文一个字都没轮上。
           *
           * 开关只在 `LLM_DISABLE_THINKING=true` 时才发这个参数 ——
           * 关掉后必须先跑 10 篇对比（质量分 / 违规数 / 完整性）确认无劣化，
           * 才谈得上全量。提 maxTokens 是最后选项：抬成本且只挪悬崖不除悬崖。
           */
          ...(env.LLM_DISABLE_THINKING ? { enable_thinking: false } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `API ${response.status}: ${errorBody.slice(0, 200)}`
        );
      }

      const data = (await response.json()) as OpenAICompatResponse;

      const content = data.choices?.[0]?.message?.content || "";
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      // 9-03: 缓存命中的 token 单价是未命中的 1/12(¥1 vs ¥12 每 1M), 不区分就会把成本高估。
      const cachedInputTokens =
        Number(data.usage?.prompt_tokens_details?.cached_tokens ?? data.usage?.prompt_cache_hit_tokens ?? 0) || 0;
      /**
       * 🔴 8-13 补取 finish_reason。此前整条 skills 链路根本没有这个信号 ——
       * `routed-provider` 硬编码 "stop", 于是日志里的 finishReason 恒为 "stop",
       * 「真的正常结束」与「被截断」完全无法区分。
       * 8-11~8-13 三条兜底标题样本据此被判"截断不成立", 而其中一条
       * outputTokens=6001 恰好 = maxTokens 6000+1。坏信号吐合理值, 比没信号更难发现。
       */
      const rawFinish = String(data.choices?.[0]?.finish_reason ?? "");
      const finishReason: "stop" | "max_tokens" | "error" =
        rawFinish === "length" ? "max_tokens" : rawFinish === "stop" ? "stop" : rawFinish ? "error" : "stop";

      return { content, inputTokens, outputTokens, cachedInputTokens, finishReason };
    } finally {
      cleanup();
    }
  });
}

/**
 * 执行 AI 调用（内部辅助函数）
 *
 * systemPrompt 参数保留以维持签名稳定；OpenAI 兼容接口通过 messages 里的 system role 消息传递
 */
async function executeAICall(
  provider: { name: string; model: string; apiKey: string; baseUrl: string; maxTokens: number },
  messages: Array<{ role: string; content: string }>,
  _systemPrompt: string | undefined,
  timeoutMs: number,
  overrides?: { temperature?: number; maxTokens?: number }
): Promise<{ content: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number; finishReason: "stop" | "max_tokens" | "error" }> {
  return await callOpenAICompatible(
    provider.baseUrl,
    provider.apiKey,
    provider.model,
    messages,
    overrides?.maxTokens ?? provider.maxTokens,
    timeoutMs,
    overrides?.temperature
  );
}

/**
 * 7-27 按任务类型差异化超时 —— "一个 AI_REQUEST_TIMEOUT_MS 管全部"是 7-27 事故的放大器。
 *
 * 事故复盘: 现役模型 deepseek-v4-pro 是**推理型**, 出答案前先跑一段思维链, 提示越长越慢。
 *   六维质检那条提示 ~3000 token, 60s 常常返回不完 → AbortController 掐断 → 当天 49 次
 *   "This operation was aborted", 20/25 条内容没评上分。而同一个默认值又管着企微客服 ——
 *   客服那边等 60s 才失败, 用户早跑了; 一刀切往上调到 120s 只会让客服体验更差。
 *   结论: 慢任务要更长, 快任务要更短, 一个数值满足不了两头。
 *
 * 四档(全部可用 env 覆盖, 不改代码就能现场调):
 *   ① quality_check(含降级槽): AI_QUALITY_CHECK_TIMEOUT_MS 默认 180s —— 长提示 + 推理型模型, 给足;
 *      反正超了也有降级重试兜着, 宁可多等也别白花一次推理钱。
 *   ② article/video 生成: AI_ARTICLE_TIMEOUT_MS 默认 120s(原样不动)。
 *   ③ customer_service / daily_chat: AI_FAST_TIMEOUT_MS 默认 45s —— 人在对面等着,
 *      走的是 qwen-plus(非推理型, 实测个位数秒), 45s 已是极宽松的上限; 早失败早走兜底话术。
 *   ④ 其余: AI_REQUEST_TIMEOUT_MS 默认 120s。
 */
export function resolveTimeoutMs(skillType: string | undefined, taskType: TaskType): number {
  if (skillType === "article" || skillType === "video") return env.AI_ARTICLE_TIMEOUT_MS;
  if (taskType === "quality_check" || taskType === "quality_check_fast") return env.AI_QUALITY_CHECK_TIMEOUT_MS;
  if (taskType === "customer_service" || taskType === "daily_chat") return env.AI_FAST_TIMEOUT_MS;
  return env.AI_REQUEST_TIMEOUT_MS;
}

/**
 * 调用 AI 模型获取回复
 *
 * 支持两种回退策略：
 * 1. serial（串行）：主模型失败后，再尝试备选模型
 * 2. race（竞速）：同时请求主备模型，用最先成功的（适合对响应速度敏感的任务）
 */
export async function chat(request: ChatRequest): Promise<ChatResponse> {
  const taskType = inferTaskType(request.skillType, request.message);

  // 确定超时时间（按任务类型差异化，见 resolveTimeoutMs 的注释）
  const timeoutMs = resolveTimeoutMs(request.skillType, taskType);

  // 构建消息列表
  const messages: Array<{ role: string; content: string }> = [];

  if (request.systemPrompt) {
    messages.push({ role: "system", content: request.systemPrompt });
  }

  // 添加历史上下文
  if (request.context) {
    messages.push(...request.context);
  }

  // 添加当前用户消息
  messages.push({ role: "user", content: request.message });

  // 根据策略选择执行方式
  const strategy = modelRouter.getFallbackStrategy();

  const response = strategy === "race"
    ? await chatWithRaceMode(request, messages, taskType, timeoutMs)
    : await chatWithSerialMode(request, messages, taskType, timeoutMs);

  // 7-06: LLM 成本落库(旁路, 不 await 不抛错) — 单出口覆盖 serial/race 全路径。
  // 此前 cost-ledger 的 "llm" 类型 0 写入, token 花费黑盒(战略评估薄弱点#2)。
  void recordLlmUsage({
    tenantId: request.tenantId,
    taskType,
    model: response.model,
    provider: response.provider,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cachedTokens: response.cachedInputTokens,
  });

  return response;
}

/**
 * 串行模式：主模型失败后再尝试备选模型
 */
async function chatWithSerialMode(
  request: ChatRequest,
  messages: Array<{ role: string; content: string }>,
  taskType: TaskType,
  timeoutMs: number
): Promise<ChatResponse> {
  const provider = modelRouter.selectModel(taskType);

  if (!provider) {
    logger.error("无可用AI模型");
    if (request.throwOnExhausted) throw new AiUnavailableError("no_model", "none", "none");
    return {
      content: AI_FALLBACK_NO_MODEL,
      model: "none",
      provider: "none",
      inputTokens: 0,
      outputTokens: 0,
      ok: false,
      // 兜底文案不是模型输出 —— 报 error, 不许冒充 stop
      finishReason: "error",
    };
  }

  logger.info(
    {
      taskType,
      provider: provider.name,
      model: provider.model,
      messageLength: request.message.length,
      contextLength: request.context?.length || 0,
      strategy: "serial",
    },
    "AI 调用开始"
  );

  /** 最后一次底层错误 —— 抛 AiUnavailableError 时必须带上（见该类 lastError 字段注释） */
  let lastCallError: unknown;

  try {
    const result = await executeAICall(provider, messages, request.systemPrompt, timeoutMs, { temperature: request.temperature, maxTokens: request.maxTokens });
    modelRouter.recordSuccess(provider.name, provider.model);

    logger.info(
      {
        provider: provider.name,
        model: provider.model,
        taskType,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        finishReason: result.finishReason,
      },
      "AI 调用成功"
    );

    return {
      content: result.content,
      model: provider.model,
      provider: provider.name,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cachedInputTokens: result.cachedInputTokens,
      finishReason: result.finishReason,
      ok: true,
    };
  } catch (err) {
    lastCallError = err;
    modelRouter.recordFailure(provider.name, provider.model);
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: errorMsg, provider: provider.name, model: provider.model },
      "AI 调用失败"
    );
    // 7-27: 超时/中断类失败落 ops_incidents(节流)。即使备选救回来了也记 —— 超时本身就是
    //   "钱花了没拿到东西 + 链路在变慢"的信号, 等到主备全挂才告警就晚了。
    reportAiCallFailure(err, { provider: provider.name, model: provider.model, taskType, tenantId: request.tenantId });

    // 尝试备选模型
    const fallback = modelRouter.selectModel(taskType);
    if (fallback && (fallback.name !== provider.name || fallback.model !== provider.model)) {
      logger.info({ fallback: fallback.name, model: fallback.model }, "尝试备选模型");
      try {
        const result = await executeAICall(fallback, messages, request.systemPrompt, timeoutMs, { temperature: request.temperature, maxTokens: request.maxTokens });
        modelRouter.recordSuccess(fallback.name, fallback.model);
        return {
          content: result.content,
          model: fallback.model,
          provider: fallback.name,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cachedInputTokens: result.cachedInputTokens,
          finishReason: result.finishReason,
          ok: true,
        };
      } catch (fallbackErr) {
        lastCallError = fallbackErr;
        modelRouter.recordFailure(fallback.name, fallback.model);
        logger.error(
          { err: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) },
          "备选模型也失败了"
        );
        reportAiCallFailure(fallbackErr, { provider: fallback.name, model: fallback.model, taskType, tenantId: request.tenantId });
      }
    }

    // 7-28 ②b: 生产链路(throwOnExhausted)要的是"知道失败了", 不是一句能被当成正文的道歉话
    if (request.throwOnExhausted) throw new AiUnavailableError("exhausted", provider.name, provider.model, lastCallError);
    return {
      content: AI_FALLBACK_UNAVAILABLE,
      model: provider.model,
      provider: provider.name,
      inputTokens: 0,
      outputTokens: 0,
      ok: false,
      // 兜底文案不是模型输出 —— 报 error, 不许冒充 stop
      finishReason: "error",
    };
  }
}

/**
 * 竞速模式：同时请求主备模型，使用最先成功的结果
 * 当两个请求都完成或超时时，取消另一个请求
 */
async function chatWithRaceMode(
  request: ChatRequest,
  messages: Array<{ role: string; content: string }>,
  taskType: TaskType,
  timeoutMs: number
): Promise<ChatResponse> {
  const modelPair = modelRouter.getModelPair(taskType);

  if (!modelPair.primary) {
    logger.error("无可用AI模型");
    if (request.throwOnExhausted) throw new AiUnavailableError("no_model", "none", "none");
    return {
      content: AI_FALLBACK_NO_MODEL,
      model: "none",
      provider: "none",
      inputTokens: 0,
      outputTokens: 0,
      ok: false,
      // 兜底文案不是模型输出 —— 报 error, 不许冒充 stop
      finishReason: "error",
    };
  }

  logger.info(
    {
      taskType,
      primary: modelPair.primary.name,
      secondary: modelPair.secondary?.name || "none",
      messageLength: request.message.length,
      contextLength: request.context?.length || 0,
      strategy: "race",
    },
    "AI 竞速调用开始"
  );

  // 如果没有备选模型，回退到串行模式
  if (!modelPair.secondary) {
    logger.info("无备选模型，回退到串行模式");
    return await chatWithSerialMode(request, messages, taskType, timeoutMs);
  }

  // 准备两个 Promise，用于竞速
  const primaryPromise = executeAICall(modelPair.primary, messages, request.systemPrompt, timeoutMs, { temperature: request.temperature, maxTokens: request.maxTokens })
    .then((result) => ({
      success: true as const,
      result,
      provider: modelPair.primary!,
    }))
    .catch((error) => ({
      success: false as const,
      error,
      provider: modelPair.primary!,
    }));

  const secondaryPromise = executeAICall(modelPair.secondary, messages, request.systemPrompt, timeoutMs, { temperature: request.temperature, maxTokens: request.maxTokens })
    .then((result) => ({
      success: true as const,
      result,
      provider: modelPair.secondary!,
    }))
    .catch((error) => ({
      success: false as const,
      error,
      provider: modelPair.secondary!,
    }));

  try {
    // 使用 Promise.race 获取最先完成的结果
    const winner = await Promise.race([primaryPromise, secondaryPromise]);

    if (winner.success) {
      modelRouter.recordSuccess(winner.provider.name, winner.provider.model);
      logger.info(
        {
          provider: winner.provider.name,
          model: winner.provider.model,
          taskType,
          inputTokens: winner.result.inputTokens,
          outputTokens: winner.result.outputTokens,
          finishReason: winner.result.finishReason,
        },
        "AI 竞速调用成功"
      );

      return {
        content: winner.result.content,
        model: winner.provider.model,
        provider: winner.provider.name,
        inputTokens: winner.result.inputTokens,
        outputTokens: winner.result.outputTokens,
        cachedInputTokens: winner.result.cachedInputTokens,
        finishReason: winner.result.finishReason,
        ok: true,
      };
    } else {
      // 竞速失败，等待另一个请求的结果
      modelRouter.recordFailure(winner.provider.name, winner.provider.model);
      logger.warn(
        {
          failed: winner.provider.name,
          model: winner.provider.model,
          error: winner.error instanceof Error ? winner.error.message : String(winner.error),
        },
        "竞速模式中一个提供商失败，等待备选"
      );
      reportAiCallFailure(winner.error, { provider: winner.provider.name, model: winner.provider.model, taskType, tenantId: request.tenantId });

      const loser = await Promise.race([primaryPromise, secondaryPromise]);
      if (loser.success) {
        modelRouter.recordSuccess(loser.provider.name, loser.provider.model);
        logger.info(
          {
            provider: loser.provider.name,
            model: loser.provider.model,
            taskType,
            inputTokens: loser.result.inputTokens,
            outputTokens: loser.result.outputTokens,
          },
          "AI 竞速调用成功（备选）"
        );

        return {
          content: loser.result.content,
          model: loser.provider.model,
          provider: loser.provider.name,
          inputTokens: loser.result.inputTokens,
          outputTokens: loser.result.outputTokens,
          cachedInputTokens: loser.result.cachedInputTokens,
          ok: true,
        };
      } else {
        modelRouter.recordFailure(loser.provider.name, loser.provider.model);
        logger.error(
          {
            failed: loser.provider.name,
            error: loser.error instanceof Error ? loser.error.message : String(loser.error),
          },
          "AI 竞速调用两个提供商都失败了"
        );
        reportAiCallFailure(loser.error, { provider: loser.provider.name, model: loser.provider.model, taskType, tenantId: request.tenantId });

        if (request.throwOnExhausted) throw new AiUnavailableError("exhausted", modelPair.primary.name, modelPair.primary.model);
        return {
          content: AI_FALLBACK_UNAVAILABLE,
          model: modelPair.primary.model,
          provider: modelPair.primary.name,
          inputTokens: 0,
          outputTokens: 0,
          ok: false,
          finishReason: "error",
        };
      }
    }
  } catch (error) {
    // 7-28: throwOnExhausted 抛出的 AiUnavailableError 会经过这里 —— 必须原样往上抛,
    //   否则又被吞成兜底文案(这个 catch 原本是给 Promise.race 自身异常兜底的)。
    if (isAiUnavailableError(error)) throw error;
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "AI 竞速调用异常"
    );

    if (request.throwOnExhausted) throw new AiUnavailableError("exhausted", modelPair.primary.name, modelPair.primary.model);
    return {
      content: AI_FALLBACK_UNAVAILABLE,
      model: modelPair.primary.model,
      provider: modelPair.primary.name,
      inputTokens: 0,
      outputTokens: 0,
      ok: false,
      // 兜底文案不是模型输出 —— 报 error, 不许冒充 stop
      finishReason: "error",
    };
  }
}
