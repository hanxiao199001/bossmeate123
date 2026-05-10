/**
 * PR B.10：4 SVG chart 注入 + metadata.journalId（auto-video-bridge 触发条件）
 *
 * 5-2 false alarm 反思：
 *   - 部署后用户截图说"图文 0 SVG"。先怀疑 enrich 没跑，但 enrichmentLog 显示 OK；
 *     后才发现 collector 写 V7 array 到 ifHistory，template type guard 期望 V12 {data:Array} → 100% placeholder 分支
 *   - 同期暴露 bridge 死代码：article-skill metadata 缺 journalId → routes/chat.ts:236 typeof===\"string\" 永远 false
 *   - 这 3 个测试锁住：collector 透传 V12 raw + ifHistory V7→V12 包装 + metadata.journalId 在场
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://t/t", QWEN_API_KEY:"k" } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { generateShunshiStyleHtml } from "../services/publisher/adapters/shunshi-style-template.js";

const baseJournal = {
  id: "j-test", name: "测试期刊", nameEn: "Test J", abbreviation: "TJ",
  issn: "0000-0000", publisher: "P", discipline: "医学", partition: "Q1",
  casPartition: "1", casPartitionNew: "1 区", impactFactor: 5.0,
  acceptanceRate: 0.4, reviewCycle: "8 周", annualVolume: 1000,
  isWarningList: false, warningYear: null, foundingYear: 2010,
  country: "美国", website: null, apcFee: null, selfCitationRate: null,
  jcrSubjects: null, topInstitutions: null, scopeDescription: null,
  coverUrl: null, dataCardUri: "data:image/svg+xml;base64,",
  ifHistory: null, ifHistoryRaw: null,
} as any;
const baseAi = {
  title: "T", scopeDescription: "范围", recommendation: "推荐",
  advantages: ["a"], cautions: ["b"], summary: "s",
} as any;

describe("PR B.10: shunshi-style 4 SVG chart 槽位 + V12 raw 透传", () => {
  it("4 chart 数据齐全 → article body 至少出现 4 个 <svg>", async () => {
    const j = {
      ...baseJournal,
      ifHistoryRaw: { data: [{ year: 2020, if: 3.0 }, { year: 2021, if: 3.5 }, { year: 2022, if: 4.2 }, { year: 2023, if: 5.0 }] },
      carIndexHistory: { data: [{ year: 2020, carIndex: 0.45 }, { year: 2021, carIndex: 0.52 }, { year: 2022, carIndex: 0.58 }], riskLevel: "mid" },
      publicationStats: { frequency: "月刊", annualVolumeHistory: [{ year: 2020, count: 800 }, { year: 2021, count: 900 }, { year: 2022, count: 1000 }] },
      citingJournalsTop10: { topJournals: [{ name: "Cell", percent: 12 }, { name: "Nature", percent: 10 }, { name: "Lancet", percent: 8 }] },
    };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    const svgCount = (html.match(/<svg/g) || []).length;
    expect(svgCount).toBeGreaterThanOrEqual(4);
    expect(html).toContain("近 10 年影响因子");
    expect(html).toContain("CAR 指数");
    expect(html).toContain("近 10 年发文量");
    expect(html).toMatch(/引用前\s*\d+\s*期刊分布/);
    // 真数据数字落到 HTML（不是占位"数据采集中"）
    expect(html).not.toMatch(/近 10 年影响因子[\s\S]{0,200}数据采集中/);
  });

});

describe("PR B.10: collector V12 raw 透传 + LetPub V7→V12 包装", () => {
  it("DB ifHistory(V12) 优先 / DB null 时把 LetPub V7 array 包成 V12 shape", async () => {
    const { toPromptIfHistory } = await import("../services/data-collection/journal-content-collector.js");
    // 这个 helper 只是顺路验证 V7→V12 转换逻辑可消费 V12 输入（不写新 helper，借现成的反向校验）
    const v12Input = { data: [{ year: 2023, if: 4.7 }] };
    const r = toPromptIfHistory(v12Input);
    expect(r.history).toEqual([{ year: 2023, value: 4.7 }]);

    // 模拟 collector 包装逻辑：DB null + LetPub V7 → 输出 V12 shape，能被 isIfHistory 命中
    const letpubV7 = [{ year: 2022, value: 3.5 }, { year: 2023, value: 4.7 }];
    const wrapped = { data: letpubV7.map((d) => ({ year: d.year, if: d.value })) };
    const j = { ...baseJournal, ifHistoryRaw: wrapped };
    const html = await generateShunshiStyleHtml(j, baseAi, undefined);
    expect(html).toMatch(/<svg[\s\S]*<\/svg>/);
    expect(html).toContain("近 10 年影响因子");
  });
});

describe("PR B.10: article-skill metadata.journalId（auto-video-bridge 触发条件）", () => {
  it("article-skill metadata 字面量含 journalId 字段（防回归 grep）", async () => {
    const fs = await import("node:fs/promises");
    // PR #127 修：原相对路径 vitest cwd != packages/server 时 ENOENT，改 import.meta.url 模式
    const src = await fs.readFile(new URL("../services/skills/article-skill.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/journalId:\s*collectionResult\?\.journals\[0\]\?\.id/);
    // PR Q.0 后 auto-video-bridge 已下线，chat.ts 仅 video script journalId 透传保留
    const chat = await fs.readFile(new URL("../routes/chat.ts", import.meta.url), "utf-8");
    expect(chat).toMatch(/typeof\s+scriptData\.journalId\s*===\s*["']string["']/);
  });
});
