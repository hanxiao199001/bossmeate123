/**
 * 获客-2: 数字人混剪片尾 outro 叠企微客服二维码。
 * 二维码只在增强图叠(降级图不叠, 同进退); 只在纯色片尾帧上(结构上不压口型); lanczos 缩放保清晰。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("获客-2 wire — 片尾客服二维码", () => {
  it("env 有 WECOM_KF_QR_URL", async () => {
    const src = await readSrc("../config/env.ts");
    expect(src).toMatch(/WECOM_KF_QR_URL:\s*z\.string\(\)\.optional/);
  });

  it("video-remix: 下载 QR + movie 滤镜 overlay 到 outro", async () => {
    const src = await readSrc("../services/digital-human/video-remix.ts");
    expect(src).toMatch(/env\.WECOM_KF_QR_URL/);
    expect(src).toMatch(/movie='\$\{qrPath!.*\}'/);
    expect(src).toMatch(/flags=lanczos/); // 清晰不糊
    expect(src).toMatch(/\[outrobg\]\[kfqr\]overlay/);
    expect(src).toMatch(/outroChain/); // fc 用 outroChain 而非写死 outro
  });

  it("二维码只在 enhanced 路径(useQr = enhanced && qrPath) — 降级图不叠", async () => {
    const src = await readSrc("../services/digital-human/video-remix.ts");
    expect(src).toMatch(/useQr = enhanced && !!qrPath/);
  });

  it("上传脚本存在且用 qrcode 生成 + OSS put", async () => {
    const src = await readSrc("../../../../scripts/upload-kf-qr.mjs");
    expect(src).toMatch(/import QRCode from "qrcode"/);
    expect(src).toMatch(/QRCode\.toBuffer/);
    expect(src).toMatch(/errorCorrectionLevel:\s*"H"/); // 高纠错好扫
    expect(src).toMatch(/client\.put/);
  });
});
