/**
 * 百家号发布适配器
 *
 * 百家号开放平台API: https://openapi.baidu.com/wiki/index.php
 * 主要接口：
 * - 发布文章：POST /rest/2.0/cambrian/article/publish
 * - 上传图片：POST /rest/2.0/cambrian/article/upload/image
 */
import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";

const BJH_API = "https://openapi.baidu.com/rest/2.0/cambrian";

export class BaijiahaoAdapter implements PlatformAdapter {
  platform = "baijiahao";

  async verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    const { accessToken } = credentials;
    if (!accessToken) {
      return { valid: false, error: "缺少 accessToken" };
    }

    try {
      // 尝试获取账号信息验证token
      const url = `${BJH_API}/article/lists?access_token=${accessToken}&collection_id=&start=0&num=1`;
      const resp = await fetch(url);
      const data = await resp.json() as any;

      if (data.error_code) {
        return { valid: false, error: `错误码 ${data.error_code}: ${data.error_msg}` };
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
    digest?: string;
    coverImageUrl?: string;
  }): Promise<{ success: boolean; publishId?: string; url?: string; error?: string }> {
    const { credentials, title, content, coverImageUrl } = params;

    try {
      const { accessToken } = credentials;
      if (!accessToken) {
        return { success: false, error: "缺少百家号 accessToken，请在账号管理中配置" };
      }

      // 将markdown转为HTML
      const htmlContent = this.markdownToHtml(content);

      const url = `${BJH_API}/article/publish?access_token=${accessToken}`;
      const body: Record<string, any> = {
        title,
        body: htmlContent,
        type: "news",
      };

      if (coverImageUrl) {
        body.images = JSON.stringify([coverImageUrl]);
      }

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json() as any;

      if (data.error_code) {
        return { success: false, error: `百家号API错误 ${data.error_code}: ${data.error_msg}` };
      }

      logger.info({ articleId: data.id }, "百家号发布成功");
      return { success: true, publishId: String(data.id) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "百家号发布异常" };
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
