#!/bin/bash
# 推送 BossMate 到 GitHub hanxiao199001 账号
# 使用方法: bash push-to-github.sh

set -e

echo ">>> 准备推送到 GitHub hanxiao199001/BossMate ..."

# 从现有remote提取token
TOKEN=$(git remote get-url origin | sed 's|https://[^:]*:\([^@]*\)@.*|\1|')

if [ -z "$TOKEN" ]; then
  echo "错误: 无法提取 GitHub token，请手动设置"
  exit 1
fi

echo ">>> 创建 GitHub 仓库 BossMate ..."
curl -s -X POST https://api.github.com/user/repos \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"BossMate","description":"BossMate AI超级员工 - 期刊代发行业AI操作系统","private":false,"auto_init":false}' \
  | grep -o '"html_url":"[^"]*"' | head -1

echo ""
echo ">>> 添加新的 remote (bossmate) ..."
git remote remove bossmate 2>/dev/null || true
git remote add bossmate "https://hanxiao199001:${TOKEN}@github.com/hanxiao199001/BossMate.git"

echo ">>> 推送代码到 hanxiao199001/BossMate ..."
git push -u bossmate main --force

echo ""
echo "✅ 推送成功！"
echo "📎 仓库地址: https://github.com/hanxiao199001/BossMate"
