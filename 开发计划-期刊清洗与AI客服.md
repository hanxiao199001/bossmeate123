# 开发计划：期刊数据清洗 + 企微 AI 客服（并行，约 2 周）

> 2026-07-02 定稿。小程序暂缓。AI 客服采用**混合模式**：知识库/期刊库能答的自动回，拿不准的转人工并通知运营。

---

## 线 A：期刊数据清洗与优化（存量 + 增量）

现有底子：enricher 六数据源（LetPub / OpenAlex / DOAJ / Crossref / 分区表 / 万方）+ trust-score/confidence + admin 审计 API + 现成脚本（dedup-domestic-journals / ingest-letpub-pool / refresh-journals-pool）。**不新建体系，跑通 + 补调度。**

### A1 存量体检（第 1 天）
- 跑 `/admin/journals/audit/stats`：confidence 分布、ai_fabricated 数、从未验证数
- 补一个体检脚本：关键字段缺失率/冲突率（IF、中科院分区、JCR 分区、预警名单、录用率）
- 产出：**脏数据清单**（低置信 + 字段冲突 + 编造嫌疑），按严重度排序

### A2 存量清洗（第 2-4 天）
- 写批量 re-enrich 脚本（复用 orchestrator.enrichJournal，带限速/断点续跑），优先 confidence 低 + 被内容引用多的刊
- IF/分区与 LetPub 最新年度核对，冲突按 trust-score 修正，全部写 enrichmentLog（可回溯）
- ai_fabricated 期刊处置：走数据库护栏三步（dry-run count → 查引用 → han 拍板）
- 国内刊复跑去重
- **删除/修正一律留痕，禁止无日志批量 UPDATE**

### A3 增量管道（第 5-6 天）
- refresh-journals-pool 挂定时任务（复用 server 的 task 服务）：每周增量刷新低置信/久未验证的刊；预警名单/分区表按年度版本更新
- 生成端护栏回归：确认排除 ai_fabricated、复合 IF 不并入 impact_factor 仍生效

### 验收标准
- 随机抽 20 刊人工核对 IF/分区/预警，100% 一致
- confidence < 60 的占比给出前后对比数字
- 增量任务连续运行一周无失败告警

---

## 线 B：企微 AI 客服（混合模式）

现有底子：回调 handshake/加解密/kf_msg 解析/leadCollector（~250 行）。**缺整个应答层**：客服账号管理、sync_msg 拉消息、AI 回答、回复发送、转人工。RAG 知识库（knowledge 服务）可复用。

### B1 配置打通（第 1 天，需 han 配合）
han 在企微管理后台：
1. 开通「微信客服」，创建 1-2 个客服账号
2. 提供：corpId、微信客服 Secret、回调 Token + EncodingAESKey
3. 回调 URL 指到服务器 `/api/v1/work-wechat/callback`（路由已有），配可信 IP

### B2 消息收发链路（第 2-4 天）
- kf 回调事件 → 调 `sync_msg` 拉取消息（游标管理、去重复用 dedupMsgs）
- access_token 缓存刷新、`send_msg` 回复、处理 48 小时/5 条限制
- 验收：企微里给客服发消息，系统能收到并原样回一条

### B3 AI 应答引擎（第 5-8 天）
- 意图分类：期刊咨询 / 服务与价格 / 闲聊 / 投诉敏感
- **期刊问题**：实时查 journals 库回答（IF/分区/录用率/预警），LLM 只组织语言、禁止编数——数据准确是生命线，与线 A 直接联动
- **服务/价格问题**：客服 FAQ 知识库（复用 knowledge RAG，新建 faq 类目，运营可增删）
- **拿不准/投诉/敏感**：不硬答，转人工 + 企微推送通知运营
- 全部会话落库（复用 messages 表或新表）

### B4 后台与验收（第 9-10 天）
- Web 端：会话记录查看页 + FAQ 管理页
- 验收：20 个真实客户问题实测——期刊数据零编造、转人工判断准确、响应 < 10 秒

---

## 时间线

| 周 | 线 A | 线 B |
|---|---|---|
| 第 1 周 | A1 体检 + A2 存量清洗 | B1 配置 + B2 收发链路 |
| 第 2 周 | A3 增量管道 + 验收 | B3 应答引擎 + B4 后台/验收 |

## 需要 han 做的事（越早越好）
1. 企微后台开通微信客服、建账号、给四项凭证（B1）
2. 准备客服 FAQ 素材：服务介绍、报价话术、常见问题 10-20 条
3. A2 的 ai_fabricated 处置需要你拍板一次
