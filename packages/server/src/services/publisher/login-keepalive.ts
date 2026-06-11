/**
 * 登录态每日保活巡检(6-11, 多账号稳定运行的命门)
 *
 * 痛点: 矩阵 N 个抖音/视频号账号, 网页登录态几天就掉, 掉了只有推送失败那一刻才发现。
 * 做法: 每日凌晨串行巡检所有 loginStatus=logged_in 的浏览器登录账号:
 *   - 抖音(持久 profile): 打开账号专属 profile 访创作者中心, 内容判定登录态(douyinPageLoggedIn);
 *     活着即顺手刷新了 profile 内 cookie(访问本身就是续期)。
 *   - 视频号(cookie 注入): 注入登录态访 channels.weixin.qq.com, URL 判定;
 *     活着则重抓全量 cookie+localStorage 回存(部分 cookie 滑动过期, 回存=续命)。
 *   - 掉线 → markLoginExpired, 账号页徽章变红, 推送会主动跳过并提示重新扫码。
 *
 * 节奏: 全局串行 + 账号间 8~20s 随机间隔(与推草稿同纪律: 列表爬/enrich/保活绝不并发浏览器)。
 * 触发: scheduler cron 每日 05:00(避开 03:30 备份/07:00 爬虫) + POST /accounts/keepalive 手动。
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../models/db.js";
import { platformAccounts } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { encryptCredentials } from "../../utils/crypto.js";
import {
  BROWSER_LOGIN_PLATFORMS,
  acquireProfileBrowser,
  releaseProfileBrowser,
  getSessionBrowser,
  loadLoginState,
  markLoginExpired,
} from "./browser-session.js";
import { setPageLoginState } from "./draft-push.js";

const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

export interface KeepaliveAccountResult {
  accountId: string;
  accountName: string;
  platform: string;
  result: "alive" | "expired" | "error";
  detail?: string;
}

export interface KeepaliveSummary {
  startedAt: string;
  finishedAt: string;
  checked: number;
  alive: number;
  expired: number;
  errors: number;
  accounts: KeepaliveAccountResult[];
}

let running = false;
let lastSummary: KeepaliveSummary | null = null;

export function getLastKeepaliveSummary(): KeepaliveSummary | null {
  return lastSummary;
}

export function isKeepaliveRunning(): boolean {
  return running;
}

/** 巡检单个账号, 返回结果。内部自行兜底异常。 */
async function checkAccount(acct: {
  id: string;
  tenantId: string;
  accountName: string;
  platform: string;
}): Promise<KeepaliveAccountResult> {
  const base = { accountId: acct.id, accountName: acct.accountName, platform: acct.platform };
  const cfg = BROWSER_LOGIN_PLATFORMS[acct.platform];
  if (!cfg) return { ...base, result: "error", detail: "平台不支持浏览器登录" };

  const usesProfile = !!cfg.persistentProfile;
  let page: import("puppeteer").Page | null = null;
  try {
    if (usesProfile) {
      // 抖音: profile 即登录态, 直接开
      const browser = await acquireProfileBrowser(acct.id);
      page = await browser.newPage();
    } else {
      // 视频号: 共享浏览器 + 注入登录态
      const state = await loadLoginState(acct.id, acct.tenantId);
      if (!state) {
        await markLoginExpired(acct.id, acct.tenantId);
        return { ...base, result: "expired", detail: "无登录态记录" };
      }
      page = await (await getSessionBrowser()).newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await setPageLoginState(page, state, acct.platform);
    }

    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 4_000));

    let loggedIn: boolean;
    if (cfg.checkLoggedIn) {
      loggedIn = await cfg.checkLoggedIn(page);
    } else {
      loggedIn = cfg.isLoggedInUrl(page.url());
    }

    if (!loggedIn) {
      await markLoginExpired(acct.id, acct.tenantId);
      logger.warn({ accountId: acct.id, platform: acct.platform }, "keepalive: 登录态已失效");
      return { ...base, result: "expired", detail: `落在 ${page.url().slice(0, 80)}` };
    }

    // 活着 → 续期回存
    if (!usesProfile) {
      // 视频号: 重抓 cookie + localStorage 写回(滑动过期续命)
      try {
        const cdp = await page.target().createCDPSession();
        const { cookies } = (await cdp.send("Network.getAllCookies")) as { cookies: any[] };
        const kept = cookies.filter((c) =>
          cfg.cookieDomains.some((d) => (c.domain ?? "").endsWith(d))
        );
        const ls = await page.evaluate(() => {
          try {
            const l = (globalThis as any).localStorage;
            const out: Record<string, string> = {};
            for (let i = 0; i < l.length; i++) { const k = l.key(i); if (k) out[k] = l.getItem(k); }
            return JSON.stringify(out);
          } catch { return "{}"; }
        });
        if (kept.length > 0) {
          await db
            .update(platformAccounts)
            .set({
              loginState: encryptCredentials(JSON.stringify({ cookies: kept, localStorage: ls })),
              loginAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(eq(platformAccounts.id, acct.id), eq(platformAccounts.tenantId, acct.tenantId)));
        }
      } catch (err) {
        // 回存失败不算掉线(登录还在), 只记日志
        logger.warn({ err: err instanceof Error ? err.message : err, accountId: acct.id }, "keepalive: cookie 回存失败(登录仍有效)");
      }
    } else {
      // 抖音 profile: 访问即续期, 只更新时间戳
      await db
        .update(platformAccounts)
        .set({ loginAt: new Date(), updatedAt: new Date() })
        .where(and(eq(platformAccounts.id, acct.id), eq(platformAccounts.tenantId, acct.tenantId)));
    }

    logger.info({ accountId: acct.id, platform: acct.platform }, "keepalive: 登录态正常, 已续期");
    return { ...base, result: "alive" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "巡检异常";
    logger.error({ err: msg, accountId: acct.id, platform: acct.platform }, "keepalive: 巡检异常(不改账号状态)");
    return { ...base, result: "error", detail: msg };
  } finally {
    try { await page?.close(); } catch { /* noop */ }
    if (usesProfile) await releaseProfileBrowser(acct.id);
  }
}

