/**
 * 摘掉 `contents.body` 里的占位/测试素材 URL（8-13）。**默认只读，加 --apply 才写库。**
 *
 * ## 为什么"改成 failed"还不够
 *
 * 8-13：5 条孤儿内容已置 `failed` + 真实原因文案，但老韩在内容工坊**照样看得见** ——
 * `routes/content.ts` 的状态过滤是**条件式**的（前端不传 `status` 就不加条件），
 * 于是 failed 记录仍在列表里，仍带着真实标题、仍指向 `placeholder-3.mp4`，
 * 点开仍播那条烧着「IF6.2」和无关期刊封面的片子。
 *
 * **状态语义修好了，可见性没修。** 一条能播放、有真实标题、内容是假数据的记录，
 * 挂着 `failed` 也还是「假成品挂在那」（红线 #14 的口径）。
 *
 * ## 统一规则，不留特例
 *
 * > `contents.body` 永远不指向占位/测试素材。
 *
 * 10 条全摘，包括 7-30 那 5 条 archived 的测试产物 ——
 * 「测试痕迹」由 metadata 留证（原 URL、原 body、处置时间都在），
 * 痕迹保住了、假片不可播了。统一规则优于"failed 的摘、archived 的留"这种
 * 要人记住的分叉：分叉迟早会被记错。
 *
 * 幂等：已摘过的（metadata.bodyStrippedAt 存在）跳过。
 *
 * ```bash
 * npx tsx src/scripts/strip-placeholder-body.ts          # 只看
 * npx tsx src/scripts/strip-placeholder-body.ts --apply  # 真改
 * ```
 */
import { eq } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { PLACEHOLDER_ASSET_MARKERS } from "../services/publisher/output-health.js";

const APPLY = process.argv.includes("--apply");

/** 摘换后的 body —— 说明写给运营看，不是给机器读的 */
function explain(status: string, m: Record<string, unknown>): string {
  const task = String(m.orphanTaskUuid ?? "");
  if (m.providerFailCode || m.paidButFailed) {
    return (
      `【该视频未生成成功，原内容为占位样片，已移除】\n` +
      `真实原因：任务在阿里云侧失败（${String(m.providerFailCode ?? "10010002")} ` +
      `${String(m.providerFailReason ?? "图片分辨率必须与输出的视频分辨率一致")}），已扣费但无成片产出。\n` +
      (task ? `任务号：${task}\n` : "") +
      `根因已修复（背景图上传自动归一 + 提交前分辨率闸），重新生成即可。`
    );
  }
  if (status === "archived") {
    return (
      `【测试产物，原内容为占位样片，已移除】\n` +
      `2026-07-30 并发/幂等测试留下的记录，非真实生成结果。保留此行仅为测试痕迹。`
    );
  }
  return `【该视频未生成成功，原内容为占位样片，已移除】`;
}

async function main() {
  const rows = await db.select().from(contents).where(eq(contents.type, "video"));

  const hits = rows.filter((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const hay = `${r.body ?? ""}\n${String(m.videoUrl ?? "")}\n${String(m.rawVideoUrl ?? "")}`;
    return PLACEHOLDER_ASSET_MARKERS.some((mk) => hay.includes(mk));
  });

  const todo = hits.filter((r) => !((r.metadata ?? {}) as Record<string, unknown>).bodyStrippedAt);
  const done = hits.length - todo.length;

  console.log(`video 总数 ${rows.length} ｜ 命中占位素材 ${hits.length} 条 ｜ 已摘过 ${done} ｜ 待摘 ${todo.length}\n`);
  for (const r of todo) {
    console.log(`   ${String(r.createdAt).slice(4, 21)} | ${r.status.padEnd(10)} | ${(r.title ?? "").slice(0, 28)}`);
    console.log(`       body: ${String(r.body ?? "").slice(-46)}`);
  }

  if (!APPLY) {
    console.log("\n（只读模式。确认后加 --apply）");
    process.exit(0);
  }

  let ok = 0;
  for (const r of todo) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    await db
      .update(contents)
      .set({
        body: explain(r.status, m),
        metadata: {
          ...m,
          // 🔴 留证：原 URL 与原 body 都存着，测试痕迹/排障线索一条不丢
          strippedBodyOriginal: String(r.body ?? "").slice(0, 500),
          strippedVideoUrl: String(m.videoUrl ?? "") || undefined,
          strippedRawVideoUrl: String(m.rawVideoUrl ?? "") || undefined,
          bodyStrippedAt: new Date().toISOString(),
          bodyStrippedBy: "strip-placeholder-body 8-13",
          placeholderVideo: true,
        },
        updatedAt: new Date(),
      })
      .where(eq(contents.id, r.id));
    ok++;
    console.log(`   ✔ ${r.id} (${r.status})`);
  }
  console.log(`\n完成 ${ok}/${todo.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
