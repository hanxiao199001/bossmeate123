/**
 * 今日头条/头条号发布适配器
 *
 * 头条号开放平台: https://open.toutiao.com
 * 主要接口：
 * - 发布文章：POST /article/v1/create
 * - 上传图片：POST /tool/upload_img
 */
import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";

const TT_API = "https://open.toutiao.com/api";

export class ToutiaoAdapter implements PlatformAdapter {
  platform = "toutiao";

  async verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    const { accessToken } = credentials;
    if (!accessToken) {
      return { valid: false, error: "缺少 accessToken" };
    }

    try {
      const url = `${TT_API}/article/v1/list?access_token=${accessToken}&page=0&count=1`;
      const resp = await fetch(url);
      const data = await resp.json() as any;

      if (data.err_no !== 0) {
        return { valid: false, error: `错误码 ${data.err_no}: ${data.err_tips}` };
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
        return { success: false, error: "缺少头条号 accessToken，请在账号管理中配置" };
      }

      const htmlContent = this.markdownToHtml(content);

      const url = `${TT_API}/article/v1/create?access_token=${accessToken}`;
      const body: Record<string, any> = {
        title,
        content: htmlContent,
        article_type: "news",
        save: false, // false=直接发布, true=保存草稿
      };

      if (coverImageUrl) {
        body.cover_images = [coverImageUrl];
      }

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json() as any;

      if (data.err_no !== 0) {
        return { success: false, error: `头条号API错误 ${data.err_no}: ${data.err_tips}` };
      }

      logger.info({ articleId: data.data?.article_id }, "头条号发布成功");
      return {
        success: true,
        publishId: String(data.data?.article_id || ""),
        url: data.data?.article_url,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "头条号发布异常" };
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
