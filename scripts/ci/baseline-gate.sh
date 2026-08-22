#!/usr/bin/env bash
#
# CI 基线闸 —— 把红线 #12 规则 3「新增失败=阻塞项」从「靠人记得」升到「合并前拦住」。
#
# ═══ 为什么不是「全绿才过」═══
#
# 2026-08-22 查：最近 200 次 CI  failure 198 / cancelled 2 / success 0，
# 往前翻不到任何一次绿。
#
# 根因有两层，别只记住第二层：
#   ① CI 两个 job 都死在 `pnpm/action-setup`（version 与 packageManager 双写冲突），
#      **从没到过 tsc / vitest** —— 建 CI 那天(6-10)起就是这样。
#   ② 就算把 ① 修好，全量基线 72 红会让 `vitest run` 照样恒非零 → CI 还是恒红。
#
#   恒红的 CI = 命中率 100% 的检查器 = 零信息量。
#
# 这正是 Phase 1 判定规则第一条（命中率 ≈100% → 常数判据，零判别力），
# 我们把它写给了内容检查器，却没想到同样适用于 CI。
# 而且它比没有 CI 更坏 —— 它的存在让每个人以为"有闸在把关"。
# a892a64 带着 3 个新失败合进 main 不是意外：在一片红里多三条红，
# 系统里没有任何东西会变化。
#
# ═══ 判据 ═══
#
#   comm -13 基线 本次   非空 = 新增失败  → 🔴 红，且**不许通过改基线消红**
#   comm -23 基线 本次   非空 = 修好了    → ✅ 提示缩小基线（鼓励）
#
# ═══ 基线文件必须单向收缩 ═══
#
# 若允许"红了就把它加进白名单"，一个月后 known-failures.txt 会有 200 行，
# 闸又形同虚设。所以扩大基线要显式：commit message 写 `BASELINE-EXPAND: <理由>`，
# 这类 commit 因此单独可查（`git log --grep='^BASELINE-EXPAND:'`）。
#
# ═══ 环境对齐（红线 #12 规则 6）═══
#
# 基线必须在**跑它的同一个环境**里生成。服务器与 CI 的 env 不同，失败集也不同，
# 拿一边的清单去 comm 另一边 = 垃圾进垃圾出。
# 识别信号：两次运行的**总用例数**对不上 —— 本脚本会打印它。
# 故本脚本自举：基线文件不存在时，产出候选清单并通过（带醒目提示），
# 由人看过之后提交它。绝不自动写基线 —— 那等于没有基线。
set -uo pipefail

BASELINE="${BASELINE_FILE:-.github/known-failures.txt}"
OUT="${RUNNER_TEMP:-/tmp}/vitest-result.json"
NOW="${RUNNER_TEMP:-/tmp}/now-failures.txt"

echo "── 跑全量单测 ──"
npx vitest run --reporter=json --outputFile="$OUT" >/dev/null 2>&1
[ -f "$OUT" ] || { echo "✗ vitest 没产出 JSON（$OUT），无法判定。"; exit 1; }

