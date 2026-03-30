/**
 * 知乎专栏发布适配器
 *
 * 知乎开放平台文档较少，主要通过cookie方式调用
 * 发布专栏文章接口：POST https://zhuanlan.zhihu.com/api/articles
 */
import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";

export class ZhihuAdapter implements PlatformAdapter {
  platform = "zhihu";

  async verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    const { cookie } = credentials;
    if (!cookie) {
      return { valid: false, error: "缺少知乎 Cookie，请从浏览器登录后获取" };
    }

    try {
      const resp = await fetch("https://www.zhihu.com/api/v4/me", {
        headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" },
      });
      const data = await resp.json() as any;

      if (data.error) {
        return { valid: false, error: `知乎验证失败: ${data.error.message}` };
      }

      return { valid: true };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : "网络错误" };
    }
  }

  async publish(params: {
    credentials: Record<string, any>;
    title: string;
    content: string;
    author?: string;
  }): Promise<{ success: boolean; publishId?: string; url?: string; error?: string }> {
    const { credentials, title, content } = params;

    try {
      const { cookie, columnId } = credentials;
      if (!cookie) {
        return { success: false, error: "缺少知乎 Cookie，请在账号管理中配置" };
      }

      const htmlContent = this.markdownToHtml(content);

      // 创建文章草稿
      const draftResp = await fetch("https://zhuanlan.zhihu.com/api/articles/drafts", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        body: JSON.stringify({
          title,
          content: htmlContent,
          topic_url: "",
        }),
      });
      const draftData = await draftResp.json() as any;

      if (draftData.error) {
        return { success: false, error: `知乎草稿创建失败: ${draftData.error.message}` };
      }

      const articleId = draftData.id;

      // 发布草稿
      const pubResp = await fetch(`https://zhuanlan.zhihu.com/api/articles/${articleId}/publish`, {
        method: "PUT",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        body: JSON.stringify({
          column: columnId || undefined,
          commentPermission: "anyone",
        }),
      });
      const pubData = await pubResp.json() as any;

      if (pubData.error) {
        return { success: false, error: `知乎发布失败: ${pubData.error.message}` };
      }

      logger.info({ articleId }, "知乎发布成功");
      return {
        success: true,
        publishId: String(articleId),
        url: `https://zhuanlan.zhihu.com/p/${articleId}`,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "知乎发布异常" };
    }
  }

  private markdownToHtml(md: string): string {
    return md
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
      .replace(/^(?!<[h|l|b])(.+)$/gm, "<p>$1</p>")
      .replace(/\n{2,}/g, "\n");
  }
}
