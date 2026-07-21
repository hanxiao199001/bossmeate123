# CC 落地清单 — 图文质量 P0 四件套（2026-07-02）

> ① 质检对齐老韩六维（钩子20/数据准确25/密度20/排版15/实用10/合规10，≥80 且无维<6 才过）+ 低分维度自动定向重写闭环（≤2 轮，仍不过转 needs_review 带分数）② 钩子模式库（8 种子 + 语料学习脚本）③ AI 腔禁词 46 条（prompt 预防 + 段落级清洗）④ 压缩去水分 pass（~72%，区间校验防过压）。
> tsc 零错误；decliche 14 组断言全过；1165 个防回归 grep 核验新增 miss=0。**无 migration**，新 env 全有默认值（开）。

## 0. 提交 + 部署

```bash
cd /home/projects/bossmate && rm -f .git/*.lock
git add -A packages/server/src   # 16 个文件（7 新 9 改），git status 核对无多余
git commit -m "feat(quality): 图文质量P0四件套 — ①质检替换为老韩六维(20/25/20/15/10/10, ≥80且无维<6)+低分维度自动定向重写闭环(复用section-rewrite, ≤2轮, 不过转needs_review带qualityLoop) ②钩子模式库(8种子+语料提炼脚本, 大纲prompt强制选型) ③AI腔禁词46条(prompt预防+命中段落级LLM清洗) ④压缩去水分(~72%, 55-90%区间校验). 编排器quality-pipeline接入batch-worker主路径/article-pipeline/daily-cron三处"
git push && pnpm deploy:smart
npx vitest run packages/server/src/__tests__/decliche.test.ts
```

## 1. 冒烟（部署后）

```bash
cd /home/projects/bossmate/packages/server
pnpm sample:article --account "paper 咨询与发表"
# 看输出"六维质检(老韩标准)"块：六维分/总分/数据密度/压缩比/AI腔命中数/重写轮数/新增LLM调用
```
然后跑一小批 batch，日志 grep `P0四件套`，低分文章在管理端 metadata 看 `sixDimScores` / `qualityLoop`。

## 2. 语料钩子提炼（服务器一次性，可选但建议）

```bash
pnpm exec tsx src/scripts/extract-hook-patterns.ts
# 从 467 篇客户语料提炼真实钩子模式 → data/hook-patterns-learned.json（存在即自动优先于种子库）
```

## 3. env（都有默认值，一般不用动）

`ARTICLE_SIXDIM_QC / ARTICLE_CONDENSE / ARTICLE_DECLICHE / ARTICLE_HOOK_INJECT`（false 单独关某件）、`ARTICLE_QUALITY_REWRITE_MAX`(2)、`ARTICLE_CONDENSE_RATIO`(0.72)。

## 4. 成本

正常每篇新增 ¥0.01-0.05（1-3 次 DeepSeek 调用）；触发满额重写循环 ~¥0.15。批量跑一天后看 cost_ledger 确认无异常放大。

## 5. 已知限制
- roundup 盘点文、chat 会话内生成两条路径未接（前者模板拼装风险>收益，后者 180s 超时圈内），只有 prompt 层预防
- 模板 HTML 文跳过④压缩（防破排版），水分靠③+①段落级改写
- 六维 LLM 打分有波动；评分服务挂时 degraded 兜底放行（metadata 有标记），不阻塞生产
- qualityCheckV2 返回的 scores 已六维化，若有外部消费方需同步

## 6. 验收（老韩）
部署+钩子提炼后：批量生成 5 篇，按评分表人工打分对照机器六维分——两者趋势应一致（机器分可有 ±1 波动）。人工仍低于 8 的维度报回来，进入下一轮单点修（候选：排版皮肤、结构级写法模仿、图表嵌入普通图文）。
