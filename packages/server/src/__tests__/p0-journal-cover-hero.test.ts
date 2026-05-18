/**
 * 5-23 PR #159 — ContentDetailPage 期刊封面 hero 注入防回归。
 *
 * 后端: GET /content/:id 加 LEFT JOIN journals → response.data.journal {id, nameEn, coverImageUrl, IF, partition}
 * 前端: ContentDetailPage 渲染 dangerouslySetInnerHTML body 上方插 <JournalCoverHero> (frozen body 不动)
 *
 * 命名: JournalCoverHero (区别于 server-side wechat-article-template.renderCoverHero)
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #159: ContentDetailPage 期刊封面注入", () => {
  it("backend GET /content/:id 返 journal 字段 (id/nameEn/coverImageUrl/IF/分区)", async () => {
    const src = await readSrc("../routes/content.ts");
    // import journals from schema
    expect(src).toMatch(/import\s*\{[^}]*journals[^}]*\}\s*from\s*"\.\.\/models\/schema/);
    // 拿 metadata.journalId
    expect(src).toMatch(/metadata[\s\S]{0,80}journalId/);
    // select 4 字段 + coverImageUrl
    expect(src).toMatch(/journals\.coverImageUrl/);
    expect(src).toMatch(/journals\.impactFactor/);
    expect(src).toMatch(/journals\.partition/);
    expect(src).toMatch(/journals\.nameEn/);
    // 返回 data 含 journal
    expect(src).toMatch(/data:\s*\{\s*\.\.\.content,\s*siblings,\s*journal\s*\}/);
  });

  it("frontend ContentDetailPage 含 JournalCoverHero 组件 + ContentItem.journal 类型 + render 注入", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    // 组件定义
    expect(src).toMatch(/function JournalCoverHero\b/);
    // 名字区别于 server-side renderCoverHero
    expect(src).not.toMatch(/function renderCoverHero\b/);
    // ContentItem 类型扩展 journal 字段
    expect(src).toMatch(/journal\?\s*:\s*\{[\s\S]{0,200}coverImageUrl/);
    // body render 块上方注入 <JournalCoverHero>
    expect(src).toMatch(/<JournalCoverHero[\s\S]{0,200}content\.journal\?\.coverImageUrl/);
    // onError 兜底 (URL 加载失败 → display:none, 不破板)
    expect(src).toMatch(/onError[\s\S]{0,100}display\s*=\s*"none"/);
  });
});
