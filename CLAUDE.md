# BossMate — Claude 工程纪律

> 项目约束 + 红线总览。Claude Code 进项目自动加载本文件。

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

## 红线 #12 — 测试基线护栏（新增失败=阻塞项）

**背景**: 2026-07-08 对全量 `packages/server` 测试基线（203 文件 / 1463 测试）做过一次系统 triage。当时 52 红，六簇独立核查 + 加权红线（扣费/落库/幂等/权限/越权/跨租户/签名鉴权/数字承诺）逐条亲验 —— **真回归=0**，52 红全部是"过时漂移"（读活文件、功能仍在，只是断言钉住了旧文案/旧门控/旧路径）。分簇明细见附录 `docs/test-baseline-triage-20260708.md`。

**强制规则**:
1. **52 过时红是"已知漂移"**，逐簇慢清、**不阻断**开发；清理只可两种动作 —— ①**更新断言到现状**（功能仍在，跟进改名/搬家/换实现/门控演进）②**删读已删文件的死断言**（readSrc→ENOENT）。
2. **禁为过测试改生产代码**。测试红几乎都是断言过时，先核"功能是否仍在"，是→改测试；只有确认功能真丢/行为改坏才动生产（那属真回归，走修复 PR）。
3. **新增失败一律视为真回归嫌疑 = 阻塞项**，**不得带新失败合并**。你的 PR 让某个原本绿的测试变红 → 默认你的改动引入了回归，必须查清（是你改坏了功能，还是你合理改了行为但漏更新断言）再合。
4. 判"漂移 vs 真回归"沿用三分法 + 加权红线：**死**（读已删文件）/**过时**（读活文件、功能可核实仍在）/**真回归嫌疑**（读活文件、断言的是行为/钱/数据链路/权限，却核不出功能还在）。拿不准算嫌疑，宁可多报。

> 注：本护栏针对**测试基线**。发布期 hasWarnings 数据编造二次校验缺口（半兜底，仅前端 ⚠️+人判）属另一独立待决项，见 triage 附录，等老韩拍板，不在本护栏范围。

---

## 红线 #1-#10（参考 .claude/projects/-Users-a01/memory/bossmate_workflow_rules.md）

| # | 规则 | 要点 |
|---|---|---|
| 1 | base=main | PR 严格 base=main，禁分支套娃（PR #96/#98 教训） |
| 2 | drift 4 规则 | 桌面写代码 / 服务器跑 / 不可逆操作前 verify / PR 自助 merge |
| 3 | AI 模型硬约束 | 锁 DeepSeek + Qwen-Plus，禁 Claude/GPT；T2 路由 + T3 死代码已清 |
| 4 | 云厂商硬约束（已迁阿里云） | 服务器阿里云 ECS **119.91.52.13**（key `~/.ssh/bossmate_deploy`，ssh config alias `bossmate-boss`）；存储阿里云 **OSS**（私有桶 + 签名 URL，见 chart/音频段）；LLM 阿里云**百炼**（DeepSeek + Qwen-Plus，红线 #3）；数字人阿里云 **DVH**；语音阿里云 **NLS**；短信阿里云。**腾讯云 COS/CMS/ECS 已全部弃用，122.152.234.155 是旧机（勿再引用）。迁移细节以 `迁移手册-新服务器.md` 为准。** |
| 5 | merge 后立刻 deploy + verify | pnpm deploy:smart + 至少 3 项 verify (mtime / 字面 / health) |
| 6 | 不扩 scope | spec 外不动；新需求开新 PR |
| 7 | 依赖锁文件同 commit | 改 `package.json` 依赖必须**同一 commit** 更新 `pnpm-lock.yaml`（服务器 frozen-lockfile，漏更新 = 部署直接失败）。见下方教训 |
| 11 | 复用 > 重写 | 见上方 |
| 12 | 测试基线护栏 | 全量基线已 triage：真回归=0，52 过时红为已知漂移；新增失败=真回归嫌疑=阻塞项；漂移只可"更新断言/删死断言"，禁为过测试改生产。见下方 |

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

**数据覆盖 backlog（挂 task #104 旁）**:
- 🔴 **CNKI/万方接入（task #104）— 已从"覆盖率 backlog"提升为"国内内容线阻塞项"（2026-07-09）**。根因数据：**国内 verified 期刊池仅 427/3,707 = 12%**（多数国内学科 verified 近零：medicine 17/438、综合性人文社科 0/122、中国政治 0/43）。后果：daily-cron 国内槽位 verified 两层频繁枯竭 → 回退 legacy_unknown 生成内容；客服查国内刊大量落"未核实/转顾问"。**CNKI/万方接入是治本**（把国内刊多源核验、conf 提到 70+、升级 multi_source_verified）；**PR B 的 needs_review 标记（回退未核实源→人工复核）+ PR A 客服护栏是止血**，不解决覆盖率本身。国内内容质量要真起来，必须补中文权威源。
  - ✅ **task#104 阶段2 万方医学网回填（一次性完成，2026-07-17）**。万方搜索页可自动解析 perioId + 中信所核心影响因子（复合IF），实测桌面真实网络可抓。**结论数字**：医学国内刊候选池 ~581 本，处理 580（1 本 fetch 失败=`黑龙江畜牧兽医`，兽医非医学，真无果）；**perioId 命中写入 460 本、复合IF（provenance=wanfang）447 本、无果标记 120 本，全部 name_exact（0 fuzzy，无张冠李戴）**。**只加法**：只写 `metadata.wanfang.perioId` + `composite_impact_factor`（仅原 NULL）+ `fieldProvenance.compositeImpactFactor=wanfang` + 无果 `metadata.wanfang.searchedNoMatch`；`impact_factor`/`confidence`/`data_source` 零改动（终审误碰=0、无cif却打provenance=0）。无果全是**电子版/网络版/大学学报医学版/期刊改名（华南国防医学→联勤军事医学）/DB 刊名 typo（影响→影像、前言→前沿）/非医学正则误召（兽医·农药·地质）**——规律性 miss，非新问题。**执行约束**：阿里云服务器数据中心 IP 被万方封（ECONNREFUSED），**必须桌面真实网络跑**；且 SSH 隧道会抖动 + sshd 会限连——**解耦设计绕开**：桌面抓万方→本地 `results.jsonl` 逐本落盘（零 DB/SSH 依赖，崩了可 resume）→ 最后 server 端 psql 一次性 jsonb 合并落库（免隧道）。**非常态化**（不挂 cron）。**非医学国内刊 ~2556 搁置（D 方案），国内到 CSCD/北大核心为止；CNKI 阶段3 暂不接。**
  - 🟡 **backlog-A：orchestrator 链急切实例化 Redis worker/Queue（阶段2 副产）** — `services/batch/queue.ts:8` + `services/task/queue.ts:32/43/53` 的 `export const xQueue = new Queue(...)` 是**模块级急切实例化**（import 即连 Redis）。任何 import orchestrator 的独立脚本会被此拖住卡死（阶段2 committed `enrich-wanfang-batch.ts` 跑 orchestrator 即卡在"Redis 连接成功"后不处理任何刊）。**这是 memory `no-eager-module-instantiation` 反模式的活实例** → 应改懒实例化（`getQueue()` 工厂/懒代理）。回填因此改用**不 import orchestrator 的聚焦独立脚本**（纯 pg + fetch）。
  - 🟡 **backlog-B：万方 detail URL 格式过时** — `services/journal-enricher/fetchers/wanfang-fetcher.ts:109` 仍拼 `/Periodical/Detail/${perioId}`，**现网真实格式是 `/Periodical/${perioId}`（短码，无 /Detail/）**。resolver（`wanfang-perioid-resolver.ts`）已于 7-16 校准改对，但 orchestrator 用的 detail fetcher **未改** → orchestrator 万方 detail 抓取路径已失效。**修对或标注勿用**。committed `enrich-wanfang-batch.ts`（跑 orchestrator+急切 worker 会卡死）本次未用、已被聚焦脚本取代——别当能跑的脚本留仓库。
  - 🟡 **backlog-C：enrichment 供数 vs DB 校验 数据源不一致（2026-07-21 发现，碰数据链路核心，需专门一轮）** — 生成时 `article-skill.ts` 调 `ensureJournalEnriched`（`crawler/springer-journal-fetcher.ts:232`）**实时从 LetPub/springer 抓 IF/分区喂给 LLM，但抓到的值不回写 `journals` 表**（DB 仍为空）。后果：事后所有以 DB 为准的校验都把"enrichment 补了真数据、LLM 据实写"的内容误判为编造 —— ①7-20 部署的评分器反编造压分（`quality-check-v2` 调 `findBodyFabrication`）②标题编造校验（`checkTitleDataConsistency`）③正文编造检测。**受影响面 = 骑墙刊**：带 `sci-core` 标签、`journals` 表 IF/分区全空、但 LetPub 有真实数据的刊（实例：地理科学进展，DB 全 null，enrichment 抓到 IF 4.3/中科院1-2区，标题正文据实写"1区/IF4.3"却被三道校验当编造）。**当时的"改动3 骑墙刊编2区"结论是误判**——不是编造，是有据但未回写。**根治方向（二选一）**：① enrichment 抓到的 IF/分区**回写 `journals` 表**（让 DB 成为唯一真相源，校验就对了；注意 provenance 记 letpub，遵守 OpenAlex 源约束）② 或让三道校验也走 enrichment 后的 `journal` 对象而非 DB 快照。**收尾期未做**：7-21 曾试"收紧国内刊判定排除 sci-core + 全局无据禁写红线"（commit `6577b9a`），对纯国内刊无害但对骑墙刊反而更糟（把有数据的刊当无数据），已 `git revert`（`11cb31d`）退回改动3 主体 `c930b00`。**纯国内刊（不含 sci-core，2379 本里绝大多数）的改动3 完全有效，此 backlog 只影响少数骑墙刊。**
- **LetPub 反爬代理（2026-07-08，7-09 修正）** — 代理**不是全删**：**列表爬 Python 侧**（`journal_scraper.py --proxy` / `scrapling-bridge proxy`）的 proxy 支持已移除；**enrich TS 侧** `letpub-detail-scraper.ts` 的 `LETPUB_PROXY`（undici ProxyAgent，PR #189）**仍在、仍可用**。PR #260 实际只是接上了全局熔断（`ENRICH_SKIP_LETPUB`）+ "列表爬与 enrich 进程隔离"约定，**没删 enrich 侧代理**。**影响**：遇 LetPub 封 IP 时可 `ENRICH_SKIP_LETPUB=true` 熔断（停爬、无新数据、损新鲜度/覆盖率，但不产假数据），或挂 `LETPUB_PROXY` 换 IP 续爬。若数据陈旧成问题再评估扩代理池/换源。

**OpenAlex 源可信度约束（老韩 2026-07-09 判定）**：OpenAlex 与 LetPub 数据出入大，**禁用于 IF / 分区 / 预警 / 录用率等信任字段的核验或写入**；只可用于**官网(website) / ISSN / 出版社(publisher) / 发文量(publicationStats)等非争议元数据**。现状核实（7-09 审计）符合此约束：orchestrator 里 `impactFactor`/`ifHistory`/`jcrFull`/预警 全部 provenance=`letpub`/中科院，OpenAlex 只写 website/publisher/publicationCosts/publicationStats；openalex_ingest 24 行 has_if=0、has_partition=0、is_warning=0（仅 website 19 行）。**日后接 OpenAlex 数据时不得把它的近似 IF/分区写进信任字段。**

---

## 效果看板已知限制 — 手填指标不带 accountId（老韩 2026-07-19 拍板：接受，不修）

**背景**：效果看板"每号表现"对**手填**指标无法做账号级归因。根因在数据采集端：`TodayPage.tsx:197` 运营手填 ROI 指标时 `accountId: ""` 写死（录入表单只让选**平台**，不选账号），`today.ts:246` 落库入 `content_metrics.metadata.accountId=""`。

**现状（codex review 后已修到"诚实聚合"）**：`effect-dashboard.ts` 把空串 accountId 归一为 null → 按 `platform:{平台}` 兜底分桶（`fix 649d89e`）。**效果**：① 跨平台不再串（原空串 key 会把 wechat/douyin 手填挤成一行，已修）② 同平台多个账号的手填数仍合并成一个"平台级"聚合行（accountId=null，名字=平台）——**这是数据本身没带账号，看板不能凭空造，属诚实展示不是 bug**。

**判定**：API 自动回流的账号有真实 per-account 行；手填走平台级聚合。**不加账号选择器**（多数运营单平台单号手填，per-account 手填不值那几次多点击）。若日后运营普遍一平台多号且要手填账号级数据，再在 `TodayPage` 录入表单加账号 `<select>`（后端 `today.ts` 已收 accountId，改动仅前端一处）。codex 复审 6/7 RESOLVED + no new issues，此条 P1 是数据采集限制、非看板 bug，本条即结论。

---

## 部署 + verify 标准流程（红线 #5）

```
本地 main 同步 → pnpm deploy:smart → 3 项 verify:
  a. ssh ls -la /home/projects/bossmate/apps/web/dist/assets/*.js → mtime 最新
  b. ssh grep "新功能字面" dist/assets/*.js → 命中
  c. ssh curl http://localhost:3000/api/v1/health → 200
```

deploy:smart 路径：直连 fetch 3 次 retry → bundle 绕路兜底（修 PR #49 false-green bug）。部署目标 = 阿里云新机 `ubuntu@119.91.52.13`（可 `export BOSSMATE_DEPLOY_SERVER` 覆盖）。

**唯一部署入口 = `pnpm deploy:smart`。其余任何部署脚本一律不得手跑（包括 AI）。** 历史遗留的 `deploy.sh` / `deploy-v4*.sh` / `deploy-*.py` 等脚本硬编码指向已弃用服务器（106.53.163.120 等），手跑 = 部署到死机。已于 2026-07-03 清理三个 .sh 孤儿；2026-07-06 排雷三个 .py 死脚本（deploy-crawlers/deploy-topic/deploy-v2，base64 打包旧源码直写生产的应急通道，从未入 git，已移入 .review-stash/demined-deploy-py-20260706/ 封存）；若日后从 git 历史翻出旧脚本，**只可读不可跑**。

**依赖锁文件铁律（红线 #7）**：改 `package.json` 依赖（加/删/升）必须**同一 commit** 更新 `pnpm-lock.yaml`。服务器 `pnpm install` 走 frozen-lockfile，manifest 与锁文件 specifier 不一致 → 安装报错 → 部署整条失败（build 都到不了）。
> 教训：07d2a74 加 `ali-oss` 到 `packages/server/package.json` 却漏更新锁文件，静默潜伏到下次部署（185222d 图文重构）才炸出来，报 "specifiers in the lockfile don't match specs in package.json"。补锁单独 commit 3dd3f2e 才通。
> 自查：本地 `pnpm install --lockfile-only` 后 `git status` 若 `pnpm-lock.yaml` 有改动，说明之前漏了 —— 必须一起提交。**每个新依赖都会再踩一次，故列为红线。**

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
