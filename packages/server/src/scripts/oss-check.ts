/**
 * 6-26 OSS 体检(不碰生产存储): 直接拿 OSS 凭证单独测 写/签名/公共读/删,确认通了再 flip 全局切。
 *   避免"切全局→坏→回退"那一圈。
 * 用法(服务器 packages/server 下, 把 4 个值设进环境变量再跑, 不写 .env、不影响 app):
 *   OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com OSS_BUCKET=bossmate-media \
 *   OSS_ACCESS_KEY=$AKID OSS_SECRET_KEY=$AKSEC pnpm oss:check
 */
async function main() {
  const endpoint = process.env.OSS_ENDPOINT;
  const bucket = process.env.OSS_BUCKET;
  const accessKeyId = process.env.OSS_ACCESS_KEY;
  const accessKeySecret = process.env.OSS_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) {
    console.error("❌ 需设全 OSS_ENDPOINT / OSS_BUCKET / OSS_ACCESS_KEY / OSS_SECRET_KEY 再跑");
    process.exit(1);
  }
  console.log(`\n🩺 OSS 体检  bucket=${bucket}  endpoint=${endpoint}  key=${accessKeyId.slice(0, 8)}…\n`);

  // @ts-ignore ali-oss 运行时依赖
  const OSS = (await import("ali-oss")).default;
  // secure: 体检脚本也要按生产同口径连, 否则它打印的签名 URL 是 http://,
  //   而生产(storage/index.ts)已是 https —— 体检结果与线上不一致, 等于白检。
  const client = new OSS({ endpoint, bucket, accessKeyId, accessKeySecret, secure: true });
  const key = `oss-check/ping-${Date.now()}.txt`;

  // ① 写(测 RAM 用户有没有 OSS 写权限 — 上次报的就是这步)
  try {
    await client.put(key, Buffer.from("bossmate oss check"));
    console.log("① 上传(写) ✅ OK  → RAM 用户有 OSS 写权限");
  } catch (e: any) {
    console.error(`① 上传(写) ❌ 失败: ${e?.code || ""} ${e?.message || e}`);
    if (/AccessDenied|no right|acl/i.test(String(e?.message))) console.error("   → 这个 key 的 RAM 用户没 OSS 权限, 去 RAM 加 AliyunOSSFullAccess");
    if (/NoSuchBucket/i.test(String(e?.message))) console.error("   → 桶名/区域不对(endpoint 跟桶所在区要一致)");
    process.exit(1);
  }

  // ② 签名 URL(DVH 音频/字幕用这个 — 私有也能拉)
  const signed = client.signatureUrl(key, { expires: 600 });
  console.log(`② 签名URL ✅  ${signed.slice(0, 90)}…`);

  // ③ 匿名公共读(用户看的卡片/视频用裸URL — 要桶 ACL=公共读)
  const pub = `https://${bucket}.${endpoint}/${key}`;
  try {
    const r = await fetch(pub);
    if (r.status === 200) console.log(`③ 公共读(匿名GET) ✅ 200  → 桶 ACL=公共读 已生效  ${pub}`);
    else console.log(`③ 公共读(匿名GET) ⚠️ ${r.status}  → 桶可能还是私有/没点「设置」, 用户看图会${r.status === 403 ? "403" : "异常"}  ${pub}`);
  } catch (e: any) {
    console.log(`③ 公共读测试网络异常: ${e?.message || e}`);
  }

  // ④ 清理
  try { await client.delete(key); console.log("④ 清理 ✅ OK"); } catch { console.log("④ 清理跳过(不影响)"); }

  console.log(`\n—— 判读 ——`);
  console.log(`①✅ + ③✅  → 全通, 可以 flip 全局切 OSS(写权限+公共读都对)`);
  console.log(`①✅ + ③⚠️  → 写通了但桶还没公共读 → 去桶 ACL 改公共读+点「设置」(否则用户看图403)`);
  console.log(`①❌        → RAM 权限没加成 → 去 RAM 给那用户加 AliyunOSSFullAccess\n`);
}
main().catch((e) => { console.error("体检异常:", e instanceof Error ? e.message : e); process.exit(1); });
