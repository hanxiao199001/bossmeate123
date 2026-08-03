/**
 * 8-03 失败分类(整套"服务恢复自动重跑"的地基) —— 纯函数, 零 IO, 零依赖。
 *
 * 【为什么要有这个文件】
 *   8-03 阿里云百炼欠费, 报文是:
 *     HTTP 400 {"type":"Arrearage","message":"Access denied, please make sure your account
 *               is in good standing before making a request."}
 *   系统当时的反应是: 质检主备模型同时失败(它们共用同一个阿里云账户, 7-27 切
 *   DEEPSEEK_VIA=bailian 时无意造成的单点) → 9 篇内容判 needs_review 卡住, 没人知道要去充值,
 *   充完值也没人知道要去重跑。同一天老板在"文字稿直生"写了 157 字口播稿, TTS 失败硬中止,
 *   **不落库不产视频**, 稿子直接丢了。
 *
 *   这三件事的共同点: **内容一点问题没有, 是外部服务当时不可用**。
 *   把它和"内容本身有毛病"分开, 是能不能自动重跑的唯一前提 —— 所以先有分类, 才有后面的
 *   deferred 标记(deferred.ts)和恢复探测(service-health-probe.ts)。
 *
 * 【分类口径】
 *   quota_exceeded  账户级: 欠费 / 额度用尽 / 未开通  → **充值后**可原样重跑
 *   service_down    服务级: 超时 / 连接断 / 5xx / 限流 → **服务恢复后**可原样重跑
 *   content_error   内容级: JSON 解析失败 / 校验不过 / 参数不合法 → 重跑也没用, 转人工
 *
 * 【判据分层(与 withRetry 那次是同一个教训)】
 *   ① 结构化字段优先: provider 层把 HTTP status / error.type / error.code 解析成字段挂在
 *      Error 上(见 services/ai/providers/openai-compatible.ts), 这里只读字段;
 *   ② 文本关键词只做兜底: 覆盖那些拿不到字段的老调用点。
 *   **文案随时会变, 字段不会** —— 7-25 那版词表里写的是 "arrears", 而百炼实际发的是
 *   "Arrearage", 差一个词形, isQuotaLikeError 对着真实欠费报文返回 false, 白记了一个月告警。
 *
 * ⚠️ 本文件必须保持零 import: incidents.ts 会 re-export 这里的判据, 而 incidents.ts 依赖 db;
 *   若这里反向依赖 incidents.ts 就成环, 也会让纯函数单测被迫拉起数据库 mock。
 */

// ============ 结构化错误字段 ============

/**
 * provider 层解析出来的错误字段。全部可选 —— 拿不到就退回文本判据, 绝不因为缺字段而误判。
 * 挂载约定: `Object.assign(err, fields)`, 见 openai-compatible.ts 的 throw 处。
 */
export interface ProviderErrorFields {
  /** HTTP 状态码 */
  status?: number;
  /** 报文里的 error.type(百炼/DashScope 是顶层 type, OpenAI 兼容是 error.type) */
  errorType?: string;
  /** 报文里的 error.code(DashScope 有时把账户码放这) */
  errorCode?: string;
  /** 原始响应体(截断), 供文本兜底与告警展示 */
  responseBody?: string;
}

