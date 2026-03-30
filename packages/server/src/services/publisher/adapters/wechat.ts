/**
 * 微信公众号发布适配器
 */
import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";
import zlib from "node:zlib";

const WX_API = "https://api.weixin.qq.com/cgi-bin";

export class WechatAdapter implements PlatformAdapter {
  platform = "wechat";

  async verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    const { appId, appSecret } = credentials;
    if (!appId || !appSecret) {
      return { valid: false, error: "缺少 appId 或 appSecret" };
    }

    try {
      const url = `${WX_API}/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
      const resp = await fetch(url);
      const data = await resp.json() as any;

      if (data.errcode) {
        return { valid: false, error: `错误码 ${data.errcode}: ${data.errmsg}` };
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
    metadata?: Record<string, any>;
  }): Promise<{ success: boolean; publishId?: string; mediaId?: string; url?: string; error?: string }> {
    const { credentials, title, content, author, digest } = params;

    try {
      // 1. Get access token
      const token = await this.getAccessToken(credentials);

      // 2. Get or create cover image
      const thumbMediaId = await this.getOrCreateThumb(token, credentials);

      // 3. Convert content to WeChat HTML
      const htmlContent = this.markdownToWechatHtml(content);

      // 4. Create draft
      const draftUrl = `${WX_API}/draft/add?access_token=${token}`;
      const draftBody = {
        articles: [{
          title,
          author: author || "BossMate AI",
          digest: digest || title.slice(0, 50),
          content: htmlContent,
          content_source_url: "",
          thumb_media_id: thumbMediaId,
          need_open_comment: 0,
          only_fans_can_comment: 0,
        }],
      };

      const draftResp = await fetch(draftUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftBody),
      });
      const draftData = await draftResp.json() as any;

      if (draftData.errcode) {
        return { success: false, error: `草稿创建失败 ${draftData.errcode}: ${draftData.errmsg}` };
      }

      const mediaId = draftData.media_id;

      // 5. Publish draft
      const pubUrl = `${WX_API}/freepublish/submit?access_token=${token}`;
      const pubResp = await fetch(pubUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_id: mediaId }),
      });
      const pubData = await pubResp.json() as any;

      if (pubData.errcode) {
        return {
          success: false,
          mediaId,
          error: `发布失败 ${pubData.errcode}: ${pubData.errmsg}（草稿已保存）`,
        };
      }

      return { success: true, mediaId, publishId: pubData.publish_id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "微信发布异常" };
    }
  }

  private async getAccessToken(credentials: Record<string, any>): Promise<string> {
    const { appId, appSecret, accessToken, tokenExpiresAt } = credentials;

    // Check cached token
    if (accessToken && tokenExpiresAt) {
      const expiresAt = new Date(tokenExpiresAt);
      if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
        return accessToken;
      }
    }

    const url = `${WX_API}/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
    const resp = await fetch(url);
    const data = await resp.json() as any;

    if (data.errcode) {
      throw new Error(`获取token失败: ${data.errcode} - ${data.errmsg}`);
    }

    return data.access_token;
  }

  private async getOrCreateThumb(token: string, credentials: Record<string, any>): Promise<string> {
    if (credentials.thumbMediaId) {
      return credentials.thumbMediaId;
    }

    // Generate a simple green PNG cover
    const pngBuffer = this.generateSolidColorPng(900, 383, 7, 193, 96);

    const formData = new FormData();
    const blob = new Blob([pngBuffer], { type: "image/png" });
    formData.append("media", blob, "cover.png");

    const url = `${WX_API}/material/add_material?access_token=${token}&type=image`;
    const resp = await fetch(url, { method: "POST", body: formData });
    const data = await resp.json() as any;

    if (data.errcode) {
      throw new Error(`封面图上传失败: ${data.errcode}`);
    }

    return data.media_id;
  }

  private generateSolidColorPng(width: number, height: number, r: number, g: number, b: number): Buffer {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData.writeUInt8(8, 8);
    ihdrData.writeUInt8(2, 9);
    ihdrData.writeUInt8(0, 10);
    ihdrData.writeUInt8(0, 11);
    ihdrData.writeUInt8(0, 12);
    const ihdr = this.createPngChunk("IHDR", ihdrData);
    const rowSize = 1 + width * 3;
    const rawData = Buffer.alloc(rowSize * height);
    for (let y = 0; y < height; y++) {
      const offset = y * rowSize;
      rawData[offset] = 0;
      for (let x = 0; x < width; x++) {
        const px = offset + 1 + x * 3;
        rawData[px] = r;
        rawData[px + 1] = g;
        rawData[px + 2] = b;
      }
    }
    const compressed = zlib.deflateSync(rawData);
    const idat = this.createPngChunk("IDAT", compressed);
    const iend = this.createPngChunk("IEND", Buffer.alloc(0));
    return Buffer.concat([signature, ihdr, idat, iend]);
  }

  private createPngChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBuffer, data]);
    const crc = this.crc32(crcInput);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc, 0);
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
  }

  private crc32(buf: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  private markdownToWechatHtml(content: string): string {
    let html = content
      .replace(/^### (.+)$/gm, '<h3 style="font-size:16px;font-weight:bold;color:#333;margin:18px 0 8px;border-left:4px solid #07c160;padding-left:10px;">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="font-size:18px;font-weight:bold;color:#1a1a1a;margin:22px 0 10px;border-bottom:2px solid #07c160;padding-bottom:6px;">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="font-size:20px;font-weight:bold;color:#000;text-align:center;margin:16px 0 12px;">$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#07c160;">$1</strong>')
      .replace(/^- (.+)$/gm, '<p style="padding-left:20px;margin:4px 0;line-height:1.8;font-size:15px;color:#333;">&#8226; $1</p>')
      .replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid #07c160;padding:10px 15px;margin:12px 0;background:#f8f9fa;color:#666;font-size:14px;line-height:1.7;">$1</blockquote>')
      .replace(/^(?!<[h|p|b|s])(.+)$/gm, '<p style="font-size:15px;color:#333;line-height:1.9;margin:8px 0;text-indent:2em;">$1</p>');
    html = html.replace(/\n{2,}/g, '\n');
    return html;
  }
}
