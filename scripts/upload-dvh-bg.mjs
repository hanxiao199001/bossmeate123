#!/usr/bin/env node
/**
 * 5-23 PR #243 — 一次性脚本: 上传 DVH 背景图到 BossMate OSS, 返回 public URL.
 *
 * 用法 (prod):
 *   1. 把图存到本地 (推荐 1080×1920 竖屏 或 1920×1080 横屏)
 *   2. node scripts/upload-dvh-bg.mjs <local-image-path> [oss-key]
 *      e.g. node scripts/upload-dvh-bg.mjs ~/Desktop/dvh-bg-lab.jpg dvh-backgrounds/lab-001.jpg
 *   3. 输出 URL → 写到 .env DVH_DEFAULT_BG_URL
 *
 * 注意: 需要 prod .env 里有 OSS_ENDPOINT/OSS_BUCKET/OSS_ACCESS_KEY/OSS_SECRET_KEY.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("用法: node scripts/upload-dvh-bg.mjs <local-image-path> [oss-key]");
  process.exit(1);
}

const localPath = args[0];
const defaultKey = `dvh-backgrounds/${Date.now()}-${basename(localPath)}`;
const ossKey = args[1] || defaultKey;

const env = {
  endpoint: process.env.OSS_ENDPOINT,
  bucket: process.env.OSS_BUCKET,
  accessKeyId: process.env.OSS_ACCESS_KEY,
  accessKeySecret: process.env.OSS_SECRET_KEY,
};
for (const [k, v] of Object.entries(env)) {
  if (!v) {
    console.error(`缺 env: ${k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`);
    process.exit(1);
  }
}

const ext = extname(localPath).toLowerCase();
const contentType =
  ext === ".png" ? "image/png" :
  ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
  ext === ".webp" ? "image/webp" :
  "application/octet-stream";

console.log(`[upload] 读图: ${localPath}`);
const buffer = await readFile(localPath);
console.log(`[upload] 文件大小: ${(buffer.length / 1024).toFixed(1)} KB, type=${contentType}`);

const OSS = (await import("ali-oss")).default;
const client = new OSS({
  endpoint: env.endpoint,
  bucket: env.bucket,
  accessKeyId: env.accessKeyId,
  accessKeySecret: env.accessKeySecret,
  // 与 services/storage/index.ts 同口径: 不加这行 result.url 是 http://,
  // 写进 .env DVH_DEFAULT_BG_URL 后前端预览会被浏览器按混合内容拦掉。见那边的完整说明。
  secure: true,
});

console.log(`[upload] 上传到 OSS key=${ossKey} ...`);
const result = await client.put(ossKey, buffer, { headers: { "Content-Type": contentType } });
console.log(`[upload] ✅ URL: ${result.url}`);
console.log(`\n下一步: 写入 prod .env`);
console.log(`  echo 'DVH_DEFAULT_BG_URL=${result.url}' >> .env`);
console.log(`  pm2 restart bossmate-server`);
