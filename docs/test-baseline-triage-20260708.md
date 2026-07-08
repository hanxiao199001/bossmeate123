# 测试基线 triage 附录 — 2026-07-08

CLAUDE.md 红线 #12（测试基线护栏）的分簇明细留档。

## 背景与结论

- **快照时点**：2026-07-08，基于 main。全量 `packages/server` `npx vitest run` = **203 文件 / 1463 测试，52 红 / 1411 绿**（此前 61 红，已修 403 DVH 路由簇 9 条，见 commit `97acdac`）。
- **方法**：52 红按子系统分 6 簇，6 个只读 agent 独立 triage。每条失败：读活断言 → grep 定位生产代码 → 三分法判定，加权红线逐条亲验"功能真在"。
- **结论**：**真回归 = 0**。52 红全部为"过时漂移"（读活文件、功能仍在，断言钉住旧文案/旧门控/旧路径）。**死 = 0**（无一断言读已删文件）。

## 三分法判据

| 类别 | 判据 | 处置 |
|---|---|---|
| 死 | 断言读已删文件（readSrc/readWeb → ENOENT） | 删断言/it，留痕 |
| 过时 | 读活文件，功能可核实仍在，只是改名/搬家/换实现/门控演进/阈值调整 | 更新断言到现状（非删） |
| 真回归嫌疑 ⚠️ | 读活文件，断言描述行为/钱/数据链路/权限，却核不出功能还在 | 进名单，优先修 |

**加权红线**（即使像漂移也须确认"功能真在"才放行）：扣费、退款、落库/防丢、幂等、权限/越权、跨租户隔离、签名 URL/鉴权、金额/数字对客户的承诺。

## 六簇 triage 表

| 簇 | 红数 | 判定 | 依据 |
|---|---|---|---|
| **A** DVH 字幕样式（pr245/246/247/248） | 8 | 过时 | 内嵌字幕整条路线被 PR#251/#252 推翻改走 ffmpeg burn-in；字幕生成+烧录（buildSrtFromText→video-postprocess）完整存活，不漏字幕 |
| **B** DVH 凭证/日志/状态/按钮（pr237/238/239/141） | 5 | 过时 | 凭证解密链路完整；status 判定在且修好了旧写法对字符串 "3" 的漏判；生成链路经 UnifiedVideoModal 端到端可达 |
| **C** 图文质量/工作台（pr241/161/184/162×2/203） | 11 | 过时 | SCI 收录防编造（更强）、审稿周期数字防编造（缺数据填"周期待定"不造数）、IF/录用率落库校验（20/21 绿）、admin 权限门（后端全绿）均在 |
| **D** 数据富化/信任（pr188/206-208/194/216/182/107/1） | 10 | 过时 | IF 来源标记、信任重核 cron、防假占位、SCIE=SCI 防误导、禁 Google 兜底、LetPub 熔断——数据链路红线全核到在 |
| **E** 路由/配额/状态机/自引（journals-patch/p0-state/pr222/196/234） | 7 | 过时 | 状态机 needs_review 是有意新增 QC 闸且正确锁在 published 外（收紧非放开）；PATCH 权限门+跨租户隔离在（500 是 mock 缺 or/isNull）；配额上限后端全绿；自引单位归一化保留 |
| **F** 图表/排版/杂项（article-charts/q5/q10/pr191/179/133/-i/env） | 11 | 过时 | 图表数据链路（carIndexHistory→body）在（被 hasWosData 门控）；feed 落库/展示/跨租户隔离全命中；roundup 规则兜底在——纯渲染/模板/环境路径漂移 |

## 真回归嫌疑名单

**✅ 空。** 六簇加权红线逐条亲验功能仍在生效，无一条是"生产代码真的不干活/行为被改坏"。

## 独立待决项（非测试红，单点复核发现）

1. **发布期 hasWarnings 数据编造二次校验缺口（半兜底）** — `publishToAccounts`（`services/publisher/index.ts:125-157`）发布期只跑 `checkCompliance`（违禁词硬拦在 :150），**不重跑** `checkTitleDataConsistency`、**也不校验 content.status** → 生成期已标 `needs_review` 的数据编造内容（审稿周期/IF/录用率数字无 DB 支撑）可**直接发布**，唯一拦截是前端 ⚠️ + 人点发布。`feed-service.ts:72` 注释"发布时合规层兜底"**只对违禁词成立、对数据编造不成立**。性质：老韩 6-15 主动放行的设计（原 PR#162 靠 feed 排除硬挡，改成 ⚠️+人判），非代码回归，编造也非静默（生成期→needs_review）。**待老韩拍板**：接受"人判 ⚠️"为足够，还是补一道发布期硬闸（发布前对 needs_review/hasWarnings 重跑 checkTitleDataConsistency，不过拒发或要 forceOverride）。

## 已修（本轮相关）

- **403 DVH 路由簇**（`commit 97acdac`）：`articles-generate-dvh` + `articles-cross-tenant` 9 条 —— 非回归，是测试晚于 6-20 RBAC preHandler + PR-Z4/PR-W1 billing 闸；补 `role:"owner"` 过 RBAC + mock plan/cost-ledger 放行。真实用户三闸全放行（billing 均 fail-open、JWT 带 role 有 content.write）。
