# BossMate 图文内容质量优化执行手册

日期：2026-04-23 | 战略：锁死 DeepSeek + Qwen3.6-Plus，通过修补 AI 路由断点 + 改造文章生产链路 + 图文互锁，把期刊图文质量拉到可发布标准

## 架构诊断（执行前先读）

项目 AI 调用有两套并行抽象，所有模型路由改造必须同时触达：

1. `packages/server/src/services/ai/chat-service.ts` — 内联 callOpenAICompatible/callAnthropic 函数
2. `packages/server/src/services/ai/provider-factory.ts` + `providers/*.ts` — 规范化 Provider 抽象（被 routes/skills/crawler/content-worker 使用）

TaskType 枚举只有 8 个值，但代码里实际传了更多 skillType（knowledge_extract / style_analysis 等），经 inferTaskType() 默默落 daily_chat → cheap tier，造成隐性模型降级。

article-pipeline.ts 是单轮生成+一次重试，完全绕开 agents/ 框架。journal-image-crawler / journal-chart-generator / cover-fetcher 的产出没进文章生成 prompt。

---

## T1【P0 · 0.5h】修复 inferTaskType 枚举遗漏

**文件**：`packages/server/src/services/ai/chat-service.ts`（inferTaskType 函数）

**动作**：

1. `grep -rn "skillType:" packages/server/src --include="*.ts"` 列出所有实际使用值
2. 扩展映射至少覆盖：
   - `"article"` / `"video"` / `"content_generation"` → `content_generation`
   - `"knowledge_extract"` / `"knowledge_search"` → `knowledge_search`
   - `"style_analysis"` → `quality_check`
   - `"quality_check"` → `quality_check`
   - `"customer_service"` → `customer_service`
   - `"formatting"` → `formatting`
   - `"requirement_analysis"` → `requirement_analysis`
   - 未识别值保持现有 fallback（长文本→`content_generation`，否则→`daily_chat`）
3. 函数开头加：`logger.debug({ skillType, inferredType }, "TaskType 推断")`

**验收**：tsc --noEmit 通过；新增 `__tests__/infer-task-type.test.ts` 覆盖每分支；pnpm test 全绿

---

## T2【P1 · 1d】model-router 从 tier 改为 TaskType→具体模型直映射

**文件**：model-router.ts（核心）、config/env.ts、.env.example、chat-service.ts、provider-factory.ts

**Step 1** — env.ts 新增字段（zod schema）：

- `DEEPSEEK_MODEL_CHAT=deepseek-chat`
- `DEEPSEEK_MODEL_REASONER=deepseek-reasoner`
- `QWEN_MODEL_PLUS=qwen3.6-plus`
- `QWEN_MODEL_MAX=qwen3.6-max`（备用）

**Step 2** — model-router.ts 废弃 TASK_MODEL_MAP，改为：

```typescript
interface ModelChoice { providerName: "deepseek" | "qwen"; modelName: string; }
const TASK_ROUTE: Record<TaskType, { primary: ModelChoice; fallback: ModelChoice }> = {
  content_generation:   { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT },     fallback: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS } },
  requirement_analysis: { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
  quality_check:        { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
  knowledge_search:     { primary: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_REASONER }, fallback: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS } },
  daily_chat:           { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
  formatting:           { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
  customer_service:     { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
  translation:          { primary: { providerName: "qwen", modelName: env.QWEN_MODEL_PLUS },             fallback: { providerName: "deepseek", modelName: env.DEEPSEEK_MODEL_CHAT } },
};
```

`selectModel`/`getModelPair` 从 `TASK_ROUTE` 查，熔断器 key 从 `providerName` 改为 `providerName:{modelName}`。保留 `expensive`/`cheap` 兼容别名：`getProvider("expensive")` → `content_generation` 的 primary，`getProvider("cheap")` → `daily_chat` 的 primary（20+ 处调用不用改）。

**Step 3** — chat-service.ts 的 `executeAICall()` 删掉 anthropic 分支（不再用 Claude），启动时若检测到 `ANTHROPIC_API_KEY` 打 warn。

**Step 4** — provider-factory.ts 清理：删 AnthropicProvider 和 OpenAI 分支，expensive 列表放 DeepSeek（默认 deepseek-chat），cheap 放 Qwen（默认 qwen3.6-plus）。

**验收**：编译通过；启动只看到 ✅ DeepSeek / ✅ 通义千问；集成测试：`skillType:"knowledge_extract"` 请求日志 model 应为 `deepseek-reasoner`

---

## T3【P1 · 0.5h】删除 Claude/GPT 死代码

- 删 `providers/anthropic.ts`
- 删 chat-service.ts 里 `callAnthropic` 函数
- env.ts 移除 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`DEFAULT_EXPENSIVE_MODEL`（先全项目 grep 确认）
- `.env` / `.env.example` 同步清理
- provider-factory.ts 移除 anthropic/openai 分支
- package.json 若有 `@anthropic-ai/sdk` 依赖，`pnpm remove`

**验收**：`grep anthropic/ANTHROPIC/gpt-4/OPENAI_API` 只剩注释；`pnpm build` 通过

---

## T4【P2 · 2-3d】article-pipeline 改造为章节级 critique-rewrite 循环

**新建**：`article-pipeline-v3.ts`（与 v2 共存，环境变量 `ARTICLE_PIPELINE_VERSION=v3` 切换）

**新流程**：