/** 解析一段 API 响应体, 抠出 type/code/message。解析不了返回空对象(绝不抛)。 */
export function parseProviderErrorBody(body: string | null | undefined): {
  type?: string;
  code?: string;
  message?: string;
} {
  const raw = (body ?? "").trim();
  if (!raw || (raw[0] !== "{" && raw[0] !== "[")) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!json || typeof json !== "object") return {};
  const top = json as Record<string, unknown>;
  // 两种形态都认:
  //   ① 百炼原生/DashScope: {"type":"Arrearage","message":"...","request_id":"..."}
  //   ② OpenAI 兼容:        {"error":{"type":"...","code":"...","message":"..."}}
  const nested = (top.error && typeof top.error === "object" ? top.error : null) as Record<string, unknown> | null;
  const pick = (k: string): string | undefined => {
    const v = nested?.[k] ?? top[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const out: { type?: string; code?: string; message?: string } = {};
  const type = pick("type");
  const code = pick("code");
  const message = pick("message");
  if (type) out.type = type;
  if (code) out.code = code;
  if (message) out.message = message;
  return out;
}

/**
 * 从任意异常里尽力抠出结构化字段 + 可供文本兜底的全文。
 * 会一路跟到 `err.cause`(Node 18+ 的错误链) —— 包装层常把真因塞在那。
 */
export function extractErrorFields(err: unknown): ProviderErrorFields & { text: string; name: string } {
  const parts: string[] = [];
  const out: ProviderErrorFields & { text: string; name: string } = { text: "", name: "" };
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (typeof cur !== "object") {
      parts.push(String(cur));
      break;
    }
    const e = cur as Record<string, unknown>;
    if (!out.name && typeof e.name === "string") out.name = e.name;
    if (typeof e.name === "string") parts.push(e.name);
    if (typeof e.message === "string") parts.push(e.message);
    if (out.status === undefined && typeof e.status === "number") out.status = e.status;
    // axios/undici 风格
    if (out.status === undefined && typeof e.statusCode === "number") out.status = e.statusCode;
    if (!out.errorType && typeof e.errorType === "string") out.errorType = e.errorType;
    if (!out.errorCode && typeof e.errorCode === "string") out.errorCode = e.errorCode;
    // Node 的系统错误码(ECONNRESET / ENOTFOUND …)也要进文本, 否则 service_down 判不出来
    if (typeof e.code === "string") {
      parts.push(e.code);
      if (!out.errorCode) out.errorCode = e.code;
    }
    if (!out.responseBody && typeof e.responseBody === "string") {
      out.responseBody = e.responseBody;
      parts.push(e.responseBody);
    }
    cur = e.cause;
  }
  out.text = parts.join(" ");

  // 结构化字段缺失时的兜底: 老调用点把状态码写死在中文文案里
  //   (`${name} API 错误: 429 - {...}`), 这是唯一能拿到 status 的地方。
  if (out.status === undefined) {
    const m = /\bapi\s*(?:错误|error)\s*[:：]?\s*(\d{3})\b/i.exec(out.text)
      ?? /\bhttp\s*(\d{3})\b/i.exec(out.text);
    if (m) out.status = Number(m[1]);
  }
  // 同理: type/code 没挂成字段, 但响应体 JSON 原样拼在 message 里(最常见的形态)
  if (!out.errorType || !out.errorCode) {
    const jsonStart = out.text.indexOf("{");
    if (jsonStart >= 0) {
      const parsed = parseProviderErrorBody(out.text.slice(jsonStart));
      if (!out.errorType && parsed.type) out.errorType = parsed.type;
      if (!out.errorCode && parsed.code) out.errorCode = parsed.code;
    }
  }
  return out;
}

// ============ 账户级(欠费/额度)判定 ============

/**
 * 明确的"账户级"错误码/类型。命中即判账户级, 与 HTTP 状态码无关 ——
 * 百炼把 Arrearage 发在 400 上, OpenAI 发在 429 上, 别的家还有发 403 的, 靠状态码分永远漏。
 */
const ACCOUNT_LEVEL_ERROR_TYPES = new Set([
  "arrearage",                      // 🔴 8-03 百炼欠费的真实 type
  "arrears",
  "insufficientbalance",
  "insufficient_balance",
  "insufficient_quota",
  "insufficient_user_quota",
  "quota_exceeded",
  "allocationquota",
  "throttling.allocationquota",
  "accessdenied.unpurchased",
  "billingnotactivated",
  "unauthorizedaccount",
  "postpaidoverduerestriction",
]);

/**
 * HTTP 400 上那些**确实是请求本身有毛病**的 type —— 只有这几个不算账户级。
 *
 * 【为什么用"反向名单"而不是正向枚举账户级关键词】
 *   正向枚举就是 7-25 那版的做法, 结果被 arrears/Arrearage 一个词形差异打穿。
 *   各家云厂商的账户级 type 名字五花八门(Arrearage / Forbidden.Arrears / AccountOverdue /
 *   PostpaidOverdueRestriction …), 穷举不完; 而"请求本身有毛病"的 type 反倒是标准化的几个。
 *   所以: **400 带 error.type、且不在下面这张表里 → 一律当账户级故障**。
 *   代价是偶尔把某个冷门的参数错误误判成账户级 —— 后果只是多跑一次探测 + 一次重跑
 *   (retryCount 上限 5 兜底), 远小于漏判欠费导致整条线静默停摆的代价。
 */
