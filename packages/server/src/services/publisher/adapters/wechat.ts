/**
 * 微信公众号发布适配器
 */
import type { PlatformAdapter } from "../index.js";
import { logger } from "../../../config/logger.js";
import zlib from "node:zlib";
import juice from "juice";
import sharp from "sharp";

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
    /** 发布能力: full = 群发(需微信认证)；draft_only = 仅建草稿(默认) */
    capability?: "full" | "draft_only";
  }): Promise<{
    success: boolean;
    mode?: "full" | "draft_only";
    publishId?: string;
    mediaId?: string;
    url?: string;
    draftUrl?: string;
    message?: string;
    error?: string;
  }> {
    const { credentials, title, content, author, digest, coverImageUrl } = params;
    const capability = params.capability ?? "draft_only";

    try {
      // 1. Get access token
      const token = await this.getAccessToken(credentials);

      // 2. 封面（thumb_media_id）
      // 优先：用期刊封面图做横版封面（900×383，期刊图居中+渐变背景）
      // 降级：纯渐变背景，微信自动叠加文章标题
      let thumbMediaId: string;
      try {
        if (coverImageUrl) {
          thumbMediaId = await this.createCoverWithJournalImage(coverImageUrl, token);
        } else {
          thumbMediaId = await this.createGradientThumb(token);
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err }, "封面生成失败，回退");
        try {
          thumbMediaId = await this.createGradientThumb(token);
        } catch {
          thumbMediaId = await this.getOrCreateThumb(token, credentials);
        }
      }

      // 3. Convert content to WeChat HTML
      let htmlContent = this.markdownToWechatHtml(content);

      // 3a. Inline CSS（juice）—— 微信编辑器不认 <style> / class，必须全部转成 inline style
      try {
        htmlContent = juice(htmlContent, {
          applyStyleTags: true,
          removeStyleTags: true,
          preserveImportant: false,
        });
      } catch (err) {
        logger.warn({ err }, "juice 内联 CSS 失败，使用原始 HTML");
      }

      // 3b. 把外链/base64 图片先上传到微信素材库，替换 src。
      // 微信草稿箱不支持外部图片热链，不处理会在客户端被剥离。
      try {
        htmlContent = await uploadImagesToWechat(htmlContent, token);
      } catch (err) {
        logger.warn({ err }, "微信图片预上传失败，继续用原 HTML（外链可能被剥离）");
      }

      // 4. Create draft
      // 微信限制：title 最大 64 字节（UTF-8），digest 最大 120 字节。中文 3 字节/字，
      // 标题要留安全 margin 截到 60 字节；digest 同理截到 110 字节，避免 45003。
      const safeTitle = truncateUtf8Bytes(title, 60);
      const safeDigest = truncateUtf8Bytes(digest || title, 110);
      if (safeTitle !== title) {
        logger.warn({ originalLen: title.length, truncatedTo: safeTitle }, "微信 title 超 64 字节，已截断");
      }
      const draftApiUrl = `${WX_API}/draft/add?access_token=${token}`;
      const draftBody = {
        articles: [{
          title: safeTitle,
          author: author || "BossMate AI",
          digest: safeDigest,
          content: htmlContent,
          content_source_url: "",
          thumb_media_id: thumbMediaId,
          need_open_comment: 0,
          only_fans_can_comment: 0,
        }],
      };

      const draftResp = await fetch(draftApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftBody),
      });
      const draftData = await draftResp.json() as any;

      if (draftData.errcode) {
        return { success: false, error: `草稿创建失败 ${draftData.errcode}: ${draftData.errmsg}` };
      }

      const mediaId = draftData.media_id;
      // 公众号后台草稿箱入口（通用，所有账号都可用）
      const draftUrl = "https://mp.weixin.qq.com/";

      // draft_only 模式：建完草稿就 return，不调 freepublish
      // 场景：未认证订阅号，或用户手动选择了保守模式
      if (capability === "draft_only") {
        logger.info({ mediaId, mode: "draft_only" }, "微信草稿已创建（draft_only 模式）");
        return {
          success: true,
          mode: "draft_only",
          mediaId,
          draftUrl,
          message: "草稿已创建，请到公众号后台「素材管理 → 图文素材 → 草稿箱」手动发送",
        };
      }

      // 5. full 模式：继续调 freepublish 自动群发
      const pubUrl = `${WX_API}/freepublish/submit?access_token=${token}`;
      const pubResp = await fetch(pubUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_id: mediaId }),
      });
      const pubData = await pubResp.json() as any;

      if (pubData.errcode) {
        // 共语义：草稿已建但无群发权限（认证缺失 / 功能被封禁 / 功能暂停），用户需到公众号后台手动发送。
        // 48001 = 未认证账号无权限；48004 = 接口功能被封禁；48005 = 接口功能暂停（违规）。
        const DOWNGRADE_ERRCODES = new Set([48001, 48004, 48005]);
        if (DOWNGRADE_ERRCODES.has(pubData.errcode)) {
          return {
            success: true,
            mode: "draft_only",
            mediaId,
            draftUrl,
            message: `账号暂无群发权限 (${pubData.errcode}: ${pubData.errmsg})，草稿已保存，请到公众号后台手动发送`,
          };
        }
        // 非降级错误：仍然保留 mediaId 和 draftUrl，让用户至少能到草稿箱找到内容
        return {
          success: false,
          mediaId,
          draftUrl,
          error: `发布失败 ${pubData.errcode}: ${pubData.errmsg}（草稿已保存）`,
        };
      }

      return { success: true, mode: "full", mediaId, publishId: pubData.publish_id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "微信发布异常" };
    }
  }

  /**
   * 期刊封面图 + 渐变背景合成横版封面（900×383）
   * 左侧渐变底色 + 右侧期刊封面图（居中裁剪），无文字
   * 微信会自动在封面上叠加文章标题
   */
  private async createCoverWithJournalImage(imageUrl: string, token: string): Promise<string> {
    // 1. 下载期刊封面
    const imgBuf = await fetchImageBuffer(imageUrl);
    if (!imgBuf || imgBuf.byteLength < 500) {
      throw new Error("期刊封面图下载失败或太小");
    }

    // 2. 用 sharp 合成横版封面
    // 背景：900×383 深蓝渐变
    const bgSvg = `<svg width="900" height="383" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" style="stop-color:#0D47A1"/>
    <stop offset="50%" style="stop-color:#1565C0"/>
    <stop offset="100%" style="stop-color:#1A237E"/>
  </linearGradient></defs>
  <rect width="900" height="383" fill="url(#bg)"/>
  <circle cx="200" cy="300" r="200" fill="rgba(255,255,255,0.03)"/>
  <rect x="0" y="370" width="900" height="13" fill="rgba(255,215,84,0.3)"/>
</svg>`;

    const bgBuf = await sharp(Buffer.from(bgSvg)).png().toBuffer();

    // 3. 处理期刊封面图：调整到合适大小，保留比例
    const coverResized = await sharp(imgBuf)
      .resize({ height: 320, withoutEnlargement: false })
      .png()
      .toBuffer();

    const coverMeta = await sharp(coverResized).metadata();
    const coverW = coverMeta.width || 200;
    const coverH = coverMeta.height || 320;

    // 添加白色边框效果
    const coverWithBorder = await sharp(coverResized)
      .extend({
        top: 4, bottom: 4, left: 4, right: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0.9 },
      })
      .png()
      .toBuffer();

    const finalCoverMeta = await sharp(coverWithBorder).metadata();
    const finalW = finalCoverMeta.width || coverW + 8;
    const finalH = finalCoverMeta.height || coverH + 8;

    // 4. 合成：期刊封面居中偏右放置
    const left = Math.round((900 - finalW) / 2);
    const top = Math.round((383 - finalH) / 2);

    const jpegBuf = await sharp(bgBuf)
      .composite([{
        input: coverWithBorder,
        left: Math.max(0, left),
        top: Math.max(0, top),
      }])
      .jpeg({ quality: 90 })
      .toBuffer();

    logger.info({ size: jpegBuf.byteLength, coverW, coverH }, "期刊封面合成横版封面完成");

    // 5. 上传到微信永久素材
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(jpegBuf)], { type: "image/jpeg" });
    formData.append("media", blob, "cover.jpg");

    const url = `${WX_API}/material/add_material?access_token=${token}&type=image`;
    const resp = await fetch(url, { method: "POST", body: formData });
    const data = await resp.json() as any;

    if (data.errcode) {
      throw new Error(`封面素材上传失败: ${data.errcode} ${data.errmsg}`);
    }
    return data.media_id;
  }

  /**
   * 纯渐变背景横版封面（900×383 / 2.35:1）
   * 深蓝渐变 + 金色装饰线 + 微妙圆形装饰，不含任何文字
   * 微信会自动在封面上叠加文章标题，不需要我们画文字
   * 无中文字体依赖，服务器无字体也能正常生成
   */
  private async createGradientThumb(token: string): Promise<string> {
    const svg = `<svg width="900" height="383" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" style="stop-color:#0D47A1"/>
    <stop offset="50%" style="stop-color:#1565C0"/>
    <stop offset="100%" style="stop-color:#1A237E"/>
  </linearGradient></defs>
  <rect width="900" height="383" fill="url(#bg)"/>
  <circle cx="750" cy="80" r="150" fill="rgba(255,255,255,0.05)"/>
  <circle cx="800" cy="120" r="100" fill="rgba(255,255,255,0.03)"/>
  <circle cx="150" cy="300" r="200" fill="rgba(255,255,255,0.03)"/>
  <rect x="50" y="140" width="5" height="100" rx="2.5" fill="#FFD54F"/>
  <rect x="0" y="370" width="900" height="13" fill="rgba(255,215,84,0.3)"/>
  <rect x="830" y="340" width="40" height="3" rx="1.5" fill="#FFD54F" opacity="0.5"/>
</svg>`;

    const jpegBuf = await sharp(Buffer.from(svg))
      .jpeg({ quality: 90 })
      .toBuffer();

    logger.info({ size: jpegBuf.byteLength }, "渐变背景封面生成完成");

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(jpegBuf)], { type: "image/jpeg" });
    formData.append("media", blob, "cover.jpg");

    const url = `${WX_API}/material/add_material?access_token=${token}&type=image`;
    const resp = await fetch(url, { method: "POST", body: formData });
    const data = await resp.json() as any;

    if (data.errcode) {
      throw new Error(`封面素材上传失败: ${data.errcode} ${data.errmsg}`);
    }
    return data.media_id;
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
    // 如果内容已经是完整的 HTML（期刊推荐模板直接输出 HTML），直接返回
    // 检测方式：以 <div 开头说明是已渲染的 HTML 模板，无需 Markdown 转换
    // 已渲染的 HTML 模板（<section / <div / <!DOCTYPE）直接返回，不做 Markdown 转换
    const trimmed = content.trimStart();
    if (trimmed.startsWith("<section") || trimmed.startsWith("<div") || trimmed.startsWith("<!")) {
      return content;
    }

    // 以下为 Markdown → 微信 HTML 转换（仅用于纯 Markdown 内容）
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