1. RAG 检索（保留）
2. 大纲生成（skillType 改 `"requirement_analysis"` → DeepSeek-R1）
3. 章节并行初稿：`outline.sections` 每个独立调 `chat()`，skillType=`"content_generation"` → DeepSeek-V3，并行度 2，prompt 只塞本 section 相关 RAG + 整体骨架
4. 章节自审：每 section 调 `chat()`，skillType=`"quality_check"` → DeepSeek-R1，以"期刊行业资深编辑"人设输出 JSON critique: `{issues:[{type,severity,snippet,suggestion}], overallScore:0-100}`；score<75 或有 `severity=="high"` 进入 Step 5
5. 按 critique 定点重写：只改 critique 指出的片段，最多 2 轮
6. 合章过渡：DeepSeek-V3 只写过渡句，不动正文
7. 中文 polish：整篇喂 Qwen3.6-Plus，skillType=`"formatting"`，prompt: "你是期刊行业内容编辑。只做语言润色：减少翻译腔、去口水话、让标题更有打开欲。不改变事实、数字、结构。"
8. 质检 v2（保留）+ 入库

**新建 prompts 目录**：`content-engine/prompts/` — `section-draft.ts` / `section-critique.ts` / `section-rewrite.ts` / `coherence-pass.ts` / `zh-polish.ts`

critique JSON 存 `production_records.metadata.critiques`。每 step `emitProgress`。

**验收**：测试主题"2024 年中科院一区医学期刊投稿策略"，v2 vs v3 对比；v3 用时 60-120s；`metadata.critiques` 有内容；人工评估 v3 > v2

---

## T5【P2 · 1d】evidence pack 聚合器（可与 T4 并行）

**新建目录**：`services/aggregator/`

- `evidence-pack-builder.ts` — 主入口
- `journal-entity-resolver.ts` — 按 ISSN 合并 LetPub/OpenAlex/PubMed 同一期刊
- `conflict-detector.ts` — 冲突字段检测
- `types.ts`

**EvidencePack 结构**：

```typescript
{
  topic: string,
  journalCards: Array<{
    issn, name, if, quartile,
    recentPapers: [{ title, abstract, year }],
    imageUrls: string[], coverUrl: string,
    conflicts: [{ field, sources: [{ source, value }] }]
  }>,
  heatSignals: Array<{ keyword, sources, score }>,
  policySignals: Array<{ policy, effectiveDate, relevance }>,
  facts: Array<{ claim, source, confidence }>
}
```

**数据源**：读已 sink 的数据库表（`services/data-collection/crawl-data-sink.ts` 写入的），不重爬。

T4 v3 pipeline 在 Step 1 后调 `buildEvidencePack()`，注入后续所有 section prompt。

**验收**：返回结构完整；至少一个 `conflicts` 非空；v3 生成文章有具体期刊名+数字（不再是"某一区期刊"空话）

---

## T6【P3 · 1d】图像资源接入文章 prompt

**文件**：`article-pipeline-v3.ts`、新建 `content-engine/image-binder.ts`

- 大纲阶段把 `evidencePack.journalCards` 的图片语义标签（非 URL）列给 R1：`[IMG:cover_nature_medicine]` / `[IMG:if_trend_nature_med_2020_2025]` / `[IMG:quartile_pie_med_top10]`
- 大纲 JSON 要求每 section 明确建议配哪些图（标签 ID）
- 章节生成时正文嵌入占位符
- `image-binder.ts` 提供 `bindImages(articleBody, evidencePack)`，入库前替换占位符为 `<img src="腾讯云 COS URL" alt="..."/>`
- 占位符找不到对应图 → 降级为文本描述 + `<!-- MISSING_IMG:xxx -->`

**验收**：生成 HTML 有 2-5 张真实 URL 图；无图场景无断链

---

## T7【P3 · 0.5d】前端 critique 历史展示

**文件**：`apps/web/src/pages/` 文章详情页（grep 自行确认路径）

读 `production_records.metadata.critiques` → 时间线展示：章节 → 第 N 轮 critique → 改动 diff。内部账号可见。

**验收**：运营打开任意 v3 文章能看到 critique 历史

---

## 硬规则

- 严格按 T1→T2→T3→T4/T5→T6→T7，前置不过不开下一个
- 每任务完成跑 `pnpm tsc --noEmit` + 相关单测，通过才进下一个
- 每任务开 branch：`feat/content-quality-t1-infer-task-type`
- 不改数据库 schema（除非 T5 需要，单独出 migration 审查）
- 代码现状与手册描述不符时停下来问，不要编造
- **（T2 新增）每个 T 任务开工第一步必做 drift 检查**：
  - `diff` 服务器版 vs git HEAD，对所有本 T 任务将要改的文件全部走一遍
  - 发现不一致立刻停下来决策，三选一：
    - A. 先 `fix/capture-*-drift` 分支抢救 drift、入库，再在其上做本 T 任务
    - B. 确认 drift 是废弃/实验 WIP，可丢，直接用 HEAD 版本做
    - C. 只改不冲突的部分，冲突点跳过留到后面 T 任务处理
  - 不做 drift 检查就动手 = 轻则漏改功能、重则覆盖线上功能
  - 背景：T2 执行时在 chat-service.ts（timeout/retry）和 index.ts（salesRoutes / videoRoutes / gzip / 崩溃 handler 等）两处发现 scp-only drift，均是线上功能未入 git。第一次在 T2 开工前察觉做了 rescue 入库；第二次在合并 stash 时才发现差点污染 commit，已及时回退。下一次 T 任务 drift 检查范围要包含可能被 WIP stash 带出来的所有文件。

---

## 最终验收（全部完成后）

测试主题："SCI 二区医学期刊投稿避坑指南"，v2 vs v3：

- v3 ≥3 处具体期刊名+IF 数字
- v3 ≥2 张真实配图图文相关
- 语言无翻译腔
- metadata 有 critique 循环记录
- 单篇总成本 ≤ ¥0.5
