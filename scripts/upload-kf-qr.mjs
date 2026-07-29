#!/usr/bin/env node
/**
 * 获客-2 一次性脚本: 用企微客服接待链接生成二维码 PNG → 上传 BossMate OSS → 返回 public URL。
 * 混剪片尾 outro 叠加该二维码。
 *
 * 用法 (prod, 需 .env 有 OSS_* + WECOM_KF_URL):
 *   set -a && source .env && set +a
 *   node scripts/upload-kf-qr.mjs [kf-link] [oss-key]
 *   - kf-link 省略则读 env.WECOM_KF_URL
 *   - 输出 URL → 写到 .env WECOM_KF_QR_URL, pm2 restart
 */
import QRCode from "qrcode";

const args = process.argv.slice(2);
const kfLink = args[0] || process.env.WECOM_KF_URL;
const ossKey = args[1] || "kf-assets/kf-qr.png";
if (!kfLink) { console.error("缺 kf-link (参数或 env.WECOM_KF_URL)"); process.exit(1); }

const oss = {
  endpoint: process.env.OSS_ENDPOINT, bucket: process.env.OSS_BUCKET,
  accessKeyId: process.env.OSS_ACCESS_KEY, accessKeySecret: process.env.OSS_SECRET_KEY,
};
for (const [k, v] of Object.entries(oss)) {
  if (!v) { console.error(`缺 env: OSS_${k.replace(/([A-Z])/g, "_$1").toUpperCase().replace(/^_/, "")}`); process.exit(1); }
}

console.log(`[qr] 为链接生成二维码: ${kfLink.slice(0, 60)}...`);
// 高纠错(H) + 白底黑码 + 4 模块 quiet zone + 大尺寸(1080)保证扫描清晰
const buffer = await QRCode.toBuffer(kfLink, {
  errorCorrectionLevel: "H", type: "png", margin: 4, width: 1080,
  color: { dark: "#000000ff", light: "#ffffffff" },
});
console.log(`[qr] PNG 大小: ${(buffer.length / 1024).toFixed(1)} KB`);

const OSS = (await import("ali-oss")).default;
// secure: 不加则 result.url 是 http://, 而这个 URL 是**客服二维码**要挂到页面/给客户扫的,
//   https 页面下会被混合内容拦掉。与 services/storage/index.ts 同口径, 见那边完整说明。
const client = new OSS({ ...oss, secure: true });
console.log(`[upload] 上传 OSS key=${ossKey} ...`);
const result = await client.put(ossKey, buffer, { headers: { "Content-Type": "image/png" } });
console.log(`[upload] ✅ URL: ${result.url}`);
console.log(`\n下一步: 写入 prod .env`);
console.log(`  echo 'WECOM_KF_QR_URL=${result.url}' >> .env && pm2 restart bossmate-server`);
