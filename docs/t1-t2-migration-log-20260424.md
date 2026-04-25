# T1 + T2 合并执行日志 · 2026-04-24

## 合并结果

### PR 状态

| PR | 内容 | 状态 | 合并时间 (UTC) | merge commit |
|---|---|---|---|---|
| #1 | drift rescue + reconcile main | ✅ MERGED | 2026-04-23（昨日） | `ce410f0` |
| #2 | T1：`inferTaskType` 枚举修复 | ✅ MERGED | 2026-04-24 00:07:55 | `b86cf1e` |
| #3 | T2：`model-router` TaskType → 具体模型直映射（stacked on T1） | ✅ MERGED | 2026-04-24 00:07:31 | `b4d534d` |

### 合并后 main 历史链

```
b86cf1e Merge PR #2 (T1 正式 merge commit)                    ← main HEAD
b4d534d Merge PR #3 (T2 + T1 实际随 stacked merge 一起入主干)
9cb643f feat(t2): model-router TaskType → 具体模型直映射
c6913c1 feat(t1): 扩展 inferTaskType 覆盖全项目 skillType 清单
ce410f0 Merge PR #1 (drift rescue + reconcile)
54e27e1 fix: rescue server drift — V3 sales module + video pipeline + schema
06b8db6 merge: reconcile server root commits with origin/main video MVP
3845668 feat: 视频生产链 + Puppeteer 期刊卡片流水线
0eac9ac feat: 爬虫优化+期刊模板+AI内容校验+CNKI采集
1bb95da feat: 更新内容引擎、爬虫模块及前端页面
```

## 合并顺序异常记录

laohan 在 GitHub 上的 merge 顺序是 **PR #3 先、PR #2 后**（与通常 stacked PR 的"底层 PR 先 merge"约定相反）。

**commit chain 反映**：
- `b4d534d`（PR #3 merge，时间 `00:07:31`）在链上位于 `b86cf1e`（PR #2 merge，时间 `00:07:55`）之下
- 因为 T2 branch 是 stacked on T1，包含完整 T1 commit 历史，PR #3 先 merge 时把 T1 + T2 都带入了 main
- PR #2 后 merge 时，T1 commits 已经在 main 里，所以产生的是**内容为空的 merge commit**

**功能影响**：无。main 最终完整包含 T1 + T2 所有变更，端到端测试通过。

**后续影响**：未来有人 review PR #2 commit 时会看到其 merge commit 不含实际内容变更，只含"合并"这个动作。只是 archaeology 的小干扰，不需要修复。

## 集成测试证据

**测试对象**：rebased T2（hash `9cb643f`），生产服务器 `/tmp/t2-check/repo`
**调用方式**：真实 DeepSeek API（非 mock）
**执行时间**：2026-04-24 08:05:07 UTC+8（merge 前最后一次真实链路验证）

### 输入
```javascript
await chat({
  tenantId: '80c42d60-83e9-4f32-8596-d96171c4b2a5',
  skillType: 'knowledge_extract',
  message: '列出中科院医学一区期刊的3个特征，各用一句话',
});
```

### pino 日志（调用开始）
```
[2026-04-24 08:05:07] INFO: AI 调用开始
    taskType: "knowledge_search"        ← T1 映射生效 (knowledge_extract → knowledge_search)
    provider: "deepseek"
    model:    "deepseek-reasoner"        ← T2 路由生效（未降级到 deepseek-chat）
    messageLength: 22
    contextLength: 0
    strategy: "serial"
```

### pino 日志（调用成功）
```
[2026-04-24 08:05:09] INFO: AI 调用成功
    provider: "deepseek"
    model: "deepseek-reasoner"
    taskType: "knowledge_search"
    inputTokens: 19
    outputTokens: 168
```

### 返回内容样本
```
1. 影响因子通常处于学科前5%甚至更高水平。
2. 发表原创研究需具有突破性创新或重大临床意义。
3. 同行评审流程极其严格，拒稿率高且审稿周期较长。
```
语义合理，无翻译腔，符合"各用一句话"要求。

### 5/5 断言全部通过

| 断言 | 期望 | 实际 |
|---|---|---|
| provider | `"deepseek"` | `"deepseek"` ✓ |
| model | `"deepseek-reasoner"` | `"deepseek-reasoner"` ✓ |
| inputTokens > 0 | true | 19 ✓ |
| outputTokens > 0 | true | 168 ✓ |
| content 有文本 | true | 158 字中文回复 ✓ |

## 最终 tsc 校验

**环境**：服务器 `/tmp/final-main-check/repo` clone 自 bundle(main)，节点复用 `/home/projects/bossmate/node_modules`
**命令**：`(cd packages/server && npx tsc --noEmit)`
**结果**：**无输出 = 0 errors**

## 关键成果

**隐性模型降级被彻底堵上**：

改造前
- 代码传 10 种 skillType 给 `inferTaskType`，原函数只认 4 种，剩下 6 种全默认落 `daily_chat` 便宜模型（`knowledge_extract` / `knowledge_search` / `style_analysis` 等都被降级）
- 路由器原本按 `expensive/cheap` 二分 tier，锁死 DeepSeek+Qwen 后两档失效
- 结果：所有推理类任务都走 `deepseek-chat`，推理能力缺失

改造后
- 10 种 skillType 都命中显式映射，`knowledge_extract` → `knowledge_search`
- `knowledge_search` 直映射到 `deepseek-reasoner`，不再降级
- 熔断器 key 细化到 `${providerName}:${modelName}`，同厂不同模型互不干扰

## 下一步

T3（删除 Claude/GPT 死代码）**被战略决策冻结**至 CODING 迁移完成。

T3 首次 git commit 必须发生在 CODING 上，不能在 GitHub。

明天（2026-04-24 白天）laohan 给 CODING 项目 URL 后执行迁移。
迁移脚本模板：`docs/coding-migration-template-20260424.md`。
