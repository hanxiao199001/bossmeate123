/**
 * 7-25 运维告警②: 供应商余额监控
 *
 * 调研结论(写死在这里, 免下次又从头查):
 *
 *  1) 阿里云主账户余额 —— 有 API。BSS OpenAPI `QueryAccountBalance`(version 2017-12-14,
 *     endpoint business.aliyuncs.com), 返回 AvailableAmount / CreditAmount / Currency。
 *     实现走 @alicloud/openapi-client 的**通用 callApi(RPC)**, 与 compliance/image-moderation.ts
 *     同款写法 —— **不新增依赖**(不装 @alicloud/bssopenapi20171214, 遵守红线 #7 锁文件铁律)。
 *     ⚠️ 权限: 需 AK 拥有 `bss:QueryAccountBalance`(托管策略 AliyunBSSReadOnlyAccess),
 *        且 RAM 子账号必须由**主账号**在"用户中心→财务权限"里授权; 现有 AK(发短信/OSS/DVH/内容审核用)
 *        大概率**没有**这条财务权限。故本项 **默认关闭**(env OPS_ALIYUN_BALANCE_ENABLED=false),
 *        权限不通/未开通只记一次 warn 日志并降级, 绝不影响简报出稿。
 *
 *  2) 百炼 / DashScope 额度 —— **没有**公开的"剩余额度查询" API。
 *     百炼按量付费直接扣阿里云账户余额 → 上面 ① 的账户余额就覆盖了"钱够不够";
 *     真正查不到的只有"免费赠送 token 还剩多少"(仅控制台可见)。
 *     → 该维度只能靠下面 ③④ 的自有信号。
 *
 *  3) 降级方案(必做, 不依赖任何外部 API): 用自己的 cost_ledger 做消耗速率异常检测。
 *     近 7 日日均消耗 vs 今日消耗 —— 平时天天花钱、今天骤降到 ~0 = 疑似欠费/额度耗尽/链路断。
 *
 *  4) 最直接的信号: LLM 调用返回"额度不足/欠费"类错误 → openai-compatible provider 已在
 *     失败分支调 recordIncident({kind:"llm_quota"}), 这里读近 24h 计数。
 *
 * 判定优先级: ④ 有额度错误(铁证) > ① API 余额低于阈值 > ③ 消耗骤停(推测)。
 */
import * as $OpenApi from "@alicloud/openapi-client";
import * as $Util from "@alicloud/tea-util";
import Credential, * as $Credential from "@alicloud/credentials";
import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { costLedger } from "../../models/schema.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { countIncidents } from "./incidents.js";

export interface SupplierBalanceResult {
  /** 阿里云账户可用余额(元); null = 未开启/查不到 */
  aliyunAvailableYuan: number | null;
  aliyunCurrency: string | null;
  /** 余额查询失败原因(权限不足/未开启/网络), 供简报如实说明"这项没查到" */
  aliyunError: string | null;
  /** 近 7 日(不含今日)日均消耗, 分 */
  avg7dCents: number;
  /** 今日消耗, 分 */
  todayCents: number;
  /** 近 24h LLM 额度不足类错误次数 */
  llmQuotaErrors24h: number;
  /** 综合判定 */
  level: "ok" | "warn" | "alert";
  /** 人话结论(简报直接用) */
  reasons: string[];
}

/** CJS interop: @alicloud/* 的 default 挂在 .default 上（PR #237 教训, 同 image-moderation.ts） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapCtor<T>(mod: T): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = mod as any;
  return typeof m === "function" ? m : m?.default ?? m;
}

/**
 * 查阿里云账户余额。默认关闭; 任何失败都返回 { yuan: null, error } 降级, 绝不抛。
 * 返回 yuan=null 时简报会写"未查询/查不到"并退回消耗速率判定。
 */
