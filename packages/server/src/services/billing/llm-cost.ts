/**
 * LLM 成本记账 — 打通 cost-ledger 的 "llm" 类型。
 *
 * 背景(战略评估薄弱点#2): cost-ledger 定义了 kind:"llm" 但全项目 0 写入,
 * agents 层 tokensUsed 13 处硬编码 0 —— chat-service 每次调用都拿到真实 usage,
 * 只是从没落库, 导致"这个月 AI 花了多少钱/哪个租户在烧钱"完全黑盒。
 *
 * 设计:
 * - 单价默认值为 2026-07 手抄牌价(分/1M token), **以百炼控制台实际账单为准**;
 *   env LLM_PRICE_OVERRIDES(JSON)可覆盖/补新模型, 改价不改代码。
 * - recordLlmUsage 是旁路: 任何失败只打日志绝不上抛(recordCost 本身也绝不抛错),
 *   不 await 不阻塞 chat() 返回。
 * - 租户归属: request.tenantId 是真 uuid 就用它; 否则读 AsyncLocalStorage
 *   (skills 链路由 worker 在 skill.handle 外层注入, 见 runWithLlmCallAttribution);
 *   都没有则放弃记账 —— cost_ledger.tenant_id 是 NOT NULL 外键, 宁可不记不能编。
 * - 单笔金额在 recordCost 内四舍五入到分(整数列); 精确 token 数保存在 quantity/note。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getBillingAccount } from "../ai/llm-endpoints.js";
import { recordCost } from "./cost-ledger.js";

/**
 * 单价: 分 / 1M token。
 *
 * `cache` = 命中输入缓存的那部分 token 单价(百炼账单里是独立计费项)。
 * 不填则命中缓存的 token 按 `in` 计价 —— **刻意不给静默折扣**:
 * 少算钱和多算钱一样是记错账, 而少算的那种不会有人来投诉。
 */
export interface ModelPrice { in: number; out: number; cache?: number }

/** 2026-07 手抄默认价(分/1M token): deepseek-chat ¥2/¥8, deepseek-reasoner ¥4/¥16, qwen-plus ¥0.8/¥2 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "deepseek-chat": { in: 200, out: 800 },
  "deepseek-reasoner": { in: 400, out: 1600 },
  "qwen-plus": { in: 80, out: 200 },
  /**
   * 🔴 9-03 按**真实账单**校正: ¥12/¥24 每 1M token(原记 ¥3.1/¥6.2)。
   *
   * 7-26 那版是"按 DeepSeek 官网 $0.435/$0.87 折汇率"推算的, 注释还写着
   * 「百炼与官网同价, 这张表通用」—— **推算错了, 而且错了 3.9 倍**。
   *
   * 后果不是"报表数字难看", 是**预算闸整整失灵了 5 周**:
   *   LLM_DAILY_COST_CAP_YUAN=50 实际拦在 ¥195 才触发,
   *   而 9-03 那次重跑风暴 3.5 小时烧掉的真实金额约 ¥105 —— 闸从头到尾没响。
   *
   * 教训与红线 #16 同族: **单价是外部事实, 不许用汇率乘法"算"出来。**
   * 以账单为准, 对不上就改这张表(或用 LLM_PRICE_OVERRIDES 热覆盖)。
   */
  "deepseek-v4-pro": { in: 1200, out: 2400, cache: 100 },
  "deepseek-v4-flash": { in: 100, out: 200 },
  // qwen-max 之前不在表里 —— 一旦有人把主力切成它, 成本会记 0 分(预算闸失明), 先补上。
  "qwen-max": { in: 240, out: 960 },
};

let priceTable: Record<string, ModelPrice> | null = null;

function getPriceTable(): Record<string, ModelPrice> {
  if (priceTable) return priceTable;
  const table: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  if (env.LLM_PRICE_OVERRIDES) {
    try {
      const raw = JSON.parse(env.LLM_PRICE_OVERRIDES) as Record<string, { in?: unknown; out?: unknown }>;
      for (const [model, p] of Object.entries(raw)) {
        const inCents = Number(p?.in);
        const outCents = Number(p?.out);
        const cacheRaw = (p as { cache?: unknown })?.cache;
        const cacheCents = cacheRaw === undefined ? undefined : Number(cacheRaw);
        const cacheOk = cacheCents === undefined || (Number.isFinite(cacheCents) && cacheCents >= 0);
        if (Number.isFinite(inCents) && inCents >= 0 && Number.isFinite(outCents) && outCents >= 0 && cacheOk) {
          table[model] = { in: inCents, out: outCents, ...(cacheCents === undefined ? {} : { cache: cacheCents }) };
        } else {
          logger.warn({ model }, "llm_cost.price_override_invalid — 该条忽略");
        }
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "llm_cost.price_overrides_parse_failed — 全部忽略, 用默认价目");
    }
  }
  priceTable = table;
  return priceTable;
}

/** 算一笔调用的成本(分, 浮点)。模型不在价目表 → priced=false + 0 分(用量仍会被记录)。 */
export function computeLlmCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
): { cents: number; priced: boolean } {
  const price = getPriceTable()[model];
  if (!price) return { cents: 0, priced: false };
  /**
   * 🔴 `inputTokens`(= API 的 prompt_tokens)**已经包含**命中缓存的部分,
   * 所以未命中量要减出来, 否则缓存那段会被算两遍。
   * 缓存价缺失时按 `in` 计 —— 见 ModelPrice.cache 的注释(不给静默折扣)。
   */
  const cached = Math.max(0, Math.min(cachedTokens, inputTokens));
  const uncached = inputTokens - cached;
  const cachePrice = price.cache ?? price.in;
  return {
    cents:
      (uncached / 1_000_000) * price.in +
      (cached / 1_000_000) * cachePrice +
      (outputTokens / 1_000_000) * price.out,
    priced: true,
  };
}

