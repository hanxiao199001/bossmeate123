/**
 * 共享期刊池 tenant 口径 —— **全量扫描**回归锁 (7-28)。
 *
 * ## 病根(同一个病已经犯了 13 次)
 * 线上 8743 本期刊的 `tenant_id` 是 **NULL** —— 它们是全局共享参考数据, 只有租户自建刊才带
 * tenant_id。SQL 里 `NULL = 'uuid'` 求值为 NULL(既不真也不假), 所以 `eq(journals.tenantId, x)`
 * 会把**整个共享池排除**, 对任何租户都静默返回 0 条。不报错、不告警, 只是"什么都没有"。
 *
 * 7-25 修了 routes/journals.ts 的 4 处并加了 `journals-tenant-shared-pool.test.ts` —— 但那个
 * 测试**只 readFileSync 一个文件**, 所以它绿着的同时, 同一个病在另外 9 处读路径继续活着:
 *   routes/topic.ts ×3(选题工坊对共享池刊恒 404) / services/skills/video-skill.ts ×3
 *   (generateForJournal 恒返回 null → 静默不产视频) / journal-heat-matcher.ts(热点匹配恒空) /
 *   topic-recommender.ts(第一轮恒空, 且 fallback 反向越界: 完全不带 tenant 条件查全库) /
 *   routes/workflow.ts(事实核查查不到共享池刊) / journal-cover-prefetch.ts ×2(封面预取恒空) /
 *   services/agents/orchestrator.ts(视频关联期刊匹配不到) / domain-knowledge-collector.ts /
 *   article-skill.ts(**写路径**: 去重恒不命中 → 每个租户各插一条同名 ai_fabricated 影子刊)。
 *
 * ## 所以这个测试改成扫全量 src/**\/*.ts
 * 单文件扫描守不住"下一个人在第 14 个文件里写第 14 次"。**这一条才是防复发的关键。**
 *
 * ## 判定规则
 * 出现 `eq(journals.tenantId, …)` 时:
 *   - 附近(±180 字符)有 `isNull(journals.tenantId)` → 读放宽的标准写法, 放行;
 *   - 否则必须落在下面的 ALLOWLIST 里(全是**写路径**, 严格租户隔离是对的);
 *   - 都不是 → 红。首选修法: 用 `services/journals/journal-sql.ts` 的 `journalVisibleTo(tenantId)`。
 *
 * **铁律: 读放宽(共享池 + 自有刊), 写严格(只认自己的刊)。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/**
 * 白名单: 允许**严格租户相等**的写路径。key = 相对 src 的路径, value = [允许出现次数, 理由]。
 * 次数写死是刻意的 —— 同一个文件里新加一处也会红, 逼你说明为什么。
 */
const ALLOWLIST: Record<string, [number, string]> = {
  "routes/journals.ts": [
    4,
    "写路径: POST /journals/seed(×2: 计数+查重名, 只能种自己的刊) / POST /journals/:id/enrich / POST /journals/enrich-all。" +
      "共享池的富化走 `pnpm journals:reenrich` 脚本, 不走租户 API。",
  ],
};
// 注: helper 自身(services/journals/journal-sql.ts)不在白名单里也不会红 —— journalOwnedBy 的
//   严格相等紧挨着 journalVisibleTo 的 isNull, 落在 ±180 字符窗口内被认成标准写法。
//   它的严格性由下方"写口径 helper 存在且是严格相等"那条单独盯着。

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 去掉整行注释(注释里提旧写法是历史说明, 不算病) */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const EQ_TENANT = /eq\(\s*journals\.tenantId\s*,/g;

interface Hit { file: string; line: number; snippet: string }

function scanBareHits(): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(SRC)) {
    const code = stripLineComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(EQ_TENANT)) {
      const window = code.slice(Math.max(0, m.index - 180), m.index + 180);
      if (window.includes("isNull(journals.tenantId)")) continue; // or(isNull, eq) 标准读写法
      hits.push({
        file: relative(SRC, file).replace(/\\/g, "/"),
        line: code.slice(0, m.index).split("\n").length,
        snippet: code.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, " "),
      });
    }
  }
  return hits;
}

const HOWTO =
  "\n\n修法: 读路径改用 services/journals/journal-sql.ts 的 journalVisibleTo(tenantId)" +
  "(= or(isNull(journals.tenantId), eq(journals.tenantId, tenantId)));" +
  "\n确属写路径(只该动自己的刊)就用 journalOwnedBy(tenantId), 并把文件加进本测试的 ALLOWLIST 并写清理由。" +
  "\n背景: 共享池 8743 本刊 tenant_id 为 NULL, `NULL = uuid` 恒不成立 → 严格相等 = 静默返回 0 条。";

