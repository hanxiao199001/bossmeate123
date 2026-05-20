/**
 * 5-20 PR #187 — LetPub 主渠道扩池: 学科列表翻页爬虫. file-content regression.
 *   (爬虫依赖外部网络 + Scrapling, 无法单测实跑, 仅校验代码结构)
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #187: Python 列表翻页爬虫", () => {
  it("journal_scraper.py: crawl_letpub_category + 翻页 + 限速", async () => {
    const src = await readSrc("../../scripts/journal_scraper.py");
    expect(src).toMatch(/def crawl_letpub_category/);
    expect(src).toMatch(/def _parse_letpub_list/);
    expect(src).toMatch(/currentpage.*str\(page_num\)/);
    expect(src).toMatch(/time\.sleep\(throttle/);  // 限速
    expect(src).toMatch(/random\.uniform/);         // 抖动
  });
  it("journal_scraper.py: --list-category CLI dispatch", async () => {
    const src = await readSrc("../../scripts/journal_scraper.py");
    expect(src).toMatch(/--list-category/);
    expect(src).toMatch(/--max-pages/);
    expect(src).toMatch(/--throttle/);
  });
  it("journal_scraper.py: 空页/重复判停 (防无限翻页)", async () => {
    const src = await readSrc("../../scripts/journal_scraper.py");
    expect(src).toMatch(/seen_ids/);
    expect(src).toMatch(/if not new_items/);
  });
});

describe("PR #187: TS 桥接", () => {
  it("scrapling-bridge: crawlLetpubCategory 函数", async () => {
    const src = await readSrc("../services/crawler/scrapling-bridge.ts");
    expect(src).toMatch(/export function crawlLetpubCategory/);
    expect(src).toMatch(/--list-category/);
    expect(src).toMatch(/maxBuffer: 20 \* 1024 \* 1024/);  // 列表数据量大
  });
  it("scrapling-bridge: 失败返回 [] 不抛 (让 caller 续下个学科)", async () => {
    const src = await readSrc("../services/crawler/scrapling-bridge.ts");
    expect(src).toMatch(/resolve\(\[\]\)/);
  });
});

describe("PR #187: ingest 脚本", () => {
  it("ingest-letpub-pool: dedup + insert confidence 60 + 全局共享", async () => {
    const src = await readSrc("../scripts/ingest-letpub-pool.ts");
    expect(src).toMatch(/findExisting/);          // dedup
    expect(src).toMatch(/confidence: 60/);
    expect(src).toMatch(/tenantId: null/);        // 全局共享
    expect(src).toMatch(/source: "letpub-list"/);
  });
  it("ingest-letpub-pool: --enrich flag 触发交叉验证 + 限速", async () => {
    const src = await readSrc("../scripts/ingest-letpub-pool.ts");
    expect(src).toMatch(/opts\.enrich/);
    expect(src).toMatch(/enrichJournal\(insertedIds/);
    expect(src).toMatch(/setTimeout\(r, 3000\)/);  // 3s 限速
  });
  it("ingest-letpub-pool: 断点续爬 (已存在跳过)", async () => {
    const src = await readSrc("../scripts/ingest-letpub-pool.ts");
    expect(src).toMatch(/if \(existing\)/);
    expect(src).toMatch(/totalSkipped/);
  });
});