const REQUEST_LEVEL_ERROR_TYPES = new Set([
  "invalid_request_error",
  "invalidparameter",
  "invalid_parameter",
  "invalidparameter.role",
  "invalid_argument",
  "badrequest",
  "bad_request",
  "data_inspection_failed",         // 内容安全拦截 = 内容问题, 重跑没用
  "datainspectionfailed",
  "content_filter",
  "context_length_exceeded",
  "string_above_max_length",
  "model_not_found",
  "invalidapikey",                  // key 配错 = 配置问题, 不是欠费(改配置才有用)
  "invalid_api_key",
  "authentication_error",
]);

const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * 判定一次 LLM/云 API 失败是否属于"额度不足 / 欠费 / 未开通"类。
 * 这是"该充值了"的最直接信号 —— 比等消耗曲线掉到 0 早一步。
 *
 * 判据分三层, 从硬到软:
 *   ① HTTP 402(Payment Required) —— 语义即账单;
 *   ② 结构化字段: error.type / error.code 命中账户级名单;
 *      外加 **400 + 有 type 且不是请求级 type** 这条(见 REQUEST_LEVEL_ERROR_TYPES 注释);
 *   ③ 文本关键词兜底 —— 拿不到字段的老调用点才走到这。
 *
 * 刻意不含 429 纯限流(Requests per minute 是流控不是欠费; 它由 classifyFailure 归到
 * service_down, 照样能自动重跑), 但含 DashScope 的 Throttling.AllocationQuota(免费额度用尽)。
 *
 * @param fields provider 层解析出来的结构化字段。不传 = 退回 402 + 文本兜底(老行为)。
 */
export function isQuotaLikeError(
  status: number,
  body: string | null | undefined,
  fields?: { errorType?: string; errorCode?: string },
): boolean {
  if (status === 402) return true; // Payment Required

  // ---- ② 结构化字段(优先) ----
  const parsedFromBody = parseProviderErrorBody(body);
  const type = norm(fields?.errorType ?? parsedFromBody.type);
  const code = norm(fields?.errorCode ?? parsedFromBody.code);
  if (type && ACCOUNT_LEVEL_ERROR_TYPES.has(type)) return true;
  if (code && ACCOUNT_LEVEL_ERROR_TYPES.has(code)) return true;
  if (status === 400 && (type || code)) {
    const known = type || code;
    if (!REQUEST_LEVEL_ERROR_TYPES.has(known)) return true;
    // 请求级 type 明确 → 不是账户问题, 也不必再去文本里猜(猜出来的都是误报)
    return false;
  }

  // ---- ③ 文本兜底 ----
  const t = (body ?? "").toLowerCase();
  if (!t) return false;
  const KEYWORDS = [
    "insufficient_quota",
    "insufficient balance",
    "insufficientbalance",
    "insufficient_user_quota",
    "exceeded your current quota",
    "allocated quota exceeded",
    "allocationquota",
    "quota exhausted",
    "quota_exceeded",
    "arrears",
    "arrearage",          // 8-03: 百炼真实报文的词形, 旧词表只有 arrears → 对着真事故返回 false
    "overdue",
    "good standing",      // 8-03 真实报文: "...your account is in good standing before making a request"
    "account is overdue",
    "accessdenied.unpurchased",
    "free allocated quota exceeded",
    "余额不足",
    "额度不足",
    "欠费",
    "已用完",
    "未开通",
  ];
  if (KEYWORDS.some((k) => t.includes(k))) return true;

  // "access denied" 单独一条并带守卫: 它同时是 401/403 鉴权失败的常用措辞(那是 key 配错,
  //   不是欠费)。只在**非鉴权状态码**下才认 —— 8-03 那条正是 400 + "Access denied, please
  //   make sure your account is in good standing"。
  if (status !== 401 && status !== 403 && t.includes("access denied")) return true;

  return false;
}

/**
 * 7-27: 判定一次调用失败是否属于"超时/被中断"类。
 *
 * 由来: 7-27 线上 49 次 `This operation was aborted`(AbortController 到点掐断 fetch),
 *   一条 incident 都没有 —— 六维质检因此大面积拿不到分, 只能靠人肉翻日志才发现。
 *   AI 超时是**成本与产能**双杀的信号(钱花了、内容没出来), 必须能被简报报出来。
 *
 * 刻意**不含** 4xx/5xx 业务错误 —— 那些由 llm_quota / 调用方各自的日志覆盖, 混进来会稀释信号。
 * (classifyFailure 会另外把 5xx/429 也归进 service_down, 但那是分类, 不是"超时"这个信号本身。)
 */