const WX_UPLOADIMG_MAX_BYTES = 1_000_000; // 微信 uploadimg 单图 ≤ 1MB

/**
 * 把 HTML 里所有 <img src> 上传到微信 /cgi-bin/media/uploadimg 并替换 src。
 * 微信在图文 body 里只认通过 uploadimg 返回的内部 URL；外链会被剥离。
 *
 * 策略：
 * - http(s) 外链 → fetch → 转 Buffer → uploadimg
 * - data:image/...;base64, → 解 base64 → uploadimg
 * - 超 1MB → sharp 压缩到 1920px 宽 JPEG quality 80
 * - 单张失败不中断流程，保留原 src（客户端会剥离，但不影响其他图）
 *
 * 导出供 dry-run / 测试使用。
 */
export async function uploadImagesToWechat(html: string, token: string): Promise<string> {
  const imgRegex = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const matches: Array<{ src: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(html)) !== null) {
    matches.push({ src: m[1], index: m.index });
  }
  if (matches.length === 0) return html;

  // 去重后逐个上传（同一 src 只上传一次）
  const uniqueSrcs = Array.from(new Set(matches.map((x) => x.src)));
  const srcMap = new Map<string, string>();

  for (const originalSrc of uniqueSrcs) {
    try {
      const buf = await fetchImageBuffer(originalSrc);
      if (!buf) continue;
      // 小图（<100KB）跳过 sharp 压缩，避免二次有损画质劣化
      // 大图（>1MB）走 sharp 降分辨率 + 降 quality
      // 中间段（100KB-1MB）原样上传
      const WX_COMPRESS_SKIP_THRESHOLD = 100_000;
      const compressed = buf.byteLength > WX_UPLOADIMG_MAX_BYTES
        ? await compressImage(buf)
        : buf; // 100KB-1MB 以及 <100KB 都原样上传，不压

      const form = new FormData();
      const blob = new Blob([new Uint8Array(compressed)], { type: "image/jpeg" });
      form.append("media", blob, "image.jpg");

      const uploadUrl = `https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${token}`;
      const resp = await fetch(uploadUrl, { method: "POST", body: form });
      const data = (await resp.json()) as { url?: string; errcode?: number; errmsg?: string };

      if (data.errcode) {
        logger.warn({ originalSrc, errcode: data.errcode, errmsg: data.errmsg }, "微信 uploadimg 失败");
        continue;
      }
      if (data.url) {
        srcMap.set(originalSrc, data.url);
      }
    } catch (err) {
      logger.warn({ originalSrc, err: err instanceof Error ? err.message : err }, "图片上传异常，保留原链接");
    }
  }

  // 替换 HTML 里所有成功映射的 src
  let out = html;
  for (const [oldSrc, newSrc] of srcMap) {
    // 直接文本替换（src 已用 " 或 ' 分隔，不会跨越属性边界）
    out = out.split(oldSrc).join(newSrc);
  }
  return out;
}

