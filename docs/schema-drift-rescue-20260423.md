# 2026-04-23 Drift 回溯捕获事件文档

## 背景

2026-04-23，在 T3 开工前的 drift 检查阶段，发现生产服务器
`/home/projects/bossmate/` 上存在大量未入 git 的 `scp` 直写代码改动，
以及 DB schema 显著超前于源码声明。本文件记录事件全貌、决策过程、
处理边界和遗留待办。

---

## 事件时间线

```
04-08  [服务器] root 提交 1bb95da（内容引擎 +5043 行）— 没 push
04-09  [服务器] root 提交 0eac9ac（CNKI+AI 内容校验器+期刊模板 +3259 行）— 没 push
   ├── 此时 origin/main = 1e5f209
   ├── 某次 tar.gz 备份把这两个 commit 带到本地 Mac
04-21  [本地 Mac] laoxiao2 提交 3845668（视频链 MVP +2989 行）并 push origin
   └── 此时 laoxiao2 本地 main 还是 1e5f209（未同步服务器端 root 提交）
        push 后 origin/main 与本地 main 开始分叉
04-22~23  [服务器] 继续 scp 直改，drift 堆积成 76 个文件
04-23  [T3 drift 检查] 发现三向分叉 + 76 文件 drift + schema 严重分裂
```

---

## Schema 分裂发现（非本次 rescue 范围）

审计中发现生产 DB 共 55 张表，其中 **23 张未在 schema.ts 声明**。

### 23 张 DB-only 表清单（按功能归类）

**专栏/内容运营**（7 张）
```
column_definitions
column_series_progress
content_calendar
content_format_templates
content_publications
format_dimensions
prompt_templates
```

**数据采集**（5 张）
```
crawl_batches
raw_crawl_data
media_collections
media_content_analysis
media_detective_analysis
media_transcripts
```

**洞察/趋势**（3 张）
```
event_timeline
trend_timeline
insight_metadata
```

**打磨/派生**（3 张）
```
content_refinement_logs
refinement_logs
derivative_content
```

**其他**（5 张）
```
audience_profiles
reference_frameworks
performance_metrics
content_reviews
```

### 列级 drift（非本次 rescue 范围）

`platform_accounts` 表额外含 17 个 schema.ts 未声明的列：
```
account_type, authority_score, auto_refresh, bind_method, capabilities,
citation_frequency, collaboration_tags, competitor_ranking, content_categories,
content_frequency, engagement_rate, expertise_areas, follower_count,
partnership_fit, profile_url, refresh_interval, style_tags
```

`tenants` 表额外含 1 列：
```
is_active
```

### 审计结论

| 审计项 | 命中数 |
|---|---|
| TS / TSX 代码 `sql\`` 模板含 23 张表名 | 0 |
| Python 脚本（deploy-*.py）DB 操作 | 0（scripts 是 base64 编码的 TS 部署工具，本身不接 DB）|
| 全服务器文件（ts/tsx/py/sh/sql/mjs/js）含任一表名 | 0 |

**处理决策**：本次 rescue 不纳入这 23 张表和 18 列，原因：
1. 不在本次 T1-T7 图文质量主线的关键路径上
2. 无任何源码活引用（意味着是遗留/实验，drop 安全性高）
3. 需要专门的 `drizzle-kit introspect` + 语义审查工作，非 rescue commit 能覆盖
4. schema 分裂是独立问题，不应阻塞主线

**后续动作**：新开 `fix/schema-realignment` 专项，T7 主线完成后执行。
该专项的工作范围：对 23 张表逐张判断 keep / drop / migrate，
保留的反向声明进 schema.ts。

---

## 本次 rescue 范围（明确边界）

### 代码 drift（71 个非 schema 文件）

**Routes** (3)
```
packages/server/src/routes/api-docs.ts       — OpenAPI 文档路由（新）
packages/server/src/routes/sales.ts          — V3 销售 leads / messages 路由（新）
packages/server/src/routes/video.ts          — 视频生成触发路由（新）
```

**V3 Agent 系统** (4)
```
services/agents/base/base-agent.ts           — Agent 基类（新）
services/agents/ceo-agent.ts                 — CEO Agent（新）
services/agents/publish-manager.ts           — 发布管理 Agent（新）
services/agents/quality-checker.ts           — 质检 Agent（新）
services/event-bus/{index,types}.ts          — 事件总线（新）
```

**销售模块** (2)
```
services/sales/conversation-agent.ts         — AI 客服对话引擎（新）
services/sales/lead-collector.ts             — 线索收集器（新）
```

**视频生产链**（9 个全新/扩展）
```
services/video/index.ts                      — 主入口（相对 3845668 +）
services/video/composer.ts                   — FFmpeg 合成（演进 +349 行）
services/video/asset-manager.ts              — 素材管理
services/video/card-generator.ts             — SVG 卡片（新）
services/video/html-renderer.ts              — Puppeteer 渲染
services/video/tts-service.ts                — TTS（阿里云 NLS 动态 Token 已支持）
services/task/video-worker.ts                — BullMQ Worker
services/skills/video-skill.ts               — 视频技能
```

**发布适配器** (5)
```
services/publisher/adapters/douyin.ts         — 抖音（新）
services/publisher/adapters/wechat-video.ts   — 视频号（草稿模式）
services/publisher/adapters/wechat-article-template.ts — 公众号模板（新）
services/publisher/credentials-loader.ts      — 凭证加载（新）
services/publisher/lead-capture.ts            — 获客组件（新）
```