export function isTimeoutLikeError(err: unknown): boolean {
  const msg = (err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "")).toLowerCase();
  if (!msg) return false;
  const KEYWORDS = [
    "aborted",          // undici: This operation was aborted
    "abort",            // AbortError
    "timeout",
    "timed out",
    "etimedout",
    "esockettimedout",
    "econnreset",
    "socket hang up",
    "超时",
  ];
  return KEYWORDS.some((k) => msg.includes(k));
}

// ============ 三分类主函数 ============

export type FailureKind = "content_error" | "service_down" | "quota_exceeded";

/** 网络层"连不上/断了"的 errno 与措辞 —— 与超时同属"服务当时不可用" */
const NETWORK_DOWN_TOKENS = [
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
  "ehostunreach",
  "enetunreach",
  "epipe",
  "socket hang up",
  "fetch failed",
  "network error",
  "connect error",
  "连接失败",
  "网络异常",
];

/**
 * 把任意一次失败归到三类之一。**整套自动重跑的地基**。
 *
 * 优先级(从确定到兜底): quota_exceeded > service_down > content_error。
 *   - quota 排最前: 欠费时下游表现常常是"超时"或"主备全挂", 若先判 service_down,
 *     探测会一直探到服务"不通"却永远说不出"是因为没钱", 简报也就给不出"去充值"这个动作。
 *   - content_error 是**兜底**而不是判据: 说不清是外部原因的, 才算内容自己的问题。
 *     宁可多重跑一次(有 retryCount 上限兜底), 也不要把一篇好稿子判死。
 */
export function classifyFailure(err: unknown): FailureKind {
  const f = extractErrorFields(err);
  const lower = f.text.toLowerCase();

  // ---- ① 账户级(充值后可重跑) ----
  if (isQuotaLikeError(f.status ?? 0, f.responseBody ?? f.text, {
    ...(f.errorType ? { errorType: f.errorType } : {}),
    ...(f.errorCode ? { errorCode: f.errorCode } : {}),
  })) {
    return "quota_exceeded";
  }
  // 我们自己的花费闸(billing/llm-guard 的日上限 / cost-ledger 的租户预算)。
  //   语义与欠费同构: "现在没额度, 额度回来了这条内容原样还能跑", 所以归同一类。
  if (lower.includes("budget_exceeded") || lower.includes("llm_daily_cap") || lower.includes("日上限")) {
    return "quota_exceeded";
  }

  // ---- ② 服务级(服务恢复后可重跑) ----
  if (isTimeoutLikeError(err) || isTimeoutLikeError(f.text)) return "service_down";
  if (f.status !== undefined && f.status >= 500) return "service_down";
  if (f.status === 429) return "service_down"; // 限流 = 此刻不可用, 退避后原样可跑
  if (NETWORK_DOWN_TOKENS.some((k) => lower.includes(k))) return "service_down";
  // AI 主备全挂(chat-service 的 AiUnavailableError) / DVH 的 TTS 硬中止:
  //   两者都是"外部服务当时给不出东西", 内容本身没问题。
  if (f.name === "AiUnavailableError" || lower.includes("ai 不可用")) return "service_down";
  if (f.name === "DvhTtsFailedError" || lower.includes("dvh_tts_failed")) return "service_down";

  // ---- ③ 兜底: 内容自己的问题, 重跑没用 ----
  return "content_error";
}

/** 这一类失败**服务恢复后重跑是否有意义**。content_error 判死, 另外两类都可自动重跑。 */
export function isRetriableFailure(kind: FailureKind): boolean {
  return kind === "quota_exceeded" || kind === "service_down";
}

/** 给运营看的一句话(简报/内容列表 tooltip 都念这张表) */
export const FAILURE_KIND_LABEL: Record<FailureKind, string> = {
  quota_exceeded: "AI 账户欠费/额度用尽",
  service_down: "外部服务当时不可用",
  content_error: "内容本身有问题(重跑也没用)",
};
