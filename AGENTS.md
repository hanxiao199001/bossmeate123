# BossMate — Codex 工程纪律

> 项目约束 + 红线总览。Codex 进项目自动加载本文件。

---

## 红线 #11 — 复用 > 重写（每个新 PR 启动前必做）

**强制规则**: 启动任何新功能 / 修复 / 重构 PR 前，**第 1 个动作**不是写 plan，而是 grep 现有代码确认无可复用实现。

**grep 4 类清单**:
- 组件名 / 类名 (如 `RewriteSectionModal`, `EditTimelineDrawer`)
- 路由路径 (如 `/content/:id/edits`, `/api/.../section`)
- 中文功能词 (如 "改段", "编辑历史", "AI 改写")
- 关键算法 (如 `LCS`, `diff`, `sanitize`)

**判定**:
- 4 项全 miss → 动手写
- 任 1 命中 → 暂停 + 报告 user "现有代码 X 在 Y, 是否复用?"

**实例**: 5-10 P7 自定义编辑器 spec 估 3 天 + 800 行新代码。grep 4 项全命中（PR #20/#21 T4-2-2/T4-2-3 已实现），直接关闭 task，节省 3 天。

---

## 红线 #1-#10（参考 .Codex/projects/-Users-a01/memory/bossmate_workflow_rules.md）

| # | 规则 | 要点 |
|---|---|---|
| 1 | base=main | PR 严格 base=main，禁分支套娃（PR #96/#98 教训） |
| 2 | drift 4 规则 | 桌面写代码 / 服务器跑 / 不可逆操作前 verify / PR 自助 merge |
| 3 | AI 模型硬约束 | 锁 DeepSeek + Qwen-Plus，禁 Codex/GPT；T2 路由 + T3 死代码已清 |
| 4 | 云厂商硬约束（已迁阿里云） | 服务器阿里云 ECS **119.91.52.13**（key `~/.ssh/bossmate_deploy`，ssh config alias `bossmate-boss`）；存储阿里云 **OSS**（私有桶 + 签名 URL）；LLM 阿里云**百炼**（DeepSeek + Qwen-Plus）；数字人阿里云 **DVH**；语音阿里云 **NLS**；短信阿里云。**腾讯云 COS/CMS/ECS 已全部弃用，122.152.234.155 是旧机（勿再引用）。迁移细节以 `迁移手册-新服务器.md` 为准。** |
| 5 | merge 后立刻 deploy + verify | pnpm deploy:smart + 至少 3 项 verify (mtime / 字面 / health) |
| 6 | 不扩 scope | spec 外不动；新需求开新 PR |
| 7 | 依赖锁文件同 commit | 改 `package.json` 依赖必须**同一 commit** 更新 `pnpm-lock.yaml`（服务器 frozen-lockfile，漏更新 = 部署直接失败） |
| 11 | 复用 > 重写 | 见上方 |

---

## chart 数据存储真相（防"chart_configs 表"谣言重现）

**误区**: 以为有 `chart_configs` 表存 chart 配置。**真相**: 该表项目从未存在。

**实际存储**: `journals` 表 5 个 jsonb 字段：

| 字段 | 内容 | 渲染位 |
|---|---|---|
| `if_history` | `{ data: [{year, if}, ...], predicted, lastUpdatedAt }` | shunshi-style template + JournalDetailPage |
| `car_index_history` | `{ data: [{year, carIndex}], riskLevel, lastUpdatedAt }` | 同上 |
| `publication_stats` | `{ frequency, annualVolumeHistory: [{year, count}], topInstitutions, lastUpdatedAt }` | 同上 |
| `citing_journals_top10` | `{ topJournals: [{name, percent, count}], totalCitations, lastUpdatedAt }` | 同上 |
| `jcr_full` | `{ wosLevel, jifSubjects, jciSubjects, isTopJournal, lastUpdatedAt }` | 同上 |

