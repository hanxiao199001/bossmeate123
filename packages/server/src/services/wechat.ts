/**
 * 微信公众号 API 服务
 *
 * 核心功能：
 * 1. access_token 获取与自动刷新
 * 2. 封面图自动生成与上传（永久素材）
 * 3. 草稿箱创建与发布
 *
 * 微信公众号API文档:
 * https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html
 */

import { db } from "../models/db.js";
import { wechatConfigs } from "../models/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../config/logger.js";
import zlib from "node:zlib";

const WX_API = "https://api.weixin.qq.com/cgi-bin";

export interface WechatPublishResult {
  success: boolean;
  mediaId?: string;
  publishId?: string;
  msgDataId?: string;
  error?: string;
}

/**
 * 获取有效的 access_token
 * 如果token过期，自动从微信API刷新
 */
export async function getAccessToken(tenantId: string): Promise<string> {
  const configs = await db
    .select()
    .from(wechatConfigs)
    .where(eq(wechatConfigs.tenantId, tenantId))
    .limit(1);

  if (configs.length === 0) {
    throw new Error("未配置微信公众号，请先在设置中配置AppID和AppSecret");
  }

  const config = configs[0];

  // 检查token是否还有效（提前5分钟刷新）
  if (config.accessToken && config.tokenExpiresAt) {
    const now = new Date();
    const expiresAt = new Date(config.tokenExpiresAt);
    const fiveMinutes = 5 * 60 * 1000;
    if (expiresAt.getTime() - now.getTime() > fiveMinutes) {
      return config.accessToken;
    }
  }

  // 从微信API获取新token
  logger.info("微信: 刷新access_token");
  const url = `${WX_API}/token?grant_type=client_credential&appid=${config.appId}&secret=${config.appSecret}`;

  const resp = await fetch(url);
  const data = await resp.json() as any;

  if (data.errcode) {
    const errMsg = `微信API错误: ${data.errcode} - ${data.errmsg}`;
    logger.error(errMsg);
    throw new Error(errMsg);
  }

  // 保存新token
  const expiresAt = new Date(Date.now() + (data.expires_in - 300) * 1000);
  await db
    .update(wechatConfigs)
    .set({
      accessToken: data.access_token,
      tokenExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(wechatConfigs.tenantId, tenantId));

  return data.access_token;
}

/**
 * 验证公众号配置是否有效
 */
export async function verifyConfig(appId: string, appSecret: string): Promise<{ valid: boolean; error?: string }> {
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

// ============ 封面图生成（纯Node，无额外依赖）============

/**
 * 用 Node.js 内置 zlib 生成一张纯色 PNG 图片
 * 微信推荐封面图尺寸 900x383（2.35:1比例）
 * 最低要求：200x200，格式 jpg/png
 */
function generateSolidColorPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Buffer {
  // PNG 文件结构: Signature + IHDR + IDAT + IEND

  // 1. PNG Signature (8 bytes)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // 2. IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);    // width
  ihdrData.writeUInt32BE(height, 4);   // height
  ihdrData.writeUInt8(8, 8);           // bit depth
  ihdrData.writeUInt8(2, 9);           // color type (RGB)
  ihdrData.writeUInt8(0, 10);          // compression
  ihdrData.writeUInt8(0, 11);          // filter
  ihdrData.writeUInt8(0, 12);          // interlace
  const ihdr = createPngChunk("IHDR", ihdrData);

  // 3. IDAT chunk - 像素数据
  // 每行: filter_byte(0) + RGB * width
  const rowSize = 1 + width * 3;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const offset = y * rowSize;
    rawData[offset] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const px = offset + 1 + x * 3;
      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const idat = createPngChunk("IDAT", compressed);

  // 4. IEND chunk
  const iend = createPngChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** 创建 PNG chunk: length(4) + type(4) + data + crc32(4) */
function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcInput);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/** CRC32 计算（PNG标准） */
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============ 封面图管理 ============

/**
 * 获取或创建租户的默认封面图 thumb_media_id
 * 如果DB已缓存则直接返回，否则生成纯色封面图并上传到微信永久素材
 */
async function getOrCreateThumbMediaId(tenantId: string): Promise<string> {
  // 先查DB缓存
  const configs = await db
    .select({ thumbMediaId: wechatConfigs.thumbMediaId })
    .from(wechatConfigs)
    .where(eq(wechatConfigs.tenantId, tenantId))
    .limit(1);

  if (configs.length > 0 && configs[0].thumbMediaId) {
    logger.info("微信: 使用缓存的封面图 thumb_media_id");
    return configs[0].thumbMediaId;
  }

  // 生成一张纯绿色 PNG 封面图 (900x383)
  logger.info("微信: 首次使用，生成默认封面图并上传...");
  const pngBuffer = generateSolidColorPng(900, 383, 7, 193, 96); // #07C160 微信绿

  // 上传到微信永久素材
  const uploadResult = await uploadImage(tenantId, pngBuffer, "cover.png", "image/png");

  if (uploadResult.error || !uploadResult.mediaId) {
    throw new Error(`封面图上传失败: ${uploadResult.error || "未知错误"}`);
  }

  // 缓存到DB，后续不再重复上传
  await db
    .update(wechatConfigs)
    .set({ thumbMediaId: uploadResult.mediaId, updatedAt: new Date() })
    .where(eq(wechatConfigs.tenantId, tenantId));

  logger.info({ thumbMediaId: uploadResult.mediaId }, "微信: 封面图上传成功并已缓存");
  return uploadResult.mediaId;
}

// ============ 草稿箱 ============

/**
 * 从URL下载图片并上传到微信，返回 media_id
 * 用于将期刊封面图作为微信文章首图
 */
async function uploadImageFromUrl(
  tenantId: string,
  imageUrl: string,
): Promise<string | null> {
  try {
    // 如果是 data URI（SVG数据卡片），直接解析
    if (imageUrl.startsWith("data:")) {
      const match = imageUrl.match(/^data:([^;]+);(?:charset=[^;]+;)?base64,(.+)$/);
      if (!match) return null;
      const buffer = Buffer.from(match[2], "base64");
      // SVG 不能直接上传微信，需要跳过
      if (match[1].includes("svg")) {
        logger.info("微信: data URI 是 SVG 格式，跳过上传");
        return null;
      }
      const result = await uploadImage(tenantId, buffer, "hero.png", match[1]);
      return result.mediaId || null;
    }

    // HTTP URL：下载图片
    logger.info({ imageUrl: imageUrl.slice(0, 80) }, "微信: 下载期刊封面图...");
    const resp = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 BossMate/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;

    const contentType = resp.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await resp.arrayBuffer());

    if (buffer.length < 100) return null; // 太小，可能不是有效图片

    const ext = contentType.includes("png") ? "png" : "jpg";
    const result = await uploadImage(tenantId, buffer, `hero.${ext}`, contentType);
    if (result.mediaId) {
      logger.info({ mediaId: result.mediaId }, "微信: 期刊封面图上传成功");
    }
    return result.mediaId || null;
  } catch (err) {
    logger.warn({ error: String(err) }, "微信: 封面图下载/上传失败");
    return null;
  }
}

/**
 * 将文章添加到微信公众号草稿箱
 *
 * 流程：先确保有封面图thumb_media_id → 再调用draft/add接口
 * POST https://api.weixin.qq.com/cgi-bin/draft/add?access_token=ACCESS_TOKEN
 *
 * @param heroImageUrl - 可选的期刊封面图URL，用作文章首图（优先于默认纯色图）
 */
export async function addDraft(
  tenantId: string,
  title: string,
  content: string,
  author?: string,
  digest?: string,
  heroImageUrl?: string,
): Promise<WechatPublishResult> {
  try {
    // 1. 确保有封面图：优先用传入的期刊封面，否则用默认
    let thumbMediaId: string | null = null;

    // 尝试用期刊封面图作为首图
    if (heroImageUrl && !heroImageUrl.startsWith("data:image/svg")) {
      thumbMediaId = await uploadImageFromUrl(tenantId, heroImageUrl);
    }

    // 回退到默认封面图
    if (!thumbMediaId) {
      thumbMediaId = await getOrCreateThumbMediaId(tenantId);
    }
    logger.info({ thumbMediaId }, "微信: 使用封面图创建草稿");

    // 2. 获取token
    const token = await getAccessToken(tenantId);

    // 3. 处理文章正文中的图片：上传到微信服务器，替换为微信URL
    const processedContent = await processArticleImages(tenantId, content);

    // 4. 将markdown内容转为微信友好的HTML
    const htmlContent = markdownToWechatHtml(processedContent);

    // 5. 创建草稿
    const url = `${WX_API}/draft/add?access_token=${token}`;
    const body = {
      articles: [
        {
          title,
          author: author || "BossMate AI",
          digest: digest || title.slice(0, 50),
          content: htmlContent,
          content_source_url: "",
          thumb_media_id: thumbMediaId,
          need_open_comment: 0,
          only_fans_can_comment: 0,
        },
      ],
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json() as any;

    if (data.errcode) {
      // 如果是media_id无效（可能被删除），清除缓存重试一次
      if (data.errcode === 40007) {
        logger.warn("微信: thumb_media_id 已失效，清除缓存并重新上传...");
        await db
          .update(wechatConfigs)
          .set({ thumbMediaId: null, updatedAt: new Date() })
          .where(eq(wechatConfigs.tenantId, tenantId));

        // 重新获取thumb_media_id并重试
        const newThumbId = await getOrCreateThumbMediaId(tenantId);
        body.articles[0].thumb_media_id = newThumbId;

        const retryResp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const retryData = await retryResp.json() as any;

        if (retryData.errcode) {
          logger.error({ errcode: retryData.errcode, errmsg: retryData.errmsg }, "微信草稿创建失败(重试)");
          return {
            success: false,
            error: `微信API错误 ${retryData.errcode}: ${retryData.errmsg}`,
          };
        }

        logger.info({ mediaId: retryData.media_id }, "微信草稿创建成功(重试)");
        return { success: true, mediaId: retryData.media_id };
      }

      logger.error({ errcode: data.errcode, errmsg: data.errmsg }, "微信草稿创建失败");
      return {
        success: false,
        error: `微信API错误 ${data.errcode}: ${data.errmsg}`,
      };
    }

    logger.info({ mediaId: data.media_id }, "微信草稿创建成功");
    return {
      success: true,
      mediaId: data.media_id,
    };
  } catch (err) {
    logger.error({ err }, "微信草稿创建异常");
    return {
      success: false,
      error: err instanceof Error ? err.message : "未知错误",
    };
  }
}

// ============ 发布 ============

/**
 * 发布草稿箱中的文章
 * POST https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=ACCESS_TOKEN
 */
export async function publishDraft(
  tenantId: string,
  mediaId: string,
): Promise<WechatPublishResult> {
  try {
    const token = await getAccessToken(tenantId);

    const url = `${WX_API}/freepublish/submit?access_token=${token}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_id: mediaId }),
    });
    const data = await resp.json() as any;

    if (data.errcode) {
      logger.error({ errcode: data.errcode, errmsg: data.errmsg }, "微信发布失败");
      return {
        success: false,
        error: `微信API错误 ${data.errcode}: ${data.errmsg}`,
      };
    }

    logger.info({ publishId: data.publish_id }, "微信文章发布成功");
    return {
      success: true,
      publishId: data.publish_id,
    };
  } catch (err) {
    logger.error({ err }, "微信发布异常");
    return {
      success: false,
      error: err instanceof Error ? err.message : "未知错误",
    };
  }
}

// ============ 素材上传 ============

/**
 * 上传永久图片素材（用作封面图）
 * POST https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=ACCESS_TOKEN&type=image
 */
export async function uploadImage(
  tenantId: string,
  imageBuffer: Buffer,
  filename: string,
  mimeType: string = "image/jpeg",
): Promise<{ mediaId?: string; url?: string; error?: string }> {
  try {
    const token = await getAccessToken(tenantId);

    const formData = new FormData();
    const blob = new Blob([imageBuffer], { type: mimeType });
    formData.append("media", blob, filename);

    const url = `${WX_API}/material/add_material?access_token=${token}&type=image`;
    const resp = await fetch(url, {
      method: "POST",
      body: formData,
    });
    const data = await resp.json() as any;

    if (data.errcode) {
      return { error: `上传失败 ${data.errcode}: ${data.errmsg}` };
    }

    return { mediaId: data.media_id, url: data.url };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "上传异常" };
  }
}

// ============ 文章正文图片上传 ============

/**
 * 上传图片到微信（用于文章正文中的图片）
 * 使用 media/uploadimg 接口，返回的URL可直接用于文章内容
 * POST https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=ACCESS_TOKEN
 */
async function uploadArticleImage(
  tenantId: string,
  imageBuffer: Buffer,
  filename: string,
  mimeType: string = "image/jpeg",
): Promise<string | null> {
  try {
    const token = await getAccessToken(tenantId);

    const formData = new FormData();
    const blob = new Blob([imageBuffer], { type: mimeType });
    formData.append("media", blob, filename);

    const url = `${WX_API}/media/uploadimg?access_token=${token}`;
    const resp = await fetch(url, {
      method: "POST",
      body: formData,
    });
    const data = await resp.json() as any;

    if (data.errcode) {
      logger.warn({ errcode: data.errcode, errmsg: data.errmsg }, "微信: 文章图片上传失败");
      return null;
    }

    // 返回的 url 是 https://mmbiz.qpic.cn/... 格式，可直接用于文章
    logger.info({ url: data.url }, "微信: 文章图片上传成功");
    return data.url;
  } catch (err) {
    logger.warn({ error: String(err) }, "微信: 文章图片上传异常");
    return null;
  }
}

/**
 * 处理文章正文中的图片：提取 Markdown ![alt](url)，上传到微信，替换 URL
 * - 外部图片 URL → 下载 → 上传到微信 → 替换为微信 URL
 * - SVG data URI → 跳过（微信不支持 SVG）
 * - data:image/png;base64 → 解码 → 上传到微信 → 替换为微信 URL
 */
async function processArticleImages(
  tenantId: string,
  content: string,
): Promise<string> {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [...content.matchAll(imageRegex)];

  if (matches.length === 0) return content;

  let processed = content;

  for (const match of matches) {
    const fullMatch = match[0];
    const alt = match[1];
    const originalUrl = match[2];

    // 跳过 SVG data URI（微信不支持）
    if (originalUrl.startsWith("data:image/svg")) {
      // 移除 SVG 图片行，避免渲染为纯文本
      processed = processed.replace(fullMatch, "");
      continue;
    }

    try {
      let imageBuffer: Buffer | null = null;
      let mimeType = "image/jpeg";
      let filename = "article-img.jpg";

      if (originalUrl.startsWith("data:image/")) {
        // 处理 base64 data URI
        const dataMatch = originalUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (dataMatch) {
          const ext = dataMatch[1];
          mimeType = `image/${ext}`;
          filename = `article-img.${ext}`;
          imageBuffer = Buffer.from(dataMatch[2], "base64");
        }
      } else if (originalUrl.startsWith("http")) {
        // 下载外部图片
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(originalUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; BossMate/1.0)" },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (resp.ok) {
          const contentType = resp.headers.get("content-type") || "image/jpeg";
          mimeType = contentType.split(";")[0];
          const ext = mimeType.includes("png") ? "png" : mimeType.includes("gif") ? "gif" : "jpg";
          filename = `article-img.${ext}`;
          imageBuffer = Buffer.from(await resp.arrayBuffer());
        }
      }

      if (imageBuffer && imageBuffer.length > 100) {
        const wxUrl = await uploadArticleImage(tenantId, imageBuffer, filename, mimeType);
        if (wxUrl) {
          // 替换为微信图片 URL
          processed = processed.replace(fullMatch, `![${alt}](${wxUrl})`);
          continue;
        }
      }

      // 上传失败，移除图片行避免渲染为纯文本
      processed = processed.replace(fullMatch, "");
    } catch (err) {
      logger.warn({ url: originalUrl, error: String(err) }, "微信: 处理文章图片失败");
      processed = processed.replace(fullMatch, "");
    }
  }

  return processed;
}

// ============ HTML转换 ============

/**
 * 将 Markdown 风格的文本转为微信公众号友好的HTML
 */
function markdownToWechatHtml(content: string): string {
  let html = content
    // 图片（必须在标题之前处理，避免被段落规则吞掉）
    .replace(/^!\[([^\]]*)\]\(([^)]+)\)$/gm,
      '<p style="text-align:center;margin:16px 0;"><img src="$2" alt="$1" style="max-width:100%;border-radius:8px;" /><br/><span style="font-size:12px;color:#999;">$1</span></p>')
    // 标题
    .replace(/^### (.+)$/gm, '<h3 style="font-size:16px;font-weight:bold;color:#333;margin:18px 0 8px;border-left:4px solid #07c160;padding-left:10px;">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:18px;font-weight:bold;color:#1a1a1a;margin:22px 0 10px;border-bottom:2px solid #07c160;padding-bottom:6px;">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:20px;font-weight:bold;color:#000;text-align:center;margin:16px 0 12px;">$1</h1>')
    // Markdown 表格转 HTML
    .replace(/(?:^(\|.+\|)\n(\|[\s:-]+\|)\n((?:\|.+\|\n?)+))/gm, (_match, header: string, _sep: string, body: string) => {
      const headerCells = header.split("|").filter((c: string) => c.trim());
      const bodyRows = body.trim().split("\n");
      let table = '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;">';
      table += "<thead><tr>";
      for (const cell of headerCells) {
        table += `<th style="border:1px solid #ddd;padding:8px 10px;background:#f0f9f4;color:#333;font-weight:bold;text-align:left;">${cell.trim()}</th>`;
      }
      table += "</tr></thead><tbody>";
      for (const row of bodyRows) {
        const cells = row.split("|").filter((c: string) => c.trim());
        if (cells.length === 0) continue;
        table += "<tr>";
        for (const cell of cells) {
          table += `<td style="border:1px solid #ddd;padding:8px 10px;color:#333;">${cell.trim()}</td>`;
        }
        table += "</tr>";
      }
      table += "</tbody></table>";
      return table;
    })
    // 加粗
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#07c160;">$1</strong>')
    // 列表
    .replace(/^- (.+)$/gm, '<p style="padding-left:20px;margin:4px 0;line-height:1.8;font-size:15px;color:#333;">&#8226; $1</p>')
    // 引用
    .replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid #07c160;padding:10px 15px;margin:12px 0;background:#f8f9fa;color:#666;font-size:14px;line-height:1.7;">$1</blockquote>')
    // 普通段落
    .replace(/^(?!<[h|p|b|s|t])(.+)$/gm, '<p style="font-size:15px;color:#333;line-height:1.9;margin:8px 0;text-indent:2em;">$1</p>');

  // 清理连续空行
  html = html.replace(/\n{2,}/g, '\n');

  return html;
}
