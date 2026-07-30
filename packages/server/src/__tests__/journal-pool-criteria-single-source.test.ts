/**
 * 「选刊器与期刊池盘点用同一份 WHERE」同源守卫 (7-30)。
 *
 * ## 为什么要这道守卫
 *
 * 盘点服务(`journals/pool-inventory.ts`)要回答"这个学科还剩几本可选", 而"能选到"的定义
 * 长在选刊器(`daily-cron.pickScopedFreshJournal`)里。这两处一旦各写各的 WHERE, 失败模式
 * 特别阴 —— **不报错, 只是数不对**: 报表说"教育学还有 20 本", 选刊器一本都选不出来。
 * 运营照着这个假数决定"不用补货", 于是重复用刊继续。比没有盘点更糟。
 *
 * 这个项目已因"照着再写一遍"犯过 5 次同类错(国内刊定义 5 套 / 反编造判据 4 套 /
 * 质量分数线 6 套 / 学科匹配读错列 11 处 / 共享池 tenant 过滤 13 处), 病史见
 * `services/journals/intl-signal.ts` 文件头。所以口径只有一份: `journalPoolCriteria()`。
 *
 * ## 这里守三件事
 *   ① **行为**: 六个片段渲染出的 SQL 语义(不是字符串长相)符合约定 —— 换 drizzle 版本、
 *      等价重构都不该红, 但把 fresh 从 15 天改成 30 天、把 verified 换成裸 confidence 会红。
 *   ② **同源**: 选刊器与盘点服务都从 journalPoolCriteria 取, 谁也不在自己家里拼。
 *   ③ **不扩散**: 除白名单外, 全仓不许再出现"自己拼 journal_usage 冷却条件"的代码。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  journalPoolCriteria,
  journalCooldownDays,
  journalActiveCondition,
  journalFreshForTenant,
} from "../services/journals/journal-sql.js";
import { buildVerifiedJournalSql } from "../services/journals/journal-kind.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const dialect = new PgDialect();
const render = (s: SQL): { sql: string; params: unknown[] } => {
  const q = dialect.sqlToQuery(s);
  return { sql: q.sql, params: q.params as unknown[] };
};

const TENANT = "22222222-2222-4222-8222-222222222222";
const C = () => journalPoolCriteria({ tenantId: TENANT, scope: "international", discipline: "education" });

describe("① 六个片段的语义(行为级, 不锁字面量)", () => {
  it("active: 在架 且 排除 ai_fabricated 编造刊", () => {
    const { sql, params } = render(journalActiveCondition());
    expect(sql).toMatch(/"journals"\."status"\s*=\s*\$1/);
    expect(params[0]).toBe("active");
    expect(sql).toMatch(/data_source"?\s+IS DISTINCT FROM 'ai_fabricated'/);
  });

  it("verified: 就是 buildVerifiedJournalSql 的输出(分体系门槛, 不是裸 confidence>=70)", () => {
    const { sql } = render(C().verified);
    expect(sql).toBe(buildVerifiedJournalSql("journals."));
    expect(sql).toContain("journal_kind = 'cn'"); // 国内刊走目录成员资格那一支
  });

  it("scope: 打生成列 journal_kind; international 只认 intl(骑墙刊不进国外槽位)", () => {
    const { sql, params } = render(C().scope!);
    expect(sql).toMatch(/"journals"\."journal_kind"\s+in\s+\(/i);
    expect(params).toEqual(["intl"]);
    const dom = journalPoolCriteria({ tenantId: TENANT, scope: "domestic", discipline: "education" });
    expect(render(dom.scope!).params).toEqual(["cn", "both"]);
    // both/未知 → 不过滤
    expect(journalPoolCriteria({ tenantId: TENANT, scope: "both", discipline: "education" }).scope).toBeNull();
  });

  it("discExact / discOrGeneric: 打生成列 discipline_code, 综合刊只在后者出现", () => {
    const c = C();
    const exact = render(c.discExact);
    expect(exact.sql).toMatch(/"journals"\."discipline_code"\s*=\s*\$1/);
    expect(exact.params).toEqual(["education"]);
    const wide = render(c.discOrGeneric);
    expect(wide.params).toEqual(["education", "generic"]);
    expect(wide.sql).toMatch(/OR/i);
    // 🚫 学科槽位码**不再过一次归一** —— 选刊器一直是直接比对, 盘点必须一模一样
    expect(render(journalPoolCriteria({ tenantId: TENANT, discipline: "临床医学" }).discExact).params)
      .toEqual(["临床医学"]);
  });

  it("fresh: NOT EXISTS journal_usage, 带租户 + 冷却天数(默认 15)", () => {
    const { sql, params } = render(C().fresh);
    expect(sql).toMatch(/NOT EXISTS/i);
    expect(sql).toContain("journal_usage");
    expect(sql).toMatch(/make_interval\(days\s*=>\s*\$\d\)/);
    expect(params).toContain(TENANT);
    expect(params).toContain(15);
    expect(journalCooldownDays()).toBe(15);
    // 冷却天数由 env 单点控制(此前 daily-cron / pick-degrade / roundup 各读一遍)
    process.env.JOURNAL_REUSE_COOLDOWN_DAYS = "30";
    try {
      expect(journalCooldownDays()).toBe(30);
      expect(render(journalFreshForTenant(TENANT)).params).toContain(30);
    } finally {
      delete process.env.JOURNAL_REUSE_COOLDOWN_DAYS;
    }
  });

  it("cooldownDays 随条件组一起返回 —— 盘点估算回补速度必须用**同一个**冷却天数", () => {
    expect(C().cooldownDays).toBe(journalCooldownDays());
  });
});

describe("② 同源: 两个消费方都从 journalPoolCriteria 取", () => {
  const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

  it("选刊器 pickScopedFreshJournal 解构条件组, 不自己拼", () => {
    const src = read("services/recommendation/daily-cron.ts");
    expect(src).toMatch(/journalPoolCriteria\(\{ tenantId, scope, discipline \}\)/);
    const fnStart = src.indexOf("async function pickScopedFreshJournal");
    const fnBody = src.slice(fnStart, src.indexOf("runDailyContentByType", fnStart));
    for (const name of ["active", "verified", "sc", "discExact", "discOrGeneric", "fresh"]) {
      expect(fnBody).toContain(name);
    }
    expect(fnBody).not.toMatch(/NOT EXISTS[\s\S]{0,120}journal_usage/);
  });

  it("盘点服务 pool-inventory 用的是同一个函数(不是照着写的第二套)", () => {
    const src = read("services/journals/pool-inventory.ts");
    expect(src).toMatch(/import \{ journalPoolCriteria, journalCooldownDays \} from "\.\/journal-sql\.js"/);
    expect(src).toMatch(/journalPoolCriteria\(\{/);
    // 余量三件套必须用条件组里的片段做 FILTER, 不许另写谓词
    expect(src).toMatch(/count\(\*\) FILTER \(WHERE \$\{c\.verified\}\)/);
    expect(src).toMatch(/count\(\*\) FILTER \(WHERE \$\{c\.verified\} AND \$\{c\.fresh\}\)/);
    expect(src).toMatch(/\.where\(c\.active\)/);
    // 🚫 期刊表不许按租户过滤(共享参考数据) —— 加了就比选刊器的池子小, 又是个假数
    expect(src).not.toMatch(/journalVisibleTo/);
  });
});

describe("③ 不扩散: 全仓不许再出现自拼的冷却条件", () => {
  /** 每条白名单都要写清为什么。加白名单前先问一句: 你是不是在造第二套判据? */
  const ALLOWED = new Map<string, string>([
    ["services/journals/journal-sql.ts", "冷却条件的定义处(单一真相源)"],
    [
      "services/content-engine/roundup-generator.ts",
      "多刊盘点(roundup)是另一条产线: 一次取 3 本刊、不走 scope/verified 分层, 与选刊器不是同一个池子概念。" +
      "有专门的结构守卫(pr-journal-rotation-cooldown-fixes.test.ts)盯着它的 NOT EXISTS 不被删。待下一轮一并收编。",
    ],
  ]);

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist" || e === "__tests__" || e === "scripts") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (e.endsWith(".ts")) out.push(p);
    }
    return out;
  };

  it("裸写 `journal_usage … used_at > NOW() - make_interval` 的地方只剩白名单", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(f, "utf8");
      // 认的是"手写 journal_usage 别名 + 时间窗"这个形状(自拼冷却条件的招牌动作);
      // 走 drizzle 列引用的统计窗口(如盘点的近 N 天用量)不在此列 —— 那不是冷却判据。
      if (/(ju|journal_usage)\.used_at\s*>\s*NOW\(\)\s*-\s*make_interval/.test(src)) offenders.push(rel);
    }
    expect(offenders, `这些文件在自己拼期刊冷却条件, 请改用 journalFreshForTenant(): ${offenders.join(", ")}`)
      .toEqual([]);
  });
});
