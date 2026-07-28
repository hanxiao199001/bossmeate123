/**
 * 平台特性收单表 —— 一致性 + **全量扫描**回归锁 (7-28 阶段1-B)。
 *
 * ## 病根(同一个知识被抄了 30 次)
 * 「这个平台是什么样的」原本散在服务端 17 处 + 前端 13 处。已经漂出来两处实据:
 *   - `AGENT_PLATFORMS`  —— agent-dispatch.ts 定义一份, publish-pacing.ts 又原样抄一份且从不 import。
 *     两份现在恰好相等纯属运气: 任一边加平台, 另一边的错峰限频就会把新平台当公众号走 3 秒线性节流,
 *     那正是 6-22 记录的"一秒批量齐发触发抖音短信墙"事故的成因。
 *   - `SEMI_AUTO_PLATFORMS` —— routes/accounts.ts **同一个文件里写了两遍**(:207 建号 / :409 重新验证)。
 *     两处一旦不同, 就会出现"建号时算就绪、点重新验证就变验证失败"的鬼故事。
 *
 * ## 三道锁
 * 1. **前后端逐字段一致** —— 前端不共享后端包(理由见 apps/web/src/utils/platforms.ts 文件头),
 *    所以镜像允许存在, 但漂移不允许: 逐平台逐字段比对。
 * 2. **行为表由表校验** —— adapters / 扫码登录配置 / 推草稿函数这些含行为的 map 用
 *    `definePlatformMap()` 在模块加载时断言 key 集合, 这里再复测一次它确实会抛。
 * 3. **全量扫描** —— 扫 packages/server/src 与 apps/web/src 的全部源码,
 *    白名单之外不许出现"一处出现 ≥2 个平台字面量"的硬编码数组/Set/Record/switch。
 *    单点测试守不住"下一个人在第 31 个地方抄第 31 次"。**第 3 条才是防复发的关键。**
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

import {
  PLATFORM_CAPABILITIES,
  PLATFORM_IDS,
  AGENT_PLATFORMS,
  VIDEO_PLATFORMS,
  ARTICLE_PLATFORMS,
  SEMI_AUTO_PLATFORMS,
  PLATFORM_ALIAS_MAP,
  definePlatformMap,
  platformLabel,
  platformShortLabel,
} from "../services/platforms/capabilities.js";
// 7-28: 前端表**运行时**动态加载 —— 不能用静态 import。
// 原因: server 的 tsconfig rootDir=packages/server/src, 静态 import 跨包会 TS6059。
// 用变量拼路径 + pathToFileURL, tsc 无法静态解析故不检查, vitest 运行时能转译 TS 加载。
let WEB_PLATFORM_CAPABILITIES: Record<string, Record<string, unknown>> = {};
let WEB_PLATFORM_IDS: readonly string[] = [];

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, "..");
const REPO_ROOT = resolve(HERE, "../../../..");
const WEB_SRC = resolve(REPO_ROOT, "apps/web/src");

// ─────────────────────────────────────────────────────────────
// 1. 表本身自洽
// ─────────────────────────────────────────────────────────────
describe("PLATFORM_CAPABILITIES 自洽", () => {
  it("每条记录的 id 与 key 一致", () => {
    for (const [key, cap] of Object.entries(PLATFORM_CAPABILITIES)) {
      expect(cap.id, `key=${key} 的 id 字段写错了`).toBe(key);
    }
  });

  it("派生集合互不打架: video ∪ article = 全集, 且不相交", () => {
    expect([...VIDEO_PLATFORMS, ...ARTICLE_PLATFORMS].sort()).toEqual([...PLATFORM_IDS].sort());
    expect([...VIDEO_PLATFORMS].filter((p) => ARTICLE_PLATFORMS.has(p))).toEqual([]);
  });

  it("publishVia=agent 的平台必须能推草稿(否则派单出去无人能执行)", () => {
    for (const p of AGENT_PLATFORMS) {
      expect(PLATFORM_CAPABILITIES[p]!.supportsDraftPush, `${p} 派单给 Agent 却没有推草稿实现`).toBe(true);
    }
  });

  it("支持推草稿的平台必须有 creatorOrigin(注入 localStorage 要先停在该域)", () => {
    for (const p of PLATFORM_IDS) {
      const c = PLATFORM_CAPABILITIES[p]!;
      if (c.supportsDraftPush) expect(c.creatorOrigin, `${p} 缺 creatorOrigin`).toBeTruthy();
    }
  });

  it("别名不重复(一个中文词只能映射到一个平台)", () => {
    const all = PLATFORM_IDS.flatMap((p) => PLATFORM_CAPABILITIES[p]!.aliases);
    expect(all.length, `别名有重复: ${all.join(",")}`).toBe(new Set(all).size);
    expect(PLATFORM_ALIAS_MAP["公众号"]).toBe("wechat");
    expect(PLATFORM_ALIAS_MAP["红书"]).toBe("xiaohongshu");
  });

  it("label/shortLabel helper 对未知平台原样返回(不能把未知平台伪装成已知平台)", () => {
    expect(platformLabel("kuaishou")).toBe("kuaishou");
    expect(platformShortLabel("kuaishou")).toBe("kuaishou");
    expect(platformShortLabel("wechat")).toBe("公众号");
    expect(platformLabel("wechat")).toBe("微信公众号");
  });
});

// ─────────────────────────────────────────────────────────────
// 2. 前后端镜像逐字段一致
// ─────────────────────────────────────────────────────────────
describe("前后端平台表一致(apps/web/src/utils/platforms.ts 是后端表的受检投影)", () => {
  /** 前端只镜像了它真正用得到的维度; 后端独有的维度(风控词典/排期时刻等)不参与比对 */
  const MIRRORED_FIELDS = [
    "id",
    "label",
    "shortLabel",
    "icon",
    "color",
    "contentKind",
    "publishVia",
    "semiAuto",
    "browserLogin",
    "credentialHint",
  ] as const;

  const HOWTO =
    "\n\n修法: 改 packages/server/src/services/platforms/capabilities.ts 后, 同步改 apps/web/src/utils/platforms.ts。" +
    "\n(为什么不共享一份: 见 apps/web/src/utils/platforms.ts 文件头 —— shared 包没有 build, server 是 tsc→dist 跑的)";

  beforeAll(async () => {
    // 变量拼路径, tsc 静态分析不到 → 不触发 TS6059 跨 rootDir; vitest 运行时转译 TS 加载
    const webPlatformsPath = resolve(WEB_SRC, "utils/platforms.ts");
    const mod = (await import(pathToFileURL(webPlatformsPath).href)) as {
      PLATFORM_CAPABILITIES: Record<string, Record<string, unknown>>;
      PLATFORM_IDS: readonly string[];
    };
    WEB_PLATFORM_CAPABILITIES = mod.PLATFORM_CAPABILITIES;
    WEB_PLATFORM_IDS = mod.PLATFORM_IDS;
  });

  it("平台 id 列表与顺序完全一致", () => {
    expect([...WEB_PLATFORM_IDS], "前后端平台列表不一致" + HOWTO).toEqual([...PLATFORM_IDS]);
  });

  it("镜像字段逐平台逐字段一致", () => {
    const diffs: string[] = [];
    for (const id of PLATFORM_IDS) {
      const s = PLATFORM_CAPABILITIES[id]!;
      const w = WEB_PLATFORM_CAPABILITIES[id];
      if (!w) { diffs.push(`${id}: 前端缺这个平台`); continue; }
      for (const f of MIRRORED_FIELDS) {
        if ((s as any)[f] !== (w as any)[f]) {
          diffs.push(`${id}.${f}: 后端=${JSON.stringify((s as any)[f])} 前端=${JSON.stringify((w as any)[f])}`);
        }
      }
    }
    expect(diffs, "前后端平台表漂了" + HOWTO).toEqual([]);
  });

  it("凭证字段表一致(前端渲染表单 / 后端 /accounts/platforms 吐同一份)", () => {
    const diffs: string[] = [];
    for (const id of PLATFORM_IDS) {
      const s = JSON.stringify(PLATFORM_CAPABILITIES[id]!.credentialFields);
      const w = JSON.stringify(WEB_PLATFORM_CAPABILITIES[id]?.credentialFields ?? null);
      if (s !== w) diffs.push(`${id}.credentialFields:\n  后端 ${s}\n  前端 ${w}`);
    }
    expect(diffs, "凭证字段表漂了" + HOWTO).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. definePlatformMap 真的会拦
// ─────────────────────────────────────────────────────────────
describe("definePlatformMap 行为(行为表 key 集合由表校验)", () => {
  it("键齐全时原样返回", () => {
    const m = definePlatformMap<string>("supportsDraftPush", { douyin: "a", wechat_video: "b" });
    expect(m).toEqual({ douyin: "a", wechat_video: "b" });
  });

  it("漏键 → 抛错(否则该平台会静默走不到)", () => {
    expect(() => definePlatformMap<string>("supportsDraftPush", { douyin: "a" }))
      .toThrow(/缺 \[wechat_video\]/);
  });

  it("多键 → 抛错(表和实现打架)", () => {
    expect(() =>
      definePlatformMap<string>("supportsDraftPush", { douyin: "a", wechat_video: "b", zhihu: "c" }),
    ).toThrow(/多 \[zhihu\]/);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. 全量扫描: 白名单外不许硬编码平台字面量组
// ─────────────────────────────────────────────────────────────

/**
 * 白名单。key = 相对仓库根的路径, value = [允许命中的窗口数, 理由]。
 * 次数写死是刻意的 —— 同一个文件里新加一处也会红, 逼你说明为什么。
 */
const ALLOWLIST: Record<string, [number, string]> = {
  "packages/server/src/services/platforms/capabilities.ts": [
    999,
    "收单表本身 —— 这就是唯一定义所在。",
  ],
  "apps/web/src/utils/platforms.ts": [
    999,
    "前端镜像 —— 由上面的『前后端平台表一致』逐字段守着, 不会自己漂。",
  ],
  "packages/server/src/services/risk-control/dictionaries/index.ts": [
    1,
    "词库 key → 词表的映射表(DICTIONARIES)。归属关系已在 capabilities.riskDictionaries, 这里只是把 key 接到具体词表模块。",
  ],
  "packages/server/src/services/publisher/browser-session.ts": [
    2,
    "扫码登录的行为配置(含 puppeteer 判定函数, 不能进纯数据表)。key 集合由 definePlatformMap('browserLogin') 在加载时断言。",
  ],
  "packages/server/src/services/publisher/draft-push.ts": [
    2,
    "推草稿的行为实现(PLATFORM_PUSHERS + 抖音/视频号各自的 puppeteer 流程)。key 集合由 definePlatformMap('supportsDraftPush') 断言。",
  ],
  "packages/server/src/services/publisher/index.ts": [
    1,
    "适配器实例注册表。key 集合由 definePlatformMap('hasAdapter') 断言。",
  ],
  "packages/server/src/services/publisher/douyin-caption.ts": [
    12,
    "抖音/视频号文案生成器: 每个平台的 prompt/风格/字段名天然不同, 是真正的平台专属实现而非判据复制。" +
      "其平台集合由类型 VideoPlatform 约束, 且只被 draft-push/agent 链路调用。",
  ],
  "packages/server/src/services/publisher/adapters/xiaohongshu.ts": [
    99,
    "单平台适配器实现。",
  ],
  "packages/server/src/models/migrations.ts": [
    99,
    "迁移 SQL 里的平台枚举值 —— 迁移是不可变历史, 不能跟着表改(改了会让已跑过的迁移与线上不一致)。",
  ],
  "packages/server/src/services/crawler/index.ts": [
    99,
    "**爬虫数据源**注册表(百度/微博/知乎热榜等), 与『发布平台』是两个不同的概念域 —— " +
      "同名不同物, 收口到发布平台表反而是错的。见 apps/web/src/utils/i18n.ts 里对 KeywordsPage 的同一条说明。",
  ],
  "packages/server/src/services/crawler/types.ts": [
    99,
    "同上: PlatformName 是爬虫数据源枚举(含 weibo/baidu, 系统从不往那两个发内容)。",
  ],
  "packages/server/src/services/knowledge/cold-start.ts": [
    99,
    "同上: 冷启动默认**抓取**哪些来源, 不是发布目标。",
  ],
  "packages/server/src/scripts/seed-hanxiao-accounts.ts": [
    99,
    "一次性种子脚本(不在运行链路上)。",
  ],
  "apps/web/src/pages/ContentDetailPage.tsx": [
    1,
    'captionPlatform 的 useState 类型标注 `"douyin" | "wechat_video"` —— 与 douyin-caption 的 VideoPlatform 对齐的类型位置, 不是判据。',
  ],
};

const SCAN_ROOTS: Array<{ dir: string; exts: string[] }> = [
  { dir: resolve(REPO_ROOT, "packages/server/src"), exts: [".ts"] },
  { dir: WEB_SRC, exts: [".ts", ".tsx"] },
];

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e)) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) out.push(p);
  }
  return out;
}

/** 去掉整行注释(注释里举例列平台是说明, 不算病) */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      return l;
    })
    .join("\n");
}