**SVG 生成**: `packages/server/src/services/crawler/journal-chart-generator.ts` 含 5 个 generator（generateBarChart / generateIFTrendChart / generatePubVolumeChart / generateCASPartitionTable / generateJCRPartitionTable），实时读 jsonb → SVG → `<img src="data:image/svg+xml;...">` 嵌模板。

**前端 React 渲染**: 截至 PR #125，`JournalDetailPage` 用数据表格（无 SVG）显示这 4 个 jsonb 字段；shunshi-style template 后端预渲染 SVG。

**填充率**: 国际期刊 35 行 multi_source 中 32/35 = 91% 有 if_history。中文期刊 LetPub/OpenAlex 覆盖率有限，CNKI/万方接入在 backlog（task #104）。

---

## 部署 + verify 标准流程（红线 #5）

```
本地 main 同步 → pnpm deploy:smart → 3 项 verify:
  a. ssh ls -la /home/projects/bossmate/apps/web/dist/assets/*.js → mtime 最新
  b. ssh grep "新功能字面" dist/assets/*.js → 命中
  c. ssh curl http://localhost:3000/api/v1/health → 200
```

deploy:smart 路径：直连 fetch 3 次 retry → bundle 绕路兜底（修 PR #49 false-green bug）。部署目标 = 阿里云新机 `ubuntu@119.91.52.13`。

**唯一部署入口 = `pnpm deploy:smart`。其余部署脚本一律不得手跑（含 AI）。** 遗留 `deploy.sh`/`deploy-v4*.sh`/`deploy-*.py` 硬编码指向弃用机，手跑=部署到死机；已删三个 .sh 孤儿；7-06 排雷三个 .py 死脚本（从未入 git，移入 .review-stash 封存）。日后从 git 翻出旧脚本只可读不可跑。

**依赖锁文件铁律（红线 #7）**：改 `package.json` 依赖必须**同一 commit** 更新 `pnpm-lock.yaml`。服务器走 frozen-lockfile，manifest 与锁文件 specifier 不一致 → 安装报错 → 部署整条失败。教训：07d2a74 加 `ali-oss` 漏更新锁文件，潜伏到 185222d 部署才炸（"specifiers don't match"），补锁 commit 3dd3f2e 才通。自查：`pnpm install --lockfile-only` 后 `git status` 若锁文件有改动即漏了。

---

## JWT 自签验证模式（curl 测受保护 endpoint）

```bash
ssh ubuntu@119.91.52.13 'cd /home/projects/bossmate && TOKEN=$(node -e "
const fs = require(\"fs\");
const env = fs.readFileSync(\"/home/projects/bossmate/.env\", \"utf8\");
const secret = env.match(/^JWT_SECRET=(.+)$/m)[1].trim();
const crypto = require(\"crypto\");
const h = Buffer.from(JSON.stringify({alg:\"HS256\",typ:\"JWT\"})).toString(\"base64url\");
const p = Buffer.from(JSON.stringify({userId:\"<uid>\",tenantId:\"<tid>\",role:\"owner\",exp:Math.floor(Date.now()/1000)+300})).toString(\"base64url\");
const s = crypto.createHmac(\"sha256\", secret).update(h+\".\"+p).digest(\"base64url\");
console.log(h+\".\"+p+\".\"+s);
") && curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/<endpoint>'
```

---

## 数据库不可逆操作护栏（DELETE / DROP / ALTER）

启动任何 DELETE / DROP / 大 ALTER 前必做 3 项:
1. **dry-run SELECT** 确认 row count 符合预期
2. **检查引用** (`SELECT COUNT(*) FROM child_table WHERE fk = ...`) 确认无破坏
3. **报告 user 拍板**，禁未授权直接执行

实例: PR #125 Step 1 删 20 ai_fabricated journals 前先 verify count = 20 + 0 contents 引用 → user 拍板 → DELETE。

## Imported Claude Cowork project instructions