# 失败用例 ID = <相对文件路径>::<完整用例名>。用 file+name 而非序号，改动顺序不会误报。
#
# 🔴 **套件加载失败必须单独捞**（8-22 实测踩到）：
#   import 挂掉的文件在 JSON 里是 `status:"failed"` + `assertionResults: []` ——
#   只遍历 assertionResults 的话它**一条失败都不产出**，闸直接放行。
#   那正是本项目反复写红线的那类病：坏产物与好产物在下游无法区分（红线 #14）。
#   实测：`zz-collect-boom.test.ts` 引一个不存在的模块 → 旧提取器输出 0 条。
node -e '
const r = require(process.argv[1]);
const root = process.cwd() + "/";
const fails = [];
let total = 0, suiteErrors = 0;
for (const f of r.testResults ?? []) {
  const file = (f.name ?? "").startsWith(root) ? f.name.slice(root.length) : f.name;
  const as = f.assertionResults ?? [];
  for (const a of as) {
    total++;
    if (a.status === "failed") fails.push(file + "::" + (a.fullName ?? a.title));
  }
  // 整个文件没跑起来：没有任何用例结果，但套件本身是 failed
  if (f.status === "failed" && as.length === 0) {
    suiteErrors++;
    // 🔴 消息必须归一化后才能进基线：原始文本里带**绝对路径**
    //   （本地 /tmp/wt_xxx、CI /home/runner/work/...），不剥掉的话同一个故障
    //   在两个环境里是两条不同的记录，基线永远对不上 —— 判据会因环境而变，等于没有判据。
    const msg = String(f.message ?? "").split("\n")[0]
      .split(" imported from ")[0]          // 引入方路径，纯环境噪声
      .split(root).join("")                 // 仓库根前缀
      .replace(/\/[^\s\x27"]*\/(node_modules|packages|apps)\//g, "$1/")
      .trim();
    fails.push(file + "::‹套件加载失败› " + msg.slice(0, 120));
  }
}
console.error("总用例数 " + total + " / 失败用例 " + (fails.length - suiteErrors) + " / 套件加载失败 " + suiteErrors);
require("fs").writeFileSync(process.argv[2], String(total));
process.stdout.write([...new Set(fails)].sort().join("\n") + (fails.length ? "\n" : ""));
' "$OUT" "${RUNNER_TEMP:-/tmp}/total-cases.txt" > "$NOW"

TOTAL_NOW=$(cat "${RUNNER_TEMP:-/tmp}/total-cases.txt" 2>/dev/null || echo "")
echo "本次失败 $(grep -c . "$NOW" 2>/dev/null || echo 0) 条"

# ── 自举：基线还没建 ───────────────────────────────────────────────
if [ ! -f "$BASELINE" ]; then
  echo
  echo "⚠️  基线文件不存在：$BASELINE"
  echo "    本次运行的失败清单已产出为 artifact。**看过之后**把它提交为基线，闸才开始工作。"
  echo "    刻意不自动写入 —— 自动生成的基线 = 没有基线。"
  {
    echo "# total_cases=${TOTAL_NOW:-unknown}"
    echo "# 生成于 CI（红线 #12 规则 6：基线必须在跑它的同一个环境里量）"
    cat "$NOW"
  } > "${RUNNER_TEMP:-/tmp}/known-failures.candidate.txt"
  exit 0
fi

# `# ` 开头的是元信息行（total_cases 等），不参与失败集比对
grep -v '^#' "$BASELINE" | grep . | sort -u > "${RUNNER_TEMP:-/tmp}/baseline.sorted"

# 环境对齐检查（红线 #12 规则 6）：总用例数对不上 = 两次跑的不是同一批，对比无效。
# 只在**变少**时告警 —— 加测试让它变多是正常的。不硬拦：删测试也是合法动作。
TOTAL_BASE=$(grep -o '^# total_cases=[0-9]*' "$BASELINE" 2>/dev/null | head -1 | cut -d= -f2)
if [ -n "${TOTAL_BASE:-}" ] && [ -n "${TOTAL_NOW:-}" ] && [ "$TOTAL_NOW" -lt "$TOTAL_BASE" ]; then
  echo
  echo "⚠️  总用例数 $TOTAL_BASE → $TOTAL_NOW（少了 $((TOTAL_BASE - TOTAL_NOW)) 条）。"
  echo "    要么删了测试，要么有文件没跑起来 —— 后者请看上面的『套件加载失败』条目。"
  echo "    红线 #12 规则 6：两次运行总用例数对不上 = 环境没对齐，此时任何对比都不可靠。"
fi

added=$(comm -13 "${RUNNER_TEMP:-/tmp}/baseline.sorted" "$NOW")
fixed=$(comm -23 "${RUNNER_TEMP:-/tmp}/baseline.sorted" "$NOW")

if [ -n "$fixed" ]; then
  n=$(echo "$fixed" | grep -c .)
  echo
  echo "✅ 修好了 $n 条（基线可以缩小，请把它们从 $BASELINE 删掉）："
  echo "$fixed" | sed 's/^/    /'
fi

if [ -n "$added" ]; then
  n=$(echo "$added" | grep -c .)
  echo
  echo "🔴 新增失败 $n 条 —— 红线 #12 规则 3：新增失败 = 真回归嫌疑 = 阻塞项。"
  echo "$added" | sed 's/^/    /'
  echo
  echo "  默认判定：你的改动引入了回归。两条路 ——"
  echo "    ① 你改坏了功能        → 修代码"
  echo "    ② 你合理改了行为      → 更新那条断言（不是把它加进基线）"
  echo
  echo "  🔴 把新失败写进 $BASELINE 来消红是被禁止的。"
  echo "     基线单向收缩；确需扩大 → commit message 写 BASELINE-EXPAND: <理由>。"
  exit 1
fi

echo
echo "✅ 零新增失败。基线 $(grep -c . "${RUNNER_TEMP:-/tmp}/baseline.sorted") 条。"
exit 0