/** 下载/解码图片为 Buffer。支持 http(s) 外链 + data:image base64。 */
async function fetchImageBuffer(src: string): Promise<Buffer | null> {
  if (src.startsWith("data:")) {
    const commaIdx = src.indexOf(",");
    if (commaIdx < 0) return null;
    const header = src.slice(0, commaIdx);
    const payload = src.slice(commaIdx + 1);
    if (header.includes(";base64")) {
      return Buffer.from(payload, "base64");
    }
    return Buffer.from(decodeURIComponent(payload), "utf8");
  }
  if (!/^https?:\/\//i.test(src)) return null;
  const resp = await fetch(src);
  if (!resp.ok) return null;
  return Buffer.from(await resp.arrayBuffer());
}

/** 用 sharp 压到 ≤ 1MB：先 resize 到最大 1920px 宽，再降 JPEG quality，至多 3 档降级。 */
async function compressImage(buf: Buffer): Promise<Buffer> {
  const qualities = [80, 65, 50];
  for (const q of qualities) {
    const out = await sharp(buf)
      .resize({ width: 1920, withoutEnlargement: true })
      .jpeg({ quality: q })
      .toBuffer();
    if (out.byteLength <= WX_UPLOADIMG_MAX_BYTES) return out;
  }
  // 最后兜底：再降宽到 1280 + quality 50
  return sharp(buf)
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 50 })
    .toBuffer();
}

/**
 * 按 UTF-8 字节数安全截断字符串，保证不切到半个中文字符产生乱码。
 * 微信多数接口限制按字节算：title 64 / digest 120 / summary 120 等。
 */
function truncateUtf8Bytes(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) return input;
  // 切到 maxBytes 再用 TextDecoder(fatal:false) 丢弃末尾不完整的字节序列
  const sliced = buf.subarray(0, maxBytes);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
  // 去掉可能出现的 U+FFFD replacement char（来自被切断的尾字节）
  return decoded.replace(/\uFFFD+$/, "");
}