export async function queryAliyunBalance(): Promise<{ yuan: number | null; currency: string | null; error: string | null }> {
  if (!env.OPS_ALIYUN_BALANCE_ENABLED) {
    return { yuan: null, currency: null, error: "未开启(OPS_ALIYUN_BALANCE_ENABLED=false)" };
  }
  const akId = process.env.ALIYUN_ACCESS_KEY_ID ?? process.env.ALIYUN_AK_ID;
  const akSecret = process.env.ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIYUN_AK_SECRET;
  if (!akId || !akSecret) return { yuan: null, currency: null, error: "缺 ALIYUN_ACCESS_KEY_ID / SECRET" };

  try {
    const CredentialCtor = unwrapCtor(Credential);
    const ClientCtor = unwrapCtor($OpenApi.default);
    const credential = new CredentialCtor(
      new $Credential.Config({ type: "access_key", accessKeyId: akId, accessKeySecret: akSecret }),
    );
    const config = new $OpenApi.Config({ credential });
    config.endpoint = env.OPS_ALIYUN_BSS_ENDPOINT;
    const client = new ClientCtor(config);

    const params = new $OpenApi.Params({
      action: "QueryAccountBalance",
      version: "2017-12-14",
      protocol: "HTTPS",
      pathname: "/",
      method: "POST",
      authType: "AK",
      style: "RPC",
      reqBodyType: "formData",
      bodyType: "json",
    });
    const request = new $OpenApi.OpenApiRequest({ query: {} });
    const runtime = new $Util.RuntimeOptions({ readTimeout: 8000, connectTimeout: 8000 });
    const resp = await client.callApi(params, request, runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (resp?.body ?? {}) as Record<string, any>;
    if (body.Success === false || body.Code === "Forbidden" || body.Code === "NoPermission") {
      return { yuan: null, currency: null, error: `BSS 拒绝: ${body.Code ?? "?"} ${body.Message ?? ""}`.trim().slice(0, 200) };
    }
    const data = (body.Data ?? body.data ?? {}) as Record<string, unknown>;
    // AvailableAmount 形如 "1,234.56"(带千分位) — 去逗号再转数
    const raw = String(data.AvailableAmount ?? data.availableAmount ?? "").replace(/,/g, "").trim();
    const yuan = raw === "" ? null : Number(raw);
    if (yuan === null || !Number.isFinite(yuan)) {
      return { yuan: null, currency: null, error: "BSS 返回里没有可解析的 AvailableAmount" };
    }
    return { yuan, currency: String(data.Currency ?? data.currency ?? "CNY"), error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "阿里云余额查询失败 — 降级为消耗速率判定(不影响简报)");
    return { yuan: null, currency: null, error: msg.slice(0, 200) };
  }
}

/** 近 7 日(不含今日)日均消耗 + 今日消耗, 单位: 分。全租户合计(运维看的是这台机器的总花销)。 */
export async function getSpendRate(startOfTodayUtc: Date): Promise<{ avg7dCents: number; todayCents: number }> {
  const weekAgo = new Date(startOfTodayUtc.getTime() - 7 * 86_400_000);
  try {
    const [prev] = await db
      .select({ total: sql<string>`COALESCE(SUM(${costLedger.amountCents}), 0)` })
      .from(costLedger)
      .where(and(gte(costLedger.createdAt, weekAgo), lt(costLedger.createdAt, startOfTodayUtc)));
    const [today] = await db
      .select({ total: sql<string>`COALESCE(SUM(${costLedger.amountCents}), 0)` })
      .from(costLedger)
      .where(gte(costLedger.createdAt, startOfTodayUtc));
    return {
      avg7dCents: Math.round(Number(prev?.total ?? 0) / 7),
      todayCents: Number(today?.total ?? 0),
    };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "消耗速率查询失败, 该项留 0");
    return { avg7dCents: 0, todayCents: 0 };
  }
}

/**
 * 纯函数: 给定信号 → 供应商余额判定。无 IO, 直接单测。
 *
 * alert: LLM 明确报额度不足 / 账户余额低于 alertYuan / 平时有花销今天骤停
 * warn : 账户余额低于 warnYuan / 消耗大幅下滑(未到 0)
 */
