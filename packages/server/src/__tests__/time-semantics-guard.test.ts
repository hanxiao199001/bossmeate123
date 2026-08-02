import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

/**
 * 时间语义扫描守卫 (2026-08-02)。
 *
 * ════════ 三条实测规则(本项目最容易被推理错的知识, 别再靠猜) ════════
 *
 * 前提: 库里 `created_at` **类型不统一** —— 46 张表是 `timestamp without time zone`
 *   (NAIVE, 存的是 UTC 值), 40 张是 `timestamp with time zone`(TZ); 还有 7 张表**同表混用**
 *   (contents.created_at 是 NAIVE 而 status_updated_at 是 TZ)。
 *   服务器 Node 的 `process.env.TZ` **未设置**, 靠 OS 恰好是 CST → 本地时区 = Asia/Shanghai。
 *
 * 在生产库上逐条实测(同一个边界 2026-08-01T16:00Z = BJ 08-02 00:00, 期望 28 条):
 *
 *   | 写法                              | NAIVE 列   | TZ 列 |
 *   |-----------------------------------|-----------|-------|
 *   | drizzle 类型化 `gte(col, Date)`    | 28  ✅     | ✅    |  ← drizzle 用 toISOString() 发 UTC
 *   | 裸 sql 模板插 `${jsDate}`          | **0** 🔴  | ✅    |  ← node-pg 按**本地时区**序列化,
 *   |                                   |           |       |    实测发出 `...T00:00:00.000+08:00`,
 *   |                                   |           |       |    转 NAIVE 时偏移被丢弃 → 差 8 小时
 *   | `AT TIME ZONE 'Asia/Shanghai'`     | **0** 🔴  | —     |  ← 把 UTC 值当 BJ 再转一次, **方向相反**
 *   | `+ interval '8 hours'`             | ✅        | ✅    |  ← 两类恰好都成立(session TZ = UTC)
 *
 * 结论: **优先用 drizzle 类型化比较**(两类列都对, 不用记表是哪种);
 *   非要写裸 SQL 就用 `+ interval '8 hours'`, 绝不用 `AT TIME ZONE 'Asia/Shanghai'`。
 *
 * ════════ 这个守卫锁什么 ════════
 *
 * 只锁"有没有出现已知会错的写法", 不去比对具体数字(要连 DB 且每天都变)。
 * 命中的新写法必须**要么改对, 要么进白名单并写清为什么对** —— 白名单不写理由等于没有守卫。
 *
 * 代价背景(为什么值得立这条): 8-02 盘点实测, 效果看板 94%(562/600) 的内容被标错天;
 * 未核实期刊的日配额闸窗口偏成 BJ 08:00→08:00, 实测"今日已用"算出 0 而真实是 30。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/** 递归收集 src 下所有 .ts(跳过测试与声明文件) */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) collectTs(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const FILES = collectTs(SRC).map((p) => ({ path: p, rel: relative(SRC, p), src: readFileSync(p, "utf8") }));

/**
 * 白名单: `文件相对路径` → 为什么这里是对的。
 * **加白名单必须写理由**, 且理由要能被复核(说清列是哪种类型、这个写法在该类型上为何成立)。
 */
const ALLOW: Record<string, string> = {
  "services/ops/daily-briefing.ts":
    "用的是 `+ interval '8 hours'` 而非 AT TIME ZONE —— 该写法对 NAIVE(contents) 与 TZ(content_publish_log) 两类列都正确(见文件头实测表)",
};

/** 命中行里出现这些字样视为注释/文档, 不算违规(本守卫自己的文件头、以及代码里的解释性注释) */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

interface Hit { rel: string; line: number; text: string }

function scan(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const f of FILES) {
    const lines = f.src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isCommentLine(line)) continue;
      if (pattern.test(line)) hits.push({ rel: f.rel, line: i + 1, text: line.trim().slice(0, 120) });
    }
  }
  return hits;
}

const fmt = (hits: Hit[]) => hits.map((h) => `\n  ${h.rel}:${h.line}  ${h.text}`).join("");

describe("时间语义守卫: 禁止已知会错的写法", () => {
  it("🔴 禁止 AT TIME ZONE 'Asia/Shanghai' —— 对 NAIVE 列方向相反(8-02 因此误判两次)", () => {
    const hits = scan(/at\s+time\s+zone\s+'Asia\/Shanghai'/i).filter((h) => !ALLOW[h.rel]);
    expect(
      hits,
      `发现 ${hits.length} 处。NAIVE 列(46 张表)上这个写法会把 UTC 值当 BJ 再转一次, 差 8 小时。` +
      `改用 drizzle 类型化比较, 或 \`+ interval '8 hours'\`。确实正确请加进 ALLOW 并写明理由。${fmt(hits)}`,
    ).toEqual([]);
  });

  it("🔴 禁止裸 to_char/DATE()/date_trunc 直接作用于时间列 —— 拿到的是 UTC 日不是北京日", () => {
    // 只查"里面套了时间列引用"的那种: to_char(xxx.createdAt / created_at ...
    const pattern = /\b(to_char|date_trunc|DATE)\s*\(\s*[^)]*(createdAt|created_at|usedAt|used_at|updatedAt|updated_at|publishedAt|published_at)/;
    const hits = scan(pattern).filter((h) => {
      if (ALLOW[h.rel]) return false;
      // `+ interval '8 hours'` 是已验证正确的转换, 放行
      if (/interval\s+'8\s+hours?'/.test(h.text)) return false;
      return true;
    });
    expect(
      hits,
      `发现 ${hits.length} 处。NAIVE 列存的是 UTC, 裸取日期得到 UTC 日 —— 生成跑在 BJ 03:00(=UTC 前一天 19:00), ` +
      `实测 94%(562/600) 的内容会被标成前一天。改用 \`+ interval '8 hours'\` 或在 JS 侧用 startOfBjDay()。${fmt(hits)}`,
    ).toEqual([]);
  });

  it("🔴 禁止用 setHours(0,0,0,0) 造日界 —— 它取的是 Node 进程本地时区, 而 TZ 未设置", () => {
    const hits = scan(/setHours\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/).filter((h) => !ALLOW[h.rel]);
    expect(
      hits,
      `发现 ${hits.length} 处。服务器 process.env.TZ 未设置, 靠 OS 恰好是 CST 才等于北京零点 —— ` +
      `换 Docker 镜像/迁机器/CI 里跑, 立刻偏 8 小时。全系统统一用 startOfBjDay()。${fmt(hits)}`,
    ).toEqual([]);
  });
});

describe("时间语义守卫: 唯一口径出口", () => {
  it("startOfBjDay 只有一处实现(别再各写各的)", () => {
    const impls = FILES.filter((f) => /export\s+function\s+startOfBjDay/.test(f.src));
    expect(impls.map((f) => f.rel)).toEqual(["services/metrics/matrix-health.ts"]);
  });

  it("startOfBjDay 的注释里写明了它是全系统唯一口径(免得下一个人又造一个)", () => {
    const f = FILES.find((x) => x.rel === "services/metrics/matrix-health.ts")!;
    expect(f.src).toMatch(/唯一/);
  });
});