**基础设施** (4)
```
services/storage/index.ts                    — 本地/OSS 存储抽象（新）
services/rate-limiter/index.ts               — API 限速器（新）
services/crawler/cover-fetcher.ts            — 期刊封面抓取（新）
utils/crypto.ts                              — 凭证加解密（新）
utils/{retry,timeout}.ts                     — AI 调用重试+超时（新，从 chat-service 独立的 drift）
```

**前端** (7)
```
apps/web/src/components/{ErrorBoundary,Toast}.tsx  — UI 组件（新）
apps/web/src/pages/{SalesPage,VideoCreationPage}.tsx — 页面（新）
apps/web/src/stores/toastStore.ts             — Zustand store（新）
apps/web/src/utils/sanitize.ts                — XSS 防御（新）
apps/web/src/vite-env.d.ts                    — Vite 类型（新）
```

**测试** (3)
```
__tests__/{auth,crypto,keyword-trend}.test.ts — 已有但未入库
```

**修改文件**（45 个含 index.ts / Dockerfile / 各 routes / agents / publisher / schema.ts 等）

### Schema drift（3 处新增）

**新列**
```sql
ALTER TABLE journals ADD COLUMN cover_url_hd TEXT;
-- Springer CDN 316×419 高清封面，视频链路 image-binder 依赖
```

```sql
ALTER TABLE platform_accounts ADD COLUMN capability VARCHAR(20) NOT NULL DEFAULT 'draft_only';
-- 发布能力：full=全流程自动；draft_only=仅建草稿人工发送
-- 未认证订阅号走 draft_only（errcode 48001）
```

**新表**
```sql
CREATE TABLE leads (...)            -- 潜在客户，V3 销售模块主表
CREATE TABLE sales_messages (...)   -- 对话消息，FK → leads.id
```

对应 `migrate.ts` 的 CREATE TABLE IF NOT EXISTS DDL 同步更新。

### 不纳入本次 rescue

| 项目 | 处置 |
|---|---|
| 23 张 DB-only 表 | `fix/schema-realignment` 专项，T7 后 |
| `platform_accounts` 17 legacy 列 | 同上 |
| `tenants.is_active` | 同上 |
| `stash@{0}` 里其他未涉及的 drift | 后续清理 |
| origin/main broken 问题 | 本 PR 合并即自动修复（tsc 29 errors → 0） |

---

## Merge 决策

**选择**：保留双方所有 commit 原始 hash，用 `git merge origin/main` 生成菱形拓扑
（非 rebase / 非 cherry-pick）。

**理由**：
1. 诚实反映历史：root@server 04-08/09 的内容引擎工作 和 laoxiao2 04-21 的视频 MVP
   本来就是两条平行独立线，merge 的菱形正确表达
2. 不改写任何 hash：tar.gz 备份链 + 服务器 git 历史 + origin 远端三方对齐
3. 无 force push，完全 fast-forward
4. Archaeology 友好

**orchestrator.ts 冲突**：服务器最新演进版胜出（1bb95da 的 +218 行和
3845668 的 +427 行都已在服务器实际运行中被整合演进）。

---

## 审计证据（已执行）

- ✅ **Step 1** 完整 schema 枚举：pg_dump + 列级 diff，23 orphan tables + 18 legacy columns 全部列出
- ✅ **Step 2（调整）** schema.ts 与 DB 一致性：32 张共有表里 schema.ts 未声明的列全部列出（18 个，均非本次 rescue）
- ✅ **Step 3（调整）** migration ledger：项目无 drizzle-kit，migrate.ts 是 `CREATE TABLE IF NOT EXISTS` 幂等脚本。无 ledger 可对。改为审查 migrate.ts 的 DDL 增加部分，仅含 leads / sales_messages / cover_url_hd / capability
- ✅ **Step 4** 76 个 drift 文件审查：
  - 硬编码凭证：0 命中（test 文件里的测试密码 `SecurePassword123!` 是合法测试数据）
  - WIP 标记（TODO TESTING / DEBUG / FIXME）：0 命中
  - 个人数据：仅 RegisterPage.tsx 一个 `placeholder="13800138000"` 占位号
  - console.log：仅 services/skills/index.ts 一个合法初始化日志
- ✅ **Step 5** rebase 到最新 main：发现三向分叉，改用 merge 策略
- ⏳ **Step 6** monorepo 全量 build：rescue commit 完成后执行

---

## 独立待办：CI 搭建

本次事件暴露 origin/main 无 CI 保护。`3845668` push 破窗 2 天无人察觉
（29 tsc errors），说明新代码无自动 tsc / build / test 验证。

**建议 T7 主线完成后新增专项**：
- GitHub Actions：push / PR 触发 `pnpm tsc --noEmit` + `pnpm -r build` + `pnpm test`
- main 分支保护：强制 PR + 至少 1 review + CI 通过才能 merge
- 禁用 direct push to main

**不做的代价**：下次类似 drift 事件可能持续更久才被发现。

---

## 相关链接

- 执行手册：`docs/content-quality-playbook.md`
- drift 检查硬规则：playbook 「硬规则」章节
- 未来 schema realignment 分支：`fix/schema-realignment`（未创建）
