# CODING 迁移脚本模板 · 2026-04-24

## 用法

laohan 发来 CODING 仓库 URL 后，把下面两个占位符替换成实际值：

- `{{CODING_HTTPS_URL}}` — CODING 仓库的 HTTPS git URL（形如 `https://e.coding.net/<team>/<project>/bossmate.git`）
- `{{CODING_PROJECT_URL}}` — CODING 项目网页 URL（用于 README archive 链接等，非 git 操作必需）

替换后按 Step 1 → 6 顺序执行。

---

## Step 1 — 本地加 coding remote

```bash
cd /tmp/bossmate/bossmate

git remote add coding {{CODING_HTTPS_URL}}
git fetch coding
```

**预期**：`git fetch coding` 成功（空仓库返回 `warning: You appear to have cloned an empty repository.` 是正常的）

**失败处理**：如果返回 `Authentication failed`、`Permission denied`、或 `HTTP 401/403`——**停下来告诉 laohan**，不要存任何 token 或 SSH key。laohan 需要在 CODING 生成 personal access token 或者把公钥加到 CODING 账户，操作路径：

- HTTPS 方式：CODING 个人账户 → 个人设置 → 访问令牌 → 新建令牌（勾选 project:depot 读写权限），然后在推送时提示输密码的地方用 token 代替
- SSH 方式：CODING 个人账户 → 个人设置 → SSH 公钥 → 添加公钥（粘贴 `~/.ssh/id_ed25519.pub`）

## Step 2 — 全量推送（所有分支 + 所有 tag）

```bash
git push coding --all
git push coding --tags
```

**预期**：每个 branch 和 tag 都能推成功。如果某个 branch push 被 reject，查 CODING 仓库是否配置了分支保护规则（比如禁止直接 push main）——**如果被 reject，停下来告诉 laohan**，需要先在 CODING 上临时关掉保护再推。

## Step 3 — 验证 CODING 上的分支 / tag 数量完全等于 GitHub

```bash
echo "=== CODING ref 数 ==="
git ls-remote coding | wc -l

echo "=== GitHub (origin) ref 数 ==="
git ls-remote origin | wc -l
```

**预期**：两个数字**完全相等**。不等说明 push 漏了，查 `git ls-remote` 各自输出对比缺失的 ref。

## Step 4 — 切 origin 到 CODING（GitHub 降级为 github-archive）

```bash
git remote rename origin github-archive
git remote rename coding origin
git remote -v
```

**预期**：`git remote -v` 输出应该是：
```
github-archive  https://github.com/hanxiao199001/bossmeate123.git (fetch)
github-archive  https://github.com/hanxiao199001/bossmeate123.git (push)
origin          {{CODING_HTTPS_URL}}                                 (fetch)
origin          {{CODING_HTTPS_URL}}                                 (push)
```

保留 `upstream` remote（指向 344630994v-lgtm/Bossmate3.25）不动——与本次迁移无关。

## Step 5 — 服务器 git remote 同步切

```bash
ssh ubuntu@122.152.234.155 "cd /home/projects/bossmate && \
  git remote rename origin github-archive && \
  git remote add origin {{CODING_HTTPS_URL}} && \
  git remote -v && \
  git fetch origin && \
  git pull origin main"
```

**预期**：
- `git remote -v` 显示 `origin` 指向 CODING，`github-archive` 指向 GitHub
- `git fetch origin` 成功拉取
- `git pull origin main` fast-forward（如果服务器有未提交改动会 reject，见下方失败处理）

**失败处理**：
- 如果 `git pull` 报 `Your local changes would be overwritten`——**停下来汇报**，服务器上有未入库 drift 需要先决策 A/B/C（参考 playbook 硬规则）
- 如果 CODING 凭证没配，会报 `Authentication failed`——**停下来告诉 laohan** 服务器上需要配 CODING 凭证。可选方案：在 CODING 上给服务器专用的 access token，存到 `~/.git-credentials` 或用 git credential helper

## Step 6 — 验证服务器端 main HEAD 与 CODING 一致

```bash
echo "=== 服务器 main HEAD ==="
ssh ubuntu@122.152.234.155 "cd /home/projects/bossmate && git log --oneline -3"

echo "=== 本地 main HEAD ==="
git log --oneline -3
```

**预期**：两边输出**完全一致**，HEAD 都是 `b86cf1e Merge PR #2`。

---

## 迁移后下一步（仅列出，不执行）

1. GitHub 上 `hanxiao199001/bossmeate123` 仓库改名 `bossmeate123-archive-20260425`
   - 路径：Settings → General → Repository name → 改名 → Rename
2. GitHub 仓库 README 顶部加红字归档提示
3. 在 CODING 上开 T3 分支（`feat/content-quality-t3-remove-dead-code`），第一次 commit 发生在 CODING

---

## 凭证安全守则

- **不要**在任何脚本、commit、doc 里写明文 token
- **不要**把 CODING access token 提交到 git
- **不要**自作主张在服务器上存凭证——由 laohan 决定配置位置和方式
- 推送失败优先走 SSH 公钥而非 HTTPS token（公钥不会误提交）

如果推送卡在凭证步骤，**停下来让 laohan 处理**。
