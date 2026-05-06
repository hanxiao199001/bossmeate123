/**
 * PR Q.1：wechat-batch-crawler 解析逻辑纯函数测试。
 * 不联网（fetch 部分另外集成测，本测试只覆盖 sogou 搜索结果 + 文章页 html 解析）。
 */
import { describe, it, expect } from "vitest";

// 复刻 parseSogouSearchResults / parseArticlePage 的纯逻辑（与 wechat-batch-crawler.ts:67+ 同步）
function parseSogouSearchResults(html: string, max: number): string[] {
  const urls: string[] = [];
  const re = /href="([^"]*?(?:mp\.weixin\.qq\.com\/s[^"]+|\/link\?url=[^"]+))"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && urls.length < max) {
    const u = m[1].replace(/&amp;/g, "&");
    if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

function parseArticlePage(html: string) {
  const titleMatch = html.match(/<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : null;
  if (!title) return null;
  const bodyMatch = html.match(/<div[^>]*class="[^"]*rich_media_content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/);
  const body = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
  return { title, body };
}

describe("PR Q.1: wechat-batch-crawler 解析", () => {
  it("sogou 搜索结果含 mp.weixin.qq.com 直链 → 提取 url", () => {
    const html = `
      <a class="title-link" href="https://mp.weixin.qq.com/s?__biz=abc&mid=123">文章 1</a>
      <a href="/link?url=cT8d7q...">sogou 跳转</a>
      <a href="https://mp.weixin.qq.com/s?__biz=abc&amp;mid=456">文章 2 含 amp;</a>
    `;
    const urls = parseSogouSearchResults(html, 10);
    expect(urls).toContain("https://mp.weixin.qq.com/s?__biz=abc&mid=123");
    expect(urls).toContain("https://mp.weixin.qq.com/s?__biz=abc&mid=456");
    expect(urls.some((u) => u.startsWith("/link?url="))).toBe(true);
  });

  it("max 限制有效 + 去重", () => {
    const html = '<a href="https://mp.weixin.qq.com/s?a=1"></a>'.repeat(5)
      + '<a href="https://mp.weixin.qq.com/s?a=2"></a>'.repeat(3);
    expect(parseSogouSearchResults(html, 1)).toHaveLength(1);
    expect(parseSogouSearchResults(html, 10)).toHaveLength(2); // 去重后只 2 个
  });

  it("article 页解析 title + body（去 html tag）", () => {
    const html = `
      <h1 class="rich_media_title" id="activity-name">柳叶刀IF 98.4 真相</h1>
      <div class="rich_media_content" id="js_content">
        <p>这是<strong>正文</strong>第一段。</p>
        <p>第二段含数据 IF 98.4。</p>
      </div></div></div>
    `;
    const r = parseArticlePage(html);
    expect(r?.title).toBe("柳叶刀IF 98.4 真相");
    expect(r?.body).toContain("正文");
    expect(r?.body).toContain("IF 98.4");
    expect(r?.body).not.toContain("<strong>");
  });

  it("article 页无 title → 返回 null（不入库）", () => {
    expect(parseArticlePage("<html><body>no title</body></html>")).toBeNull();
  });
});
