# CC 落地清单 — 图文模板重构（2026-07-03，老韩反馈六件套）

> ① 小编第一人称口吻（转述+主观解读，禁论文腔）② 短段落≤3句 + 图文交替（{{IMG:xxx}} 图位标记→封面/五种图表自动嵌入，无数据优雅降级）③ 模板空值整块隐藏（治"未公布×3"）+ 双重转义修复 + 承诺话术清除入红线 ④ 钩子/狠话批次内轮换+按人设分级（治"全员闭眼冲"）⑤ CAR/自引率来源核查（见下）⑥ sample-article 冒烟打印排版/口吻指标。
> tsc 零错误；新测试 16/16；相关防回归全绿；worktree 基线对照确认零新增失败（14 个失败全是 HEAD 存量债）。

## 0. 提交 + 部署

工作区 3 新 + 15 改（含上一 session 未提交部分，本轮已核查补漏）。建议拆两个 commit：

```bash
cd /home/projects/bossmate && rm -f .git/*.lock
# commit 1: 模板 bug 修复
git add packages/server/src/services/publisher/adapters/shunshi-style-template.ts \
        packages/server/src/services/publisher/adapters/wechat-article-template.ts \
        packages/server/src/services/publisher/wechat.ts \
        packages/server/src/services/skills/journal-template.ts \
        packages/server/src/services/compliance/content-check.ts \
        packages/server/src/services/risk-control/dictionaries/common-banned.ts
git commit -m "fix(template): 模板三修 — CAR等空值模块整块隐藏(治'未公布x3') + esc()幂等化修双重转义(&amp;/&lt;泄漏) + wechat.ts修模板HTML误走Markdown正则 + '可放心投稿/闭眼投必中/保证录用'承诺话术删除并入红线词典"
# commit 2: 六件主体
git add -A packages/server/src
git commit -m "feat(article): 图文模板重构(老韩反馈) — ①小编第一人称口吻铁律(硬数据必带主观解读,禁论文腔,人设优先) ②短段落≤3句+图位标记{{IMG:xxx}}图文交替(image-slots后处理嵌封面/图表,无数据降级,幂等签名) ③六维排版描述同步 ④钩子/狠话按天+scope轮换+人设分级(usage-rotation) ⑥sample-article打印段长/图位/语气词密度"
git push && pnpm deploy:smart   # verify: grep "小编口吻铁律" dist + health 200
npx vitest run packages/server/src/__tests__/img-slots-editor-voice.test.ts
git worktree prune   # 清理沙箱建的基线 worktree 元数据
```

## 1. 冒烟验收口径

`pnpm sample:article` 看新指标：平均段长 ≤100 字、>150 字长段=0、图位命中 3-5 个且残留标记=0、小编语气词 ≥1 处/千字且 ≤5 处/篇。人工读一遍：像不像"小编翻完资料跟你唠"。

## 2. 批量首过率复测

重跑 10 篇（同 batchId）：
- 首过率（六维≥80 且无维<6 一次通过）对照上一批的 0%
- 标题抽查：钩子模式 ≥3 种、"闭眼冲"只出现在营销/学生人设号且 ≤2 次
- 若排版维度分布异常，先看六维打分器新描述是否和成品打架再调

## 3. ⚠️ 需要老韩拍板的一件事

核查结论：正文的 CAR 指数（来源 jcarindex，PR #213 设计内）和自引率（来源 ablesci，PR #226/227 清洗后锁源）**都不是 PR #210 违规**——#210 只禁 OpenAlex 派生数据。本次已把"低风险可放心投稿"类承诺话术全删，数据本身保留。
**待拍板**：CAR/自引率要不要继续在正文/模板展示？（数据来源真实但属第三方风险库，非官方指标。）保留=信息差卖点；砍掉=最保守。**另**：此前标题侧按 B 方案拿掉了自引率——既然 ablesci 源已清洗锁定，标题是否恢复使用自引率，一并定。

## 已知限制
- 轮换计数内存态：进程重启丢计数，最坏退化回随机（单 worker 可接受，扩容挪 Redis）
- 图文交替依赖图表数据（国际刊覆盖 ~91%，国内刊低→自动纯短段落）
- 14 个 HEAD 存量失败测试（早期 PR 过期 grep 断言）未修，另开 PR 清
