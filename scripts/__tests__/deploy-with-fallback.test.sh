#!/usr/bin/env bash
# 静态断言 deploy-with-fallback.sh 的关键修复点（grep + bash -n）。
# 不跑运行时 mock（bash mock 易因 cat stdin 阻塞 / sed 跨平台问题脆裂），
# 用 grep 验证脚本源码包含修复 invariant 即可。
#
# 用法：./scripts/__tests__/deploy-with-fallback.test.sh
# 退出码 0 = 全 PASS / 非 0 = 至少一项 FAIL。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/deploy-with-fallback.sh"
PASS=0; FAIL=0

assert_grep() {
  local desc="$1" pattern="$2"
  if grep -qE "$pattern" "$SCRIPT"; then
    echo "  ✅ $desc"; PASS=$((PASS+1))
  else
    echo "  ❌ $desc — pattern '$pattern' missing"; FAIL=$((FAIL+1))
  fi
}

assert_not_grep() {
  local desc="$1" pattern="$2"
  if grep -qE "$pattern" "$SCRIPT"; then
    echo "  ❌ $desc — unexpected '$pattern' present"; FAIL=$((FAIL+1))
  else
    echo "  ✅ $desc"; PASS=$((PASS+1))
  fi
}

echo "Test 1: bash -n syntax check"
if bash -n "$SCRIPT"; then echo "  ✅ syntax OK"; PASS=$((PASS+1)); else echo "  ❌ syntax FAIL"; FAIL=$((FAIL+1)); fi

echo "Test 2: bundle 路径必须 git merge --ff-only bundle-tmp（修 line 39 bug）"
assert_grep "merge --ff-only bundle-tmp" "git merge --ff-only bundle-tmp"

echo "Test 3: bundle 路径不再无脑跑 git pull（修 line 46 bug，互斥分支）"
# 修 patch：PULL_BLOCK 仅在 DEPLOY_PATH = direct 时填充
assert_grep "PULL_BLOCK 仅 direct 路径填" 'PULL_BLOCK=""'
assert_grep "DEPLOY_PATH = direct 才注入 git pull" '\[ "\$DEPLOY_PATH" = "direct" \]'

echo "Test 4: ssh 子 shell heredoc 含 set -euo pipefail（错误严格传播）"
# 出现至少 2 次（bundle path heredoc + step 3 heredoc）
COUNT=$(grep -c "set -euo pipefail" "$SCRIPT" || true)
if [ "$COUNT" -ge 2 ]; then echo "  ✅ set -euo pipefail x $COUNT"; PASS=$((PASS+1)); else echo "  ❌ 应至少 2 次（外 + ssh 子 shell），实际 $COUNT"; FAIL=$((FAIL+1)); fi

echo "Test 5: 末尾 server HEAD == local HEAD 断言（杜绝 false-green）"
assert_grep "deploy verification 断言" 'SERVER_FINAL.*!=.*LOCAL_FINAL'
assert_grep "失败 exit 1" 'deploy verification FAILED'

echo "Test 6: bundle 路径用 heredoc bash <<EOF（不是行内 && 链）"
assert_grep "bundle ssh heredoc" "ssh .*\\\$SERVER.*bash <<EOF"

echo
echo "Total: $PASS pass / $FAIL fail"
[ $FAIL -eq 0 ] || exit 1
