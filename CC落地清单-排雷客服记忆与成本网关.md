# CC 落地清单 · 排雷 + 客服多轮记忆 + LLM 成本落库 + 主链路接网关

> 来源:战略评估(见《战略评估报告-全项目体检-20260706.md》)P0 两项 + P1 头两项,老韩已拍板。
> 代码已在桌面本地完成并 commit(作者 Claude (Cowork)),**三个分支、全部 base=main、互不依赖、零文件冲突、无 migration**。
> CC 只需:push → 开 PR → merge → 一次 deploy → verify。

---

## 一、分支清单(已 commit,待 push)

| 分支 | commit | 内容 | 测试 |
|---|---|---|---|
| `chore/deploy-script-demine` | 09ceaa0 | 三个 base64 死部署脚本(deploy-*.py)封存进 .review-stash;gitignore 补 worldmonitor/ + deploy-*.py;CLAUDE/AGENTS 措辞同步 | 文档/配置改动,无测试 |
| `feat/kf-multiturn-memory` | 7064ae7 | AI 客服四个 chat() 调用点接会话历史 context(最近10条/单条截500/预算2400,失败降级无记忆应答);分类 prompt 补指代消解 | kf-multiturn-memory 7/7 绿 |
| `feat/llm-gateway-and-cost` | 98f9290 + 43247ac | ① cost-ledger llm 类型接通:chat() 出口自动记账,价目表 env 可覆盖,pnpm cost:report;② article/video-skill 换 RoutedProvider 走网关(熔断/主备降级/重试/长超时),temperature/maxTokens 透传,ALS 按租户归属成本 | llm-cost 8/8 + routed-provider 5/5 绿 |

commit message 里有完整动机/设计/行为差异说明,PR 描述直接引用即可。

## 二、执行步骤

```bash
cd ~/Desktop/02_AI项目与产品/【007】bossmate/bossmate-project

# 1. push 三个分支
git push -u origin chore/deploy-script-demine
git push -u origin feat/kf-multiturn-memory
git push -u origin feat/llm-gateway-and-cost

# 2. 开三个 PR(base=main, 红线#1), merge 顺序任意(无依赖); 建议 demine → kf → gateway
# 3. 三个全 merge 后, 本地 main 同步, 一次部署(红线#5)
git checkout main && git pull
pnpm deploy:smart
```

**桌面预检(push 前建议)**:`pnpm -F server exec tsc --noEmit`(沙箱只做了定域检查;沙箱环境有一个与本次改动无关的报错:douyin-open-api.ts 的 Buffer/base64url 类型,疑似 @types/node 版本差异,桌面若不报则忽略,若也报请单独小修勿混入本批)+ `pnpm -F server exec vitest run src/__tests__/kf-multiturn-memory.test.ts src/__tests__/llm-cost-record.test.ts src/__tests__/skills-routed-provider.test.ts`(应 20/20 绿)。

## 三、verify(红线#5 三项 + 功能级)

```bash
# a. 标准三项(本批为纯 server 改动, 字面查 server dist 而非 web assets)
ssh bossmate-boss 'ls -la /home/projects/bossmate/packages/server/dist/services/ai/routed-provider.js'   # 存在+mtime 新
ssh bossmate-boss 'grep -l "loadHistoryContext" /home/projects/bossmate/packages/server/dist/services/work-wechat/kf-responder.js'
ssh bossmate-boss 'curl -s http://localhost:3000/api/v1/health'   # 200

# b. 功能验收 1 · 客服记忆: 企微客服先问「Nature 的影响因子」, 再追问「那审稿周期呢」
#    → 第二答仍是 Nature 的数据; 服务器日志 "kf 意图分类完成" 行应带 historyLen>0

# c. 功能验收 2 · 成本落账: 生成一篇文章(或工作台聊几句)后
ssh bossmate-boss "cd /home/projects/bossmate && psql \$DATABASE_URL -c \"SELECT kind, amount_cents, quantity, note, created_at FROM cost_ledger WHERE kind='llm' ORDER BY created_at DESC LIMIT 5;\""
#    → 有行, note 形如 "deepseek/deepseek-chat task=content_generation in=... out=..."
#    → 文章生成产生的行 tenant_id = 触发任务的租户(ALS 归属生效的铁证)
pnpm cost:report          # 服务器上跑, 出 租户×日/按模型/本月合计 三张表

# d. 功能验收 3 · 网关: article 生成时服务器日志应出现 "AI 调用开始"(taskType=content_generation,
#    strategy=serial) —— 说明主链路已进 chat-service; 旧路径无此日志
```

## 四、已知限制与注意

1. **成本数据从部署时刻起才积累**,历史消费无法回填;价目表是 2026-07 手抄估算(deepseek-chat ¥2/¥8、reasoner ¥4/¥16、qwen-plus ¥0.8/¥2 每百万 token),**对一次百炼账单**,有出入用 `.env` 的 `LLM_PRICE_OVERRIDES`(JSON,分/1M token)校准,不用改代码。
2. **无 migration、无新必填 env**。`LLM_PRICE_OVERRIDES` 可选。
3. 网关行为差异(有意):旧直连 HTTP 失败向上抛;网关在主备全挂时返回道歉文案。skills 对两形态都有现成消化路径,详见 routed-provider.ts 头注——若上线后发现某 skill 对道歉文案处理不当,报出来单独修,别回退整批。
4. kf 记忆只作用于新消息;manual 会话照旧静默;历史加载失败自动降级为无记忆应答(不转人工不报错)。
5. **worldmonitor/ 需要老韩手动拖出项目目录**(是误入的第三方开源仓库,66 项含自带 .git,我无法跨目录移动);gitignore 已兜底防误提。deploy-*.py 封存在 `.review-stash/demined-deploy-py-20260706/`(附 README),任何情况下不得执行。
6. 工作区里 `lancet-car-line.svg` 的未提交改动是别的会话产物,本批三个分支均未包含它,**勿顺手提交**。
7. 后续可选:AI 客服每日一致率、cost:report 定时推送、成本进今日驾驶舱——等本批稳了再排。

## 五、与死测试清理(Task #1)的关系

无冲突。本批新增 3 个测试文件均为行为测试(mock 依赖黑盒断言,非源码字面断言),符合《交接文档-死测试清理.md》的目标形态,清理会话不需要碰它们。