export function judgeSupplier(input: {
  aliyunAvailableYuan: number | null;
  avg7dCents: number;
  todayCents: number;
  llmQuotaErrors24h: number;
  warnYuan: number;
  alertYuan: number;
  /** 今日消耗 / 近 7 日均值 低于该比例视为骤降 (默认 0.2) */
  dropRatio: number;
  /** 日均消耗低于这个数(分)就不做骤停判定 —— 本来就不怎么花钱, 一天没花很正常 */
  minAvgCents: number;
}): { level: "ok" | "warn" | "alert"; reasons: string[] } {
  const reasons: string[] = [];
  const RANK = { ok: 0, warn: 1, alert: 2 } as const;
  let level: "ok" | "warn" | "alert" = "ok";
  /** 只升不降: 取最严重的一项做最终等级 */
  const raise = (l: "warn" | "alert") => {
    if (RANK[l] > RANK[level]) level = l;
  };

  if (input.llmQuotaErrors24h > 0) {
    reasons.push(`AI 调用近 24h 报了 ${input.llmQuotaErrors24h} 次「额度不足/欠费」—— 这是最硬的信号, 请立刻去阿里云充值或提额`);
    raise("alert");
  }

  if (input.aliyunAvailableYuan !== null) {
    if (input.aliyunAvailableYuan <= input.alertYuan) {
      reasons.push(`阿里云账户可用余额仅 ${input.aliyunAvailableYuan.toFixed(2)} 元(低于告警线 ${input.alertYuan} 元), 随时可能停服`);
      raise("alert");
    } else if (input.aliyunAvailableYuan <= input.warnYuan) {
      reasons.push(`阿里云账户可用余额 ${input.aliyunAvailableYuan.toFixed(2)} 元(低于提醒线 ${input.warnYuan} 元), 建议尽快充值`);
      raise("warn");
    }
  }

  // 消耗骤停: 只在"平时确实在花钱"时才判, 否则新客户/低量期天天误报
  if (input.avg7dCents >= input.minAvgCents) {
    const ratio = input.avg7dCents > 0 ? input.todayCents / input.avg7dCents : 1;
    if (input.todayCents === 0) {
      reasons.push(`今日消耗为 0(近 7 日日均 ${(input.avg7dCents / 100).toFixed(2)} 元) —— 疑似欠费/额度耗尽, 或生成链路整条断了`);
      raise("alert");
    } else if (ratio < input.dropRatio) {
      reasons.push(`今日消耗 ${(input.todayCents / 100).toFixed(2)} 元, 只有近 7 日日均(${(input.avg7dCents / 100).toFixed(2)} 元)的 ${Math.round(ratio * 100)}% —— 生成量或额度可能出问题`);
      raise("warn");
    }
  }

  return { level, reasons };
}

/** 采集 + 判定一体化, 供每日简报调用 */
export async function checkSupplierBalance(startOfTodayUtc: Date): Promise<SupplierBalanceResult> {
  const [balance, rate, quotaErrors] = await Promise.all([
    queryAliyunBalance(),
    getSpendRate(startOfTodayUtc),
    countIncidents("llm_quota", 24),
  ]);
  const judged = judgeSupplier({
    aliyunAvailableYuan: balance.yuan,
    avg7dCents: rate.avg7dCents,
    todayCents: rate.todayCents,
    llmQuotaErrors24h: quotaErrors,
    warnYuan: env.OPS_BALANCE_WARN_YUAN,
    alertYuan: env.OPS_BALANCE_ALERT_YUAN,
    dropRatio: env.OPS_SPEND_DROP_RATIO,
    minAvgCents: env.OPS_SPEND_MIN_AVG_CENTS,
  });
  return {
    aliyunAvailableYuan: balance.yuan,
    aliyunCurrency: balance.currency,
    aliyunError: balance.error,
    avg7dCents: rate.avg7dCents,
    todayCents: rate.todayCents,
    llmQuotaErrors24h: quotaErrors,
    ...judged,
  };
}