/** 平台字面量(带引号), 用于扫描 */
const LITERAL_RE = new RegExp(`["'](${PLATFORM_IDS.join("|")})["']`, "g");
/** 一处硬编码 = 240 字符窗口内出现 ≥2 个**不同**平台字面量 */
const WINDOW = 240;

interface Hit { file: string; line: number; platforms: string[]; snippet: string }

function scanHits(): Hit[] {
  const hits: Hit[] = [];
  for (const { dir, exts } of SCAN_ROOTS) {
    for (const file of walk(dir, exts)) {
      const code = stripLineComments(readFileSync(file, "utf8"));
      const matches = [...code.matchAll(LITERAL_RE)];
      let i = 0;
      while (i < matches.length) {
        const start = matches[i]!.index!;
        const group = [matches[i]!];
        let j = i + 1;
        while (j < matches.length && matches[j]!.index! - start < WINDOW) group.push(matches[j++]!);
        const distinct = [...new Set(group.map((m) => m[1]!))];
        if (distinct.length >= 2) {
          hits.push({
            file: relative(REPO_ROOT, file).replace(/\\/g, "/"),
            line: code.slice(0, start).split("\n").length,
            platforms: distinct,
            snippet: code.slice(start, start + 120).replace(/\s+/g, " "),
          });
          i = j; // 整窗算一处, 不重复计数
        } else {
          i += 1;
        }
      }
    }
  }
  return hits;
}