/**
 * 跑一轮保活。tenantId 不传 = 全租户。
 * 并发保护: 已在跑则直接返回 null(调用方提示"巡检进行中")。
 */
export async function runLoginKeepalive(tenantId?: string): Promise<KeepaliveSummary | null> {
  if (running) return null;
  running = true;
  const startedAt = new Date().toISOString();
  const results: KeepaliveAccountResult[] = [];
  try {
    const conds = [
      inArray(platformAccounts.platform, Object.keys(BROWSER_LOGIN_PLATFORMS)),
      eq(platformAccounts.loginStatus, "logged_in"),
    ];
    if (tenantId) conds.push(eq(platformAccounts.tenantId, tenantId));
    const accounts = await db
      .select({
        id: platformAccounts.id,
        tenantId: platformAccounts.tenantId,
        accountName: platformAccounts.accountName,
        platform: platformAccounts.platform,
      })
      .from(platformAccounts)
      .where(and(...conds));

    logger.info({ count: accounts.length }, "keepalive: 开始登录态巡检");
    for (let i = 0; i < accounts.length; i++) {
      results.push(await checkAccount(accounts[i]));
      if (i < accounts.length - 1) {
        await new Promise((r) => setTimeout(r, rand(8_000, 20_000)));
      }
    }
  } finally {
    running = false;
  }

  const summary: KeepaliveSummary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    checked: results.length,
    alive: results.filter((r) => r.result === "alive").length,
    expired: results.filter((r) => r.result === "expired").length,
    errors: results.filter((r) => r.result === "error").length,
    accounts: results,
  };
  lastSummary = summary;
  logger.info({ checked: summary.checked, alive: summary.alive, expired: summary.expired, errors: summary.errors }, "keepalive: 巡检完成");
  return summary;
}