// ---------- 调用归属(谁在花钱) ----------

export interface LlmCallAttribution {
  tenantId: string;
  userId?: string;
  conversationId?: string;
  /**
   * 9-04 件 1(e): 这次调用产出的内容 id，写进 cost_ledger.content_id。
   *
   * 此前该列**恒为 NULL** —— recordLlmUsage 压根不接这个参数，
   * 于是"这笔钱花在哪篇上"无从回答，件 1 的判据只能靠时间窗推算。
   */
  contentId?: string;
  /**
   * 🔴 这次调用是不是 deferred 重跑产生的。
   *
   * 件 1 的停止条件就是它：有了这个标记，「今天 ¥X 里重跑占 ¥Y」是一条 SQL；
   * 没有它，只能拿 requeuedAt 时间窗反推，而时间窗会把当天正常生成也算进去。
   */
  isRetry?: boolean;
}

const llmCallContext = new AsyncLocalStorage<LlmCallAttribution>();

/**
 * 在 attribution 作用域内执行 fn: 作用域内所有(含嵌套异步)chat() 调用的成本记到该租户。
 * 用于 skills 链路 —— ArticleSkill/VideoSkill 用构造器注入的单例 provider(实例上没有租户),
 * worker 在调 skill.handle 前包一层即可, 8 个 provider.chat 调用点零改动且无并发串号风险。
 */
export function runWithLlmCallAttribution<T>(attribution: LlmCallAttribution, fn: () => T): T {
  return llmCallContext.run(attribution, fn);
}

export function getLlmCallAttribution(): LlmCallAttribution | undefined {
  return llmCallContext.getStore();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** chat() 成功出口调用(fire-and-forget)。内部消化一切异常。 */
export async function recordLlmUsage(p: {
  tenantId: string;
  taskType: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /** 命中输入缓存的 token 数(含在 inputTokens 内)。provider 没给就是 0 */
  cachedTokens?: number;
  /** 9-04 件 1(e): 显式传入优先; 没传则从 ALS 的 attribution 里取 */
  contentId?: string;
  isRetry?: boolean;
}): Promise<void> {
  try {
    if (p.model === "none") return; // "无可用模型"占位回复, 没花钱
    if ((p.inputTokens ?? 0) <= 0 && (p.outputTokens ?? 0) <= 0) return; // 无 usage 的失败/降级回复
    const attr = getLlmCallAttribution();
    const tenantId = UUID_RE.test(p.tenantId) ? p.tenantId : attr?.tenantId;
    if (!tenantId || !UUID_RE.test(tenantId)) {
      logger.debug({ model: p.model, taskType: p.taskType }, "llm_cost.skip — 无真实租户可归属(脚本/系统调用)");
      return;
    }
    const cached = p.cachedTokens ?? 0;
    const { cents, priced } = computeLlmCostCents(p.model, p.inputTokens, p.outputTokens, cached);
    if (!priced) {
      logger.warn({ model: p.model }, "llm_cost.unpriced — 模型不在价目表, 金额记 0(用 LLM_PRICE_OVERRIDES 补价)");
    }
    // 7-26: 记上"钱从哪个账户扣"。同一个 deepseek 模型既可能走 DeepSeek 官方账户,
    //   也可能走阿里云百炼(DEEPSEEK_VIA=bailian) —— provider 名都叫 deepseek, 只看它会把账记串。
    //   注意 note 首个 token 仍是 "provider/model", 成本日报的 split_part 解析不受影响。
    const billing = getBillingAccount(p.provider);
    // 9-04 件 1(e): 归因。显式入参优先, 否则读 ALS —— skills 链路的 8 个
    //   provider.chat 调用点不传参, 全靠 worker 外层包的那一层 attribution。
    //   contentId 非 uuid 一律丢弃: cost_ledger.content_id 有外键, 编一个会让整条记账失败。
    const rawContentId = p.contentId ?? attr?.contentId;
    const contentId = rawContentId && UUID_RE.test(rawContentId) ? rawContentId : null;
    const isRetry = p.isRetry ?? attr?.isRetry ?? false;
    await recordCost({
      tenantId,
      kind: "llm",
      contentId,
      amountCents: cents, // recordCost 内 Math.round 到整数分
      quantity: p.inputTokens + p.outputTokens,
      note: `${p.provider}/${p.model} task=${p.taskType} in=${p.inputTokens} out=${p.outputTokens}${cached > 0 ? ` cached=${cached}` : ""}${isRetry ? " retry=1" : ""} billing=${billing}${priced ? "" : " unpriced"}`,
    });
    // 7-27 无人值守: 把刚花的钱累到日上限闸的进程内增量上, 让 60s 缓存窗口内也能及时触顶。
    //   闸门本身(checkLlmDailyCap)在生成链路调用; 这里只喂数, 不做任何拦截(记账出口不该有副作用)。
    const { noteLlmSpend } = await import("./llm-guard.js");
    noteLlmSpend(cents);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "llm_cost.record_failed(已忽略, 不影响业务)");
  }
}

/** 仅测试用: 重置价目表缓存(env mock 变化后)。 */
export function __resetPriceTableForTest(): void {
  priceTable = null;
}