const SCAN_HOWTO =
  "\n\n修法: 用 services/platforms/capabilities.ts(前端 utils/platforms.ts)的常量/helper 代替字面量 —" +
  "\n  路由判据 → AGENT_PLATFORMS / VIDEO_PLATFORMS / ARTICLE_PLATFORMS / SEMI_AUTO_PLATFORMS" +
  "\n  显示 → platformLabel / platformShortLabel / platformIcon" +
  "\n  含行为的 map(适配器/登录配置/推草稿函数) → definePlatformMap(维度, {...}) 并把文件加进本测试 ALLOWLIST 写清理由。" +
  "\n背景: 这个知识原本被抄了 30 次, AGENT_PLATFORMS 与 SEMI_AUTO_PLATFORMS 已经各漂出第二份。";

describe("平台特性 — 全量扫描(packages/server/src + apps/web/src)", () => {
  const hits = scanHits();

  it("白名单之外不许出现硬编码平台字面量组", () => {
    const offenders = hits.filter((h) => !(h.file in ALLOWLIST));
    expect(
      offenders.map((h) => `${h.file}:${h.line}  [${h.platforms.join(",")}]  ${h.snippet}`),
      "发现新的硬编码平台判据" + SCAN_HOWTO,
    ).toEqual([]);
  });

  it("白名单文件里的出现次数不许变多", () => {
    for (const [file, [expected, reason]] of Object.entries(ALLOWLIST)) {
      const n = hits.filter((h) => h.file === file).length;
      expect(n, `${file} 期望 ≤${expected} 处(${reason}), 实际 ${n} 处。` + SCAN_HOWTO).toBeLessThanOrEqual(expected);
    }
  });

  it("扫描器本身有效: 人为构造的违规能被认出来", () => {
    // 复刻扫描逻辑跑在一段伪代码上, 确认它不是永远返回空
    const fake = 'const AGENT_PLATFORMS = new Set(["douyin", "wechat_video"]);';
    const distinct = [...new Set([...fake.matchAll(LITERAL_RE)].map((m) => m[1]!))];
    expect(distinct.length).toBeGreaterThanOrEqual(2);
    // 而单平台的正当写法不该被认成违规
    const ok = 'if (account.platform === "douyin") { /* 抖音专属合规开关 */ }';
    expect([...new Set([...ok.matchAll(LITERAL_RE)].map((m) => m[1]!))].length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. 已漂的两处点名回归(防有人改回去)
// ─────────────────────────────────────────────────────────────
describe("两处已发生的漂移: 全仓只能有一处定义", () => {
  function countDefs(pattern: RegExp): Array<{ file: string; line: number }> {
    const out: Array<{ file: string; line: number }> = [];
    for (const { dir, exts } of SCAN_ROOTS) {
      for (const file of walk(dir, exts)) {
        const code = stripLineComments(readFileSync(file, "utf8"));
        for (const m of code.matchAll(pattern)) {
          out.push({ file: relative(REPO_ROOT, file).replace(/\\/g, "/"), line: code.slice(0, m.index).split("\n").length });
        }
      }
    }
    return out;
  }

  it("AGENT_PLATFORMS 只在 capabilities 表里定义(前端镜像各一处)", () => {
    const defs = countDefs(/(?:const|let|var)\s+AGENT_PLATFORMS\s*[:=]/g);
    expect(defs.map((d) => d.file).sort()).toEqual([
      "apps/web/src/utils/platforms.ts",
      "packages/server/src/services/platforms/capabilities.ts",
    ]);
  });

  it("SEMI_AUTO_PLATFORMS 只在 capabilities 表里定义(routes/accounts.ts 曾同文件写两遍)", () => {
    const defs = countDefs(/(?:const|let|var)\s+SEMI_AUTO_PLATFORMS\s*[:=]/g);
    expect(defs.map((d) => d.file).sort()).toEqual([
      "apps/web/src/utils/platforms.ts",
      "packages/server/src/services/platforms/capabilities.ts",
    ]);
  });

  it("VIDEO_PLATFORMS / ARTICLE_PLATFORMS 同样只有一处定义", () => {
    for (const name of ["VIDEO_PLATFORMS", "ARTICLE_PLATFORMS"]) {
      const defs = countDefs(new RegExp(`(?:const|let|var)\\s+${name}\\s*[:=]`, "g"));
      expect(defs.map((d) => d.file).sort(), `${name} 又被复制了`).toEqual([
        "apps/web/src/utils/platforms.ts",
        "packages/server/src/services/platforms/capabilities.ts",
      ]);
    }
  });

  it("错峰限频(publish-pacing)与派单(agent-dispatch)用的是同一个判据", () => {
    const pacing = readFileSync(join(SERVER_SRC, "services/publisher/publish-pacing.ts"), "utf8");
    expect(pacing, "publish-pacing 必须 import 共用的 AGENT_PLATFORMS, 不许自建").toMatch(
      /import\s*\{[^}]*AGENT_PLATFORMS[^}]*\}\s*from\s*"\.\.\/platforms\/capabilities\.js"/,
    );
    // 剥掉注释再查 —— 文件头的事故复盘里就引用了旧写法当反例
    expect(stripLineComments(pacing)).not.toMatch(/new Set\(\s*\["douyin"/);
  });

  it("SEMI_AUTO 判据: routes/accounts.ts 两处都改用共用常量", () => {
    const src = readFileSync(join(SERVER_SRC, "routes/accounts.ts"), "utf8");
    expect((src.match(/SEMI_AUTO_PLATFORMS\.has\(/g) ?? []).length, "两处半自动判定都要在").toBe(2);
    expect(src).toMatch(/import\s*\{[^}]*SEMI_AUTO_PLATFORMS/s);
    expect(src, "不许再本地 new Set 一份").not.toMatch(/const\s+SEMI_AUTO_PLATFORMS/);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. 判据的真行为(不是源码正则)
// ─────────────────────────────────────────────────────────────
describe("判据真行为", () => {
  it("视频只往视频平台发, 图文只往图文平台发", () => {
    expect([...VIDEO_PLATFORMS].sort()).toEqual(["douyin", "wechat_video"]);
    expect([...ARTICLE_PLATFORMS].sort()).toEqual(
      ["baijiahao", "toutiao", "wechat", "xiaohongshu", "zhihu"],
    );
  });

  it("半自动 ⊋ Agent 平台: 小红书是半自动但没有 Agent 推草稿实现", () => {
    for (const p of AGENT_PLATFORMS) expect(SEMI_AUTO_PLATFORMS.has(p), `${p} 应算半自动`).toBe(true);
    expect(SEMI_AUTO_PLATFORMS.has("xiaohongshu")).toBe(true);
    expect(AGENT_PLATFORMS.has("xiaohongshu")).toBe(false);
  });

  it("风控词典归属: 视频号 = wechat 底线 + 自身专有", () => {
    expect([...PLATFORM_CAPABILITIES.wechat_video!.riskDictionaries]).toEqual(["wechat", "wechat_video"]);
    expect([...PLATFORM_CAPABILITIES.douyin!.riskDictionaries]).toEqual(["douyin"]);
    expect([...PLATFORM_CAPABILITIES.zhihu!.riskDictionaries]).toEqual([]);
  });
});
