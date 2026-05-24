/**
 * 5-23 PR #221 — jcarindex 顺手回填真封面.
 * getJournalList 返回 cover 文件名, URL = https://www.jcarindex.com/cover/journal_image/<cover>.
 * 仅当 DB coverImageUrl 为 NULL 才填; 失效 URL 发布时回退 PR #220 标题兜底, 无需逐个验证.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SCRIPT = "../scripts/scrape-jcar-car.ts";

describe("PR #221: jcarindex 封面回填", () => {
  it("封面前缀常量正确", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/JCAR_COVER_BASE = `\$\{BASE\}\/cover\/journal_image\/`/);
  });
  it("JcarRecord 取 cover 文件名", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/cover\?: string \| null;/);
  });
  it("仅 NULL 才填 + 校验图片扩展名 + 拼前缀 + source=jcarindex", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/if \(!j\.coverImageUrl && \/\\\.\(jpg\|jpeg\|png\|webp\|gif\)\$\/i\.test\(cover\)\)/);
    expect(src).toMatch(/coverImageUrl: `\$\{JCAR_COVER_BASE\}\$\{cover\}`/);
    expect(src).toMatch(/coverImageSource: "jcarindex"/);
  });
  it("targets 查出 coverImageUrl 判 NULL", async () => {
    const src = await readSrc(SCRIPT);
    expect(src).toMatch(/coverImageUrl: journals\.coverImageUrl/);
  });
});
