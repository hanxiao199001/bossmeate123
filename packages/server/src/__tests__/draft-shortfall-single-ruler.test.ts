import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * 「未达保底」只许有一把尺子 (7-29)。
 *
 * ## 病症(生产实测)
 *
 * 同一天同一个租户, 两处报出两个数:
 *   · 分发器 incident:  `1/7 个公众号未达每日保底(2篇), 其中 1 个号今日 0 篇`
 *   · 运维简报正文:      `5 个公众号今日进草稿箱未达保底(2 篇/天): 学术研途鉴(1/2)、
 *                        学术指南卡卡(1/2)、论文解忧栈(1/2)、0纸高分(1/2)、Paper咨询与发表(0/2)`
 *
 * 逐号核对 content_publish_log 后, **分发器是对的**: 那 4 个"1/2"的号各有 1 条
 * `status=success` / `initiated_by=bulk_distribute`(管理后台批量推的)没被简报数进去,
 * 它们实际都是 2/2 达标。简报只 `WHERE status='draft_pushed'`, 分发器不按 status 过滤。
 *
 * ## 为什么这不只是"数字难看"
 *
 * 运营看到 5 个号未达标, 会去挨个查那 4 个根本没问题的号; 而当天**真正坏掉的那个**
 * (Paper咨询与发表, 微信 appid 40013 invalid, 全天 0 篇、连推 6 次全失败)淹没在名单里。
 * 告警把注意力引向错误的地方, 比不告警更糟。
 *
 * ## 锁什么
 *
 * 只锁"简报有没有去调分发器那把尺子"这一件事。不去比对具体数字 —— 那要连 DB,
 * 且数字每天都变; 也不正则匹配整段实现 —— 那是红线 #12 说的"守文本不守行为"。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEFING = readFileSync(resolve(HERE, "../services/ops/daily-briefing.ts"), "utf8");
const DISTRIBUTOR = readFileSync(resolve(HERE, "../services/publisher/draft-distributor.ts"), "utf8");

describe("未达保底: 简报与分发器共用同一把尺子", () => {
  it("分发器把口径函数导出了(不导出简报就只能自己抄一份)", () => {
    expect(DISTRIBUTOR).toMatch(/export\s+async\s+function\s+countTodayAccountLoad/);
  });

  it("分发器自己的缺口判定也走这把尺子", () => {
    expect(DISTRIBUTOR).toContain("await countTodayAccountLoad(tenantId)");
  });

  it("这把尺子**不按 status 过滤** —— 收到就算, 不管是哪条链路推的", () => {
    const start = DISTRIBUTOR.indexOf("export async function countTodayAccountLoad");
    expect(start).toBeGreaterThan(-1);
    const body = DISTRIBUTOR.slice(start, DISTRIBUTOR.indexOf("\n}", start));
    // 病根就是多了一条 status 条件; 谁再加回来, 两处又会各说各话
    expect(body).not.toMatch(/contentPublishLog\.status/);
    expect(body).not.toMatch(/draft_pushed/);
  });

  it("简报的缺口判定去调分发器, 不再自己数 draft_pushed", () => {
    expect(BRIEFING).toContain("countTodayAccountLoad");
    // draftShortfalls 必须建立在取回来的 load 上
    expect(BRIEFING).toMatch(/draftShortfalls\s*=\s*wechatAccounts[\s\S]{0,220}loadByAccount\.get/);
  });

  it("简报里 draftShortfalls 不再读那份只数 draft_pushed 的 map", () => {
    const i = BRIEFING.indexOf("const draftShortfalls");
    expect(i).toBeGreaterThan(-1);
    const stmt = BRIEFING.slice(i, i + 300);
    expect(stmt).not.toContain("pushedByAccount.get");
  });

  it("「进草稿箱 N 条」仍是字面口径(只数 draft_pushed) —— 两个数问的不是同一件事", () => {
    // 缺口问"这个号今天拿到东西没有"(全状态); 展示问"草稿箱进了几条"(仅 draft_pushed)。
    // 刻意保留差异, 但必须各自说得清 —— 所以这里锁住它没被顺手一起改掉。
    expect(BRIEFING).toMatch(/draftPushedToday\s*=\s*\[\.\.\.pushedByAccount\.values\(\)\]/);
  });

  it("取不到分发器口径时要降级不要整份挂掉(告警链路自己不能成为故障源)", () => {
    // ⚠️ 别用 indexOf("countTodayAccountLoad") 定位: 首个命中在上方**注释**里, 窗口会取到
    //    完全无关的代码(本测试第一版就栽在这, 假红一次)。锚定真正的调用语句。
    const i = BRIEFING.indexOf("await countTodayAccountLoad(tenantId)");
    expect(i, "找不到实际调用点").toBeGreaterThan(-1);
    const around = BRIEFING.slice(Math.max(0, i - 300), i + 600);
    expect(around).toContain("catch");
    expect(around).toMatch(/logger\.warn/);
  });
});