describe("共享期刊池 tenant 口径 — 全量扫描(src/**/*.ts)", () => {
  const hits = scanBareHits();

  it("白名单之外不许出现裸 eq(journals.tenantId, …)", () => {
    const offenders = hits.filter((h) => !(h.file in ALLOWLIST));
    expect(
      offenders.map((h) => `${h.file}:${h.line}  ${h.snippet}`),
      "发现新的严格租户相等(共享池会被静默排除)" + HOWTO,
    ).toEqual([]);
  });

  it("白名单文件里的出现次数不许变多(新加一处也要说明理由)", () => {
    for (const [file, [expected, reason]] of Object.entries(ALLOWLIST)) {
      const n = hits.filter((h) => h.file === file).length;
      expect(n, `${file} 期望 ${expected} 处严格相等(${reason}), 实际 ${n} 处。` + HOWTO).toBe(expected);
    }
  });

  it("13 处发病点已全部改用 helper(逐个文件点名, 防有人改回去)", () => {
    const FIXED: Array<[string, number]> = [
      ["routes/topic.ts", 3],
      ["services/skills/video-skill.ts", 3],
      ["services/content-engine/journal-heat-matcher.ts", 1],
      ["services/content-engine/topic-recommender.ts", 1],
      ["routes/workflow.ts", 1],
      ["services/crawler/journal-cover-prefetch.ts", 2],
      ["services/agents/orchestrator.ts", 1],
      ["services/data-collection/domain-knowledge-collector.ts", 1],
      ["services/skills/article-skill.ts", 1],
    ];
    for (const [file, n] of FIXED) {
      const src = readFileSync(join(SRC, file), "utf8");
      const used = (src.match(/journalVisibleTo\(/g) ?? []).length;
      expect(used, `${file} 应有 ${n} 处 journalVisibleTo(…), 实际 ${used} 处(含 import 行不计)`).toBeGreaterThanOrEqual(n);
      expect(hits.some((h) => h.file === file), `${file} 又出现裸严格相等`).toBe(false);
    }
  });

  it("topic-recommender 的反向越界 fallback(不带 tenant 条件查全库)已删除", () => {
    const src = readFileSync(join(SRC, "services/content-engine/topic-recommender.ts"), "utf8");
    expect(src).not.toMatch(/Fallback: 查全局期刊（跨租户）/);
    expect(src).toMatch(/journalVisibleTo\(tenantId\)/);
  });

  it("article-skill 的 persistAIJournal 去重: 共享池命中就不插影子刊, 也不改共享池行", () => {
    const src = readFileSync(join(SRC, "services/skills/article-skill.ts"), "utf8");
    const start = src.indexOf("async persistAIJournal");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 2000);
    expect(body).toMatch(/journalVisibleTo\(tenantId\)/);           // 查重能看见共享池
    expect(body).toMatch(/existing\.tenantId === null/);            // 命中共享池 → 直接 return
  });

  it("写口径 helper 存在且是严格相等(别哪天顺手把它也放宽了)", () => {
    const src = readFileSync(join(SRC, "services/journals/journal-sql.ts"), "utf8");
    const start = src.indexOf("export function journalOwnedBy");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 200);
    expect(body).toMatch(/return eq\(journals\.tenantId, tenantId\);/);
    expect(body).not.toMatch(/isNull/);
  });
});

/** 纯逻辑复刻: SQL 里 NULL 等不上任何 uuid —— 13 次犯病的共同根因 */
describe("根因复刻: NULL = uuid 恒不成立", () => {
  interface Row { id: string; tenantId: string | null }
  const POOL: Row[] = [
    { id: "shared-1", tenantId: null }, // 8743 本共享刊长这样
    { id: "shared-2", tenantId: null },
    { id: "own-1", tenantId: "t-a" },
    { id: "other-1", tenantId: "t-b" },
  ];
  const strictEq = (rows: Row[], t: string) => rows.filter((r) => r.tenantId === t);
  const visibleTo = (rows: Row[], t: string) => rows.filter((r) => r.tenantId === null || r.tenantId === t);

  it("严格相等: 共享池全丢(没自建刊的租户 → 彻底 0 条)", () => {
    expect(strictEq(POOL, "t-a").map((r) => r.id)).toEqual(["own-1"]);
    expect(strictEq(POOL, "t-new")).toEqual([]);
  });

  it("journalVisibleTo: 共享池 + 自有刊可见, 别家自建刊仍不可见", () => {
    expect(visibleTo(POOL, "t-a").map((r) => r.id)).toEqual(["shared-1", "shared-2", "own-1"]);
    expect(visibleTo(POOL, "t-a").some((r) => r.id === "other-1")).toBe(false);
  });
});
