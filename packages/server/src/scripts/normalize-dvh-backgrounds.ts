/**
 * 存量数字人背景图归一化（8-18）。**默认只读，加 --apply 才写。**
 *
 * ## 为什么需要它
 *
 * 8-13 修的是**上传侧**（新图自动归一到 1080×1920 / 1920×1080）。
 * 存量图没人处理 —— 实测图库里唯一那张（7-31 上传，1600×2848）不合规，
 * 于是每一条带背景的数字人视频都必然撞上提交前的分辨率闸：
 *
 * ```
 * dvh_bg_resolution_rejected   8-13 一次 · 8-14 一次 · 8-18 一次
 * ```
 *
 * 闸每次都拦住了（零扣费、落 incident、内容标 failed），**但产出永远是 0**。
 * 止血成功不等于治病。
 *
 * ## 处置口径
 *
 * · 能取回原图 → 用 `sharp` 归一到精确尺寸，传回 OSS，更新库记录的 width/height
 * · 取不回原图 → **标记不可用**，不留一条"看起来能选但一定失败"的记录
 *   （红线 #14 的同构：不可用的东西必须在数据上可区分）
 *
 * 归一化复用与上传侧**同一套参数**（`DVH_OUTPUT_SIZE` + cover 裁切），
 * 不另写一份缩放逻辑 —— 两套参数迟早会漂。
 *
 * ```bash
 * npx tsx src/scripts/normalize-dvh-backgrounds.ts          # 只看
 * npx tsx src/scripts/normalize-dvh-backgrounds.ts --apply  # 真改
 * ```
 */
import sharp from "sharp";
import { storage } from "../services/storage/index.js";
import {
  loadDvhBackgrounds,
  saveDvhBackgrounds,
  isBackgroundUsableForGeneration,
  DVH_OUTPUT_SIZE,
  type DvhBackground,
} from "../services/digital-human/background-library.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const list = await loadDvhBackgrounds();
  console.log(`图库存量 ${list.length} 张\n`);

  const bad = list.filter((b) => !isBackgroundUsableForGeneration(b));
  console.log(`不合规 ${bad.length} 张：`);
  for (const b of bad) {
    const want = DVH_OUTPUT_SIZE[b.orientation];
    console.log(`   ${b.id}  ${b.name}  ${b.width}×${b.height} → 应为 ${want.width}×${want.height}`);
  }
  if (bad.length === 0) {
    console.log("   （无）");
    process.exit(0);
  }

  if (!APPLY) {
    console.log("\n（只读模式。确认后加 --apply）");
    process.exit(0);
  }

  const updated: DvhBackground[] = [...list];
  let ok = 0;
  let marked = 0;

  for (const b of bad) {
    const want = DVH_OUTPUT_SIZE[b.orientation];
    try {
      const res = await fetch(b.url);
      if (!res.ok) throw new Error(`取原图失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      /**
       * 🔴 先备份再覆盖。**裁切不可逆** —— cover 会按 attention 焦点裁掉长边，
       * 万一把人物/主体切掉了，没有原图就回不去了。
       * 备份用 `_original` 后缀另存，不动原对象。
       */
      const origPath = `${(b.remotePath ?? `dvh-backgrounds/${b.id}`).replace(/\.([a-z]+)$/i, "")}_original.$1`
        .replace("$1", (b.remotePath?.match(/\.([a-z]+)$/i)?.[1] ?? "png"));
      const backupUrl = await storage.upload(buf, origPath, "image/png");
      console.log(`   ↳ 原图已备份: ${origPath}`);

      // 与上传侧同一套：cover 裁切到精确尺寸（比例已在上传时校过，这里只做最终对齐）
      const out = await sharp(buf)
        .resize(want.width, want.height, { fit: "cover", position: "attention" })
        .toBuffer();

      // 用与上传侧同一个 storage 抽象, 不另接一套 OSS 客户端
      const newPath = `${(b.remotePath ?? `dvh-backgrounds/${b.id}`).replace(/\.[a-z]+$/i, "")}-${want.width}x${want.height}.png`;
      const newUrl = await storage.upload(out, newPath, "image/png");

      const i = updated.findIndex((x) => x.id === b.id);
      updated[i] = {
        ...b,
        url: newUrl,
        remotePath: newPath,
        width: want.width,
        height: want.height,
        // 留退路：裁错构图时凭它取回原图
        originalUrl: backupUrl,
        originalSize: `${b.width}x${b.height}`,
      } as DvhBackground;
      ok++;
      console.log(`   ✔ 已归一 ${b.id} → ${want.width}×${want.height}`);
    } catch (err) {
      // 取不回/传不上 → 标记不可用，绝不留一条"看起来能选但一定失败"的记录
      const i = updated.findIndex((x) => x.id === b.id);
      updated[i] = { ...b, name: `${b.name}（尺寸不合规·不可用）` };
      marked++;
      console.log(`   ⚠️ ${b.id} 归一失败，已标记不可用：${err instanceof Error ? err.message : err}`);
    }
  }

  await saveDvhBackgrounds(updated);
  console.log(`\n完成：归一 ${ok} 张 · 标记不可用 ${marked} 张`);
  process.exit(0);
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
