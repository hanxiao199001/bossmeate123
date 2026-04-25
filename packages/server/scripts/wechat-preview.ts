/**
 * 微信发布前 dry-run 预览
 *
 * 用法（在 packages/server 目录下）：
 *   pnpm tsx scripts/wechat-preview.ts <contentId>
 *   # 不传 contentId 就取当前租户最新一条 reviewing/approved
 *
 * 行为：
 *   1. 从 DB 读 contents.body 作为原始 HTML
 *   2. 跑 juice 内联 CSS
 *   3. 跑 uploadImagesToWechat（如果配置了真实 token 就上传；否则 mock 模式打日志）
 *   4. 结果写到 /tmp/wechat-preview.html 供浏览器打开查看
 *
 * 不发送 draft/add，不调 freepublish，不消耗微信素材配额。
 * uploadimg 会真实调用（会占配额 ≤ 文章内图片数），如需跳过加 --no-upload。
 */

import { db } from "../src/models/db.js";
import { contents, platformAccounts } from "../src/models/schema.js";
import { and, eq, desc, inArray } from "drizzle-orm";
import { decryptCredentialField } from "../src/services/publisher/credentials-loader.js";
import { uploadImagesToWechat } from "../src/services/publisher/adapters/wechat.js";
import juice from "juice";
import fs from "node:fs/promises";

const WX_API = "https://api.weixin.qq.com/cgi-bin";

async function main() {
  const contentIdArg = process.argv.find((a) => a.startsWith("--id="))?.slice(5)
    || process.argv.find((a, i) => i >= 2 && !a.startsWith("--"));
  const skipUpload = process.argv.includes("--no-upload");

  // 1. 找 content
  let row: any;
  if (contentIdArg) {
    [row] = await db.select().from(contents).where(eq(contents.id, contentIdArg)).limit(1);
  } else {
    [row] = await db
      .select()
      .from(contents)
      .where(inArray(contents.status, ["reviewing", "approved", "draft", "published"]))
      .orderBy(desc(contents.createdAt))
      .limit(1);
  }
  if (!row) {
    console.error("找不到可预览的 content");
    process.exit(1);
  }
  console.log(`[wechat-preview] 使用 content: ${row.id} "${(row.title || "").slice(0, 40)}"`);

  const originalHtml = row.body || "";
  console.log(`[wechat-preview] 原 HTML 长度: ${originalHtml.length} chars`);

  // 2. juice
  let inlined = originalHtml;
  try {
    inlined = juice(originalHtml, { applyStyleTags: true, removeStyleTags: true });
    console.log(`[wechat-preview] juice 内联后长度: ${inlined.length} chars`);
  } catch (e) {
    console.warn("[wechat-preview] juice 失败:", e);
  }

  // 3. uploadimg（可选）
  let withWxImages = inlined;
  if (skipUpload) {
    console.log("[wechat-preview] --no-upload: 跳过图片上传，保留原 src");
  } else {
    // 需要一个真实 token：从第一个 wechat 账号解密 + 调 token 接口
    const [acct] = await db
      .select()
      .from(platformAccounts)
      .where(and(eq(platformAccounts.tenantId, row.tenantId), eq(platformAccounts.platform, "wechat")))
      .limit(1);
    if (!acct) {
      console.log("[wechat-preview] 无 wechat 账号，跳过 uploadimg");
    } else {
      const creds = decryptCredentialField(acct.credentials);
      const url = `${WX_API}/token?grant_type=client_credential&appid=${creds.appId}&secret=${creds.appSecret}`;
      const tResp = await fetch(url);
      const tData = (await tResp.json()) as any;
      if (tData.errcode) {
        console.warn("[wechat-preview] 拿 token 失败:", tData.errcode, tData.errmsg, "→ 跳过 uploadimg");
      } else {
        const imgCount = (inlined.match(/<img\b/gi) || []).length;
        console.log(`[wechat-preview] 将上传 ${imgCount} 张图到微信素材（占 uploadimg 配额）`);
        withWxImages = await uploadImagesToWechat(inlined, tData.access_token);
        console.log(`[wechat-preview] 上传后 HTML 长度: ${withWxImages.length} chars`);
      }
    }
  }

  // 4. 输出到 /tmp/wechat-preview.html
  const framed = `<!doctype html><html><head><meta charset="utf-8"><title>WeChat Preview: ${row.title}</title>
<style>body{margin:0;background:#ededed;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.wx-device{max-width:375px;margin:20px auto;background:#fff;min-height:800px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.wx-header{padding:12px 16px;border-bottom:1px solid #eaeaea;font-size:13px;color:#888}
.wx-title{padding:16px;font-size:22px;font-weight:600;color:#222;line-height:1.4}
.wx-body{padding:0 16px 24px;font-size:17px;line-height:1.75;color:#333}
.wx-body img{max-width:100%;height:auto;display:block;margin:12px 0}</style>
</head><body>
<div class="wx-device">
  <div class="wx-header">📱 微信公众号预览（模拟 375px 移动视口）</div>
  <div class="wx-title">${escapeHtml(row.title || "无标题")}</div>
  <div class="wx-body">${withWxImages}</div>
</div>
</body></html>`;

  await fs.writeFile("/tmp/wechat-preview.html", framed, "utf8");
  console.log("[wechat-preview] ✅ 已生成 /tmp/wechat-preview.html");
  console.log("[wechat-preview] 浏览器打开查看: open /tmp/wechat-preview.html");
  process.exit(0);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

main().catch((e) => {
  console.error("[wechat-preview] 失败:", e);
  process.exit(1);
});
