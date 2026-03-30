/**
 * 小红书发布适配器
 *
 * 小红书没有公开的内容发布API，通过cookie方式模拟
 * 创作者中心：https://creator.xiaohongshu.com
 */
import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";

const XHS_API = "https://edith.xiaohongshu.com/api/sns/web/v1";

export class XiaohongshuAdapter implements PlatformAdapter {
  platform = "xiaohongshu";

  async verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    const { cookie } = credentials;
    if (!cookie) {
      return { valid: false, error: "缺少小红书 Cookie，请从浏览器登录后获取" };
    }

    try {
      const resp = await fetch("https://edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo", {
        headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" },
      });
      const data = await resp.json() as any;

      if (!data.success) {
        return { valid: false, error: "小红书 Cookie 已失效，请重新登录获取" };
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
    coverImageUrl?: string;
  }): Promise<{ success: boolean; publishId?: string; url?: string; error?: string }> {
    const { credentials, title, content } = params;

    try {
      const { cookie } = credentials;
      if (!cookie) {
        return { success: false, error: "缺少小红书 Cookie，请在账号管理中配置" };
      }

      // 小红书发布图文笔记
      // 注意：小红书对内容格式有严格要求，需要适配
      const noteContent = this.formatForXhs(content);

      const resp = await fetch(`${XHS_API}/note/post`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        body: JSON.stringify({
          title,
          desc: noteContent,
          note_type: "normal",
          post_time: "",  // 立即发布
        }),
      });
      const data = await resp.json() as any;

      if (!data.success) {
        return { success: false, error: `小红书发布失败: ${data.msg || "未知错误"}` };
      }

      const noteId = data.data?.note_id;
      logger.info({ noteId }, "小红书发布成功");
      return {
        success: true,
        publishId: noteId,
        url: noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "小红书发布异常" };
    }
  }

  private formatForXhs(md: string): string {
    // 小红书不支持HTML，使用纯文本+emoji格式
    return md
      .replace(/^# (.+)$/gm, "📌 $1")
      .replace(/^## (.+)$/gm, "✨ $1")
      .replace(/^### (.+)$/gm, "💡 $1")
      .replace(/\*\*(.+?)\*\*/g, "【$1】")
      .replace(/^- (.+)$/gm, "▪️ $1")
      .replace(/^> (.+)$/gm, "💬 $1")
      .replace(/\n{3,}/g, "\n\n");
  }
}
