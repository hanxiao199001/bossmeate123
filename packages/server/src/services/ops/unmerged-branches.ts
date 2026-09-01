/**
 * 「未部署改动」盘点 (9-01)。
 *
 * ## 为什么加这个
 *
 * 8-26 到 9-01 一周内, 同一个规律复现了**三次**:
 *
 * ```
 * 8-26 预测了主备模型共享百炼账户   → 没行动 → 8-31 原样爆, 370 篇失败
 * 8-26 写完了备份系统               → 没部署 → 9-01 盘点时仍是零备份
 * 8-26 写完了欠费告警的账户修正      → 没部署 → 8-31 告警又念了一遍错账户
 * ```
 *
 * 三次的共同形态不是「没想到」, 是**「写了没上线」**。
 *
 * > 预测对了但没行动, 和没预测到, 后果完全一样。
 * > 代码写完但没部署, 和没写, 生产上是同一回事。
 *
 * 而这件事**此前没有任何出口**: 分支躺在远端, 没有人、没有报表会提起它。
 * 它不产生任何失败信号 —— 一个没上线的修复不会报错, 它只是不存在。
 * 这和 ops/backup.ts 里那条是同一句话: **可观测体系只能看见「以失败形态存在的失败」**,
 * 而「没做」永远不以失败的形态出现, 只能靠正向清点发现。
 *
 * ## 🔴 这个检查自己不许静默失败
 *
 * 如果 `git fetch` 挂了(跨境链路实测会 hang, 见 scripts/deploy-with-fallback.sh 的注释)
 * 而本函数返回空列表, 周报就会显示「没有未部署改动」—— 一句**读起来像好消息的假话**,
 * 恰好是它要治的那个病。所以取数失败必须以 `error` 形态返回, 由周报原样报出来。
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../../config/logger.js";

const exec = promisify(execFile);

/** 超过这个天数还没合进 main 的分支要点名 */
export const STALE_BRANCH_DAYS = 3;
/**
 * 超过这个天数的不再逐条点名, 只报个数。
 *
 * 🔴 为什么要分桶(9-01 实测发现): 本仓库有 **91 个**未合入 main 的远端分支,
 * 绝大多数是 5 月的僵尸 —— squash 合并之后分支尖端不再是 main 的祖先,
 * `--no-merged` 会永远把它们判成"未合"。
 *
 * **一条列 91 项的告警等于没有告警**: 真正需要上线的那两三个会被埋掉,
 * 而本节存在的全部理由就是让它们被看见。
 *
 * 所以分两桶, 各自对应一个不同的动作:
 *   · 3~30 天  → 「待上线」, 逐条点名, 动作是**部署**
 *   · > 30 天  → 「陈旧」,   只报个数, 动作是**清理**
 *
 * 陈旧那桶**不隐藏**(个数照报) —— 按 CLAUDE.md 的规矩, 被折叠的东西必须说出来,
 * 否则读者会以为"只有这几个"。
 */
export const ABANDONED_BRANCH_DAYS = 30;

export interface UnmergedBranch {
  name: string;
  ageDays: number;
  lastCommitAt: string;
  subject: string;
}

export interface UnmergedBranchesResult {
  /** 3~30 天: 需要**部署**的 */
  branches: UnmergedBranch[];
  /** > 30 天: 需要**清理**的, 只计数不逐条列 */
  abandonedCount: number;
  /** 取数失败时的原因; 非 null 时 branches 无意义, **不许当成"没有未部署改动"** */
  error: string | null;
}

async function git(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/**
 * 列出超过 N 天未合入 main 的远端分支。
 *
 * @param repoDir 仓库路径(生产上是 /home/projects/bossmate)
 */
export async function listStaleUnmergedBranches(
  now: Date = new Date(),
  repoDir: string = process.cwd(),
  days: number = STALE_BRANCH_DAYS,
): Promise<UnmergedBranchesResult> {
  try {
    // ① 先 fetch —— 服务器平时只 fetch main(见 deploy-with-fallback.sh),
    //    不 fetch 就看不到别人推上去的分支, 会漏报成"干净"。
    //    30s 超时: 跨境链路会 hang, 宁可报错也不要卡住整个周报。
    await git(["fetch", "--prune", "origin"], repoDir, 30_000);

    // ② 列出所有未合入 origin/main 的远端分支 + 最后提交时间
    const out = await git(
      [
        "for-each-ref",
        "--format=%(refname:short)\t%(committerdate:iso8601)\t%(contents:subject)",
        "--no-merged=origin/main",
        "refs/remotes/origin",
      ],
      repoDir,
      20_000,
    );

    const branches: UnmergedBranch[] = [];
    let abandonedCount = 0;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [refRaw, dateRaw, ...rest] = line.split("\t");
      const name = refRaw.replace(/^origin\//, "");
      if (name === "main" || name === "HEAD") continue;
      const at = new Date(dateRaw);
      if (Number.isNaN(at.getTime())) continue;
      const ageDays = Math.floor((now.getTime() - at.getTime()) / 86400_000);
      if (ageDays < days) continue;
      if (ageDays > ABANDONED_BRANCH_DAYS) { abandonedCount += 1; continue; }
      branches.push({
        name,
        ageDays,
        lastCommitAt: dateRaw.slice(0, 10),
        subject: (rest.join("\t") || "").slice(0, 80),
      });
    }
    branches.sort((a, b) => b.ageDays - a.ageDays);
    return { branches, abandonedCount, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "未部署改动检查失败");
    // 🔴 不返回空列表 —— 见文件头
    return { branches: [], abandonedCount: 0, error: msg.slice(0, 200) };
  }
}

/** 渲染成周报里的几行。判据与渲染分开, 便于单测 */
export function renderUnmergedBranches(r: UnmergedBranchesResult): string[] {
  if (r.error) {
    return [
      `  ⚠️ 未部署改动**没查成**(≠ 没有未部署改动): ${r.error}`,
      "     —— 请手动看一眼 GitHub 上的分支列表。",
    ];
  }
  // > 30 天那桶单独一行 —— 折叠了什么必须说出来, 不做静默截断
  const tail = r.abandonedCount > 0
    ? [`  另有 ${r.abandonedCount} 个超过 ${ABANDONED_BRANCH_DAYS} 天的陈旧分支（多为 squash 合并后没删的残枝，动作是**清理**不是部署，不逐条列）。`]
    : [];

  if (r.branches.length === 0) {
    return [`  ✅ 没有 ${STALE_BRANCH_DAYS}~${ABANDONED_BRANCH_DAYS} 天内待上线的分支。`, ...tail];
  }
  return [
    `  🔴 ${r.branches.length} 个分支超过 ${STALE_BRANCH_DAYS} 天未合入 main —— 这些改动**在生产上等于不存在**:`,
    ...r.branches.map((b) => `     · ${b.name}（${b.ageDays} 天，最后提交 ${b.lastCommitAt}）${b.subject ? ` — ${b.subject}` : ""}`),
    "     8-26→9-01 一周内「写了没上线」复现三次, 其中一次代价是 370 篇内容。",
    ...tail,
  ];
}
