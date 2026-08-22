#!/usr/bin/env bash
#
# 基线单向收缩闸 —— 不许把新失败写进白名单来消红。
#
# 没有这条，`known-failures.txt` 会变成"红了就加一行"，
# 一个月后它有 200 行，基线闸形同虚设 —— 与它要修的病完全一样。
#
#   缩小（删行）  → 一律放行，鼓励
#   扩大（加行）  → 必须在本 PR 的某条 commit message 里写
#                   BASELINE-EXPAND: <理由>
#                   这类 commit 因此单独可查：git log --grep='^BASELINE-EXPAND:'
set -uo pipefail

BASELINE=".github/known-failures.txt"
BASE_REF="${GITHUB_BASE_REF:-main}"

git fetch -q origin "$BASE_REF" || true

# 基线还没建 → 本闸无事可做（首次提交基线本身不算"扩大"）
if ! git cat-file -e "origin/$BASE_REF:$BASELINE" 2>/dev/null; then
  echo "基线尚未建立（origin/$BASE_REF 无 $BASELINE），跳过。"
  exit 0
fi

git show "origin/$BASE_REF:$BASELINE" | sort -u > /tmp/base_baseline.txt
if [ -f "$BASELINE" ]; then sort -u "$BASELINE" > /tmp/head_baseline.txt; else : > /tmp/head_baseline.txt; fi

added=$(comm -13 /tmp/base_baseline.txt /tmp/head_baseline.txt)
removed=$(comm -23 /tmp/base_baseline.txt /tmp/head_baseline.txt)

if [ -n "$removed" ]; then
  echo "✅ 基线缩小 $(echo "$removed" | grep -c .) 条 —— 这是我们要的方向。"
fi

if [ -z "$added" ]; then
  echo "✅ 基线未扩大。"
  exit 0
fi

echo "⚠️  基线扩大了 $(echo "$added" | grep -c .) 条："
echo "$added" | sed 's/^/    /'

if git log --format=%B "origin/$BASE_REF..HEAD" | grep -qE '^BASELINE-EXPAND:'; then
  echo
  echo "✅ 已在 commit message 中显式声明："
  git log --format=%B "origin/$BASE_REF..HEAD" | grep -E '^BASELINE-EXPAND:' | sed 's/^/    /'
  exit 0
fi

cat <<'MSG'

🔴 基线只许单向收缩。

  新失败的正确处置是 ①修代码 或 ②更新那条断言 —— 不是把它加进白名单。
  「红了就加进基线」一个月后就会让这道闸形同虚设，与它要修的病完全一样。

  确实必须扩大（例如引入了一个已知会红、但另有排期的第三方升级）：
  在本 PR 的某条 commit message 里写一行

      BASELINE-EXPAND: <为什么这条必须先躺进基线，谁在什么时候收>

  这类 commit 因此单独可查：git log --grep='^BASELINE-EXPAND:'
MSG
exit 1
