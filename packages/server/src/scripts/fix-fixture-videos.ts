/**
 * 存量占位样片内容的处置（8-12）。**默认只读，加 --apply 才写库。**
 *
 * ## 背景
 *
 * 8-12 实测：`contents` 里有 9 条 `body` 指向 `dvh-fixtures/*` 的视频。
 * 其中 4 条是 `query_failed_orphan`（已提交=已扣费，但取不回成片），
 * 状态却是 **draft**、无 `errorMessage`、无任何降级标记 ——
 * 在草稿箱里与正常视频**看不出区别**，而标题是真实期刊内容、
 * 片子是固定占位样片（片头还烧着与该刊无关的「IF6.2+工程技术1区」）。
 *
 * ## 处置口径（老板 8-12 定）
 *
 * > 宁可少几条视频，不能让假数据片挂着"成功"。
 *
 *   · 孤儿任务（已扣费）→ **status=failed + deferred(exhausted)**，转人工。
 *     🔴 不重置成「可自动重跑」：重跑 = 重提交 = **再付一次钱**。
 *     正确动作是凭 `orphanTaskUuid` 去阿里云捞回那条已付费的成片。
 *   · 7-30 那批测试产物（并发锁测试/幂等测试）→ **不动**，它们已经是 archived，
 *     没有"挂着成功"这个问题，动它反而丢失当时的测试痕迹。
 *
 * ## 用法
 *
 * ```bash
 * npx tsx src/scripts/fix-fixture-videos.ts            # 只看不改
 * npx tsx src/scripts/fix-fixture-videos.ts --apply    # 真改
 * ```
 */
import { sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { buildDeferred, markContentDeferred } from "../services/ops/deferred.js";
import { DvhOrphanTaskError } from "../services/digital-human/produce-video.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await db
    .select()
    .from(contents)
    .where(sql`${contents.body} like '%dvh-fixtures%'`);

  console.log(`指向 dvh-fixtures 的内容共 ${rows.length} 条\n`);

  const toFix: typeof rows = [];
  const skip: Array<{ row: (typeof rows)[number]; why: string }> = [];

  for (const r of rows) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    if (r.status === "archived") {
      skip.push({ row: r, why: "已 archived（7-30 测试产物），不动" });
      continue;
    }
    if (m.fallbackReason !== "query_failed_orphan") {
      skip.push({ row: r, why: `fallbackReason=${String(m.fallbackReason ?? "无")}，不在本次口径内` });
      continue;
    }
    toFix.push(r);
  }

  console.log(`【要改】${toFix.length} 条 —— 孤儿任务，置 failed + deferred(exhausted，转人工)`);
  for (const r of toFix) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    console.log(
      `   ${String(r.createdAt).slice(4, 21)} | ${r.status} → failed | task=${String(m.orphanTaskUuid ?? "?")} | ${(r.title ?? "").slice(0, 30)}`,
    );
  }
  console.log(`\n【不动】${skip.length} 条`);
  for (const s of skip) {
    console.log(`   ${String(s.row.createdAt).slice(4, 21)} | ${s.row.status} | ${s.why}`);
  }

  if (!APPLY) {
    console.log("\n（只读模式。确认无误后加 --apply 执行）");
    process.exit(0);
  }

  let ok = 0;
  for (const r of toFix) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const taskUuid = String(m.orphanTaskUuid ?? "");
    // 原稿：孤儿任务这批的 body 是占位样片 URL，口播稿原文没留下 ——
    //   所以 input.text 只能取标题兜底，并在 detail 里写明"重跑要先捞回"。
    //   这也是为什么新代码把 narrationText 落进 metadata（见 recordDvhArticleFailure）。
    const mark = buildDeferred({
      err: new DvhOrphanTaskError(taskUuid, "存量清理：已扣费但取不回成片"),
      detail: `已提交并扣费但取不回成片（task ${taskUuid}）— 需人工凭该 taskUuid 去阿里云捞回，**不要重跑**（重跑=再付一次钱）`,
      input: {
        kind: "dvh_text",
        tenantId: r.tenantId,
        userId: r.userId ?? "",
        text: String(m.narrationText ?? r.title ?? ""),
        title: r.title ?? "",
        templateId: String(m.templateId ?? ""),
      },
    });

    await db
      .update(contents)
      .set({
        status: "failed",
        errorMessage: `数字人任务已扣费但取不回成片（task ${taskUuid}）— 原内容是占位样片，非真渲染`,
        metadata: {
          ...m,
          placeholderVideo: true,
          paidButUnretrieved: true,
          fixedBy: "fix-fixture-videos 8-12",
        },
        updatedAt: new Date(),
      })
      .where(sql`${contents.id} = ${r.id}`);

    if (mark) await markContentDeferred(r.id, mark);
    ok++;
    console.log(`   ✔ ${r.id} → failed（exhausted=${mark?.exhausted ?? false}）`);
  }
  console.log(`\n完成：${ok}/${toFix.length} 条`);
  process.exit(0);
}

main().catch((e) => {
  console.error("失败：", e);
  process.exit(1);
});
