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

## 红线 #14 — 兜底不许产出与真数据同形态的文案（2026-08-06）

**强制规则**：降级/兜底路径**不得**产出与真数据长得一样的内容。两种正确写法，二选一：

- ✅ **整句不出现** —— 适合嵌在叙述句里的（范例：`storytelling-template.ts` 的 `qualifier`）
- ✅ **明确标注无数据** —— 适合数据卡格子（格子不能空）。范例：`shunshi-style-template.ts:415`「未分区」、`:417`「JCR 分区数据未公布」、`:517`「近年 CAR 指数暂未公布」
- ❌ 无 IF 写「高影响力」、无分区写「权威期刊」、无刊期写「排版上线」

**补充上限**：标注也有度。**一张卡里超过半数格子是「暂无 X」→ 整张卡不出现**。
一格暂无是诚实，满卡暂无是空洞（判据见 `adapters/field-slot-guard.ts` 的 `shouldHideCard`）。

**高发形态：三元 `:` 后面的字符串字面量**，以及 `||` 兜底。扫这两个形态能一次性捞出大部分。

**为什么是红线**：这是本项目**第五次**「降级产物与真产物不可区分」——

```
质检超时  → 给 0 分        → 下游当"内容极差"剔除
TTS 失败  → 给静音音频     → 下游当"正常音频"提交（7-31 哑巴视频事故）
DVH 失败  → 给占位片       → 下游当"真视频"落库并显示成功
检索失败  → 给空数组       → 下游当"无规则"全部放行
无 IF/分区 → 写"高影响力"  → 读者与下游都当"这刊确实不错"（8-06）
AI 返回抽不出 JSON → 拼标题 → 下游当"生成成功"（8-07，见下）
```

### 第六次特别注记：兜底把失败改写成成功 = 全部下游监控同时失明

`article-skill.generateJournalRecommendation` 的兜底 return：**80 篇、`rating: 4` 硬编码、零日志、零 incident、零 metadata 标记**。8-05 刚建的失败分类 / 服务恢复自动重跑体系对它**完全失明**——因为失败在 `catch` 里被洗成了成功。

病灶是一行没有 `else` 的 `if`：

```ts
try {
  const jsonMatch = result.content.match(/\{[\s\S]*\}/);
  if (jsonMatch) { return {...} }        // ← 没有 else
} catch (err) { logger.warn(...) }        // ← 只有抛异常才记
return { title: `期刊推荐：${x}，影响因子 ${y}`, rating: 4 };   // ← 静默到达
```

`jsonMatch` 为 null 时 try 正常走完、不抛异常、不进 catch，直接掉到兜底。**连续三天 100% 走这条路，没有任何人任何系统知道。**

> **教训：可观测体系只能看见「以失败形态存在的失败」。兜底把失败改写成成功的那一刻，全部下游监控同时失明。**
>
> 推论：加告警、加失败分类、加自动重跑，都建立在"失败会以失败的形态出现"这个前提上。**这个前提由兜底代码单方面决定**——所以红线 #14 不是文案洁癖，是可观测性的地基。写兜底时问一句：**这条路径走过之后，有没有任何一个字段/日志/指标会变得和成功不一样？** 答案是"没有"就必须停下来。

前四次都写在附录的反模式里了，还是又犯了一次——**因为前四次都发生在"数据链路"，这次发生在"文案层"，看起来不像同一件事**。判断标准不变：**如果下游（包括读者）拿到它时无法区分真假，那这个降级就是在制造事故**。

> 特别注意：这条与 prompt 禁令**必须同步**。8-06 的实况是 `journal-data-supply` 刚禁止 LLM 用「影响因子较高」这类形容替代，而模板自己在干同一件事——**禁了生成侧，没禁渲染侧，等于没禁**。模板改完还要在出稿健康闸加词表（`output-health.ts` 的 `FALLBACK_PHRASE_PATTERNS`），因为 LLM 自己也会写出同样的话。

---

---

---

---

## 红线 #21 — 不重做存量内容：存量只改标记，不重新生成（老韩 2026-08-18 立，即刻生效）

**强制规则**：新逻辑修好之后，让它作用于**新产出**，用**新旧对比**证明改对了 ——
而不是把旧的重跑一遍。

> **重生成 = 重新烧 token 和钱，而存量内容的价值已经沉没。**

### 边界

```
✅ 允许（零 LLM 成本的数据操作）
   改状态 / 改 metadata / 补标记 / 摘 body / 加说明文案

❌ 禁止（未经老韩单独批准）
   批量重生成内容 / 批量重跑质检 / 批量重渲染视频
   —— 要批，得说明**为什么这批值得重花一次钱**
```

### 已经做过的两次都符合这条（都没重生成）

| 日期 | 动作 | LLM 成本 |
|---|---|---|
| 8-13 | DVH 占位素材摘 body：只改 body 文案 + metadata 留证（原 URL、原 body 都存着） | 零 |
| 8-18 | 救回 35 条被 watchdog 误杀的内容：只做状态迁移 `failed → generating → needs_review`，正文一个字没动 | 零 |

**继续保持这个形态。**

### 排查也适用同一条

「再跑一次看看」这类验证，**能用存量数据回答的就不要新跑**。

- ✅ 8-17 的 `reasoning_effort` 对比（10 刊 × 2 臂 = 36 次调用）是**必要**的 ——
  它要的是同刊同条件的 A/B 差值，存量数据里不存在这个对照。
- ❌ 「验证某个 bug 是否复现」这类，**先查库里有没有现成样本**。
  8-18 那条数字人空播放器就是这么定位的：一条 SQL 查 metadata + incident 就出了答案，
  没有重新提交任何一次生成。

> 判断标准：这次调用**产生的是新信息，还是重复已有信息**？
> 前者花钱有理，后者是把已经付过的钱再付一遍。

## 红线 #20 — 同一个量的不同度量，差一个数量级时混用 = 判据完全失效（2026-08-18）

**强制规则**：定阈值 / 写判据前，先确认**你手上那个数和你要卡的那个量是同一种度量**。

**实例（8-18）**：救援脚本要筛「内容其实写完了」的失败内容，我把下限定成 3000 字 ——
依据是那几条的 `length(body)` = 11027 / 11420 / 6736。跑出来 **0 条候选**。

```
raw body（含 HTML 标签与样式）  11027 字
净正文（剥标签与空白）            869 字      ← 差 12.7 倍
```

**我拿 raw 长度去卡净长度的门槛。** 按同晚真实分布校准后（正常成品净长 min 401 / 均 1312），
下限改成 400，候选从 0 变成 35 —— 三周里累计 35 篇写完了、花了钱、被误杀的内容。

**这次侥幸的地方**：错的方向让阈值**过严**，表现为「0 条候选」这种显眼的失败。
反过来（阈值定松）就会**静默救回一批不该救的**，而那不会有任何症状。

**同族的三次**（都是「两个都对的口径被混用」）：

| 案例 | 口径 A | 口径 B | 混用后果 |
|---|---|---|---|
| 台账（8-16） | `evaluated` 运行次数 841 | 内容篇数 191 | 「841 次零命中」被读成「841 篇都干净」，证据强度夸大 4.4 倍 |
| 学科配额（8-17） | 槽位学科（需求侧） | 刊的 `discipline_code`（供给侧） | 按刊记账的话，1139 本 generic 通配刊成为绕过所有配额的公共后门 |
| 救援阈值（8-18） | raw body 长度 | 净正文长度 | 差 12.7 倍，判据完全失效 |

> **两个口径都对，不代表可以互换。** 混用时它们不会报错 ——
> 判据照常运行、结果照常产出，只是**答的是另一个问题**。

**怎么防**：写下阈值时，同一行注释里写清**这个数是哪种度量、依据是哪组实测分布**。
`MIN_BODY_CHARS = 400  // 净正文，非 raw；依据 8-17 正常成品 min 401` —— 这一行注释比阈值本身值钱。

## 红线 #19 — DB 行为类改动必须在真库上跑冲突路径（2026-08-17）

**强制规则**：约束 / 索引 / `ON CONFLICT` / 触发器这类改动，验收**必须包含真库上的冲突路径实跑**。

> **tsc 证明类型、单测证明逻辑、守卫证明代码形状 —— 三者都证明不了 Postgres 会怎么执行。**

**实例（8-17）**：`batch_row_id` 部分唯一索引 + `onConflictDoNothing`。

```
tsc      ✅ 通过
单测     ✅ 全绿
守卫     ✅ 断言了「onConflictDoNothing 在不在」—— 它在
真库     ❌ 42P10: there is no unique or exclusion constraint
            matching the ON CONFLICT specification
```

根因：`ON CONFLICT` 的推断**匹配不上部分索引**，除非把索引的 `WHERE` 谓词原样写进来
（`{ target, where: isNotNull(col) }`）。少了谓词，类型对、逻辑对、形状对，**一连库就炸**。

后果与「只加约束不加冲突处理」完全等价 —— 上线当晚 batch 全线崩，只是死法不同：
一个死于唯一键冲突，一个死于推断不出唯一键。

**怎么算跑过冲突路径**：在服务器上对着真表，把**冲突本身**制造出来并观察结果。
本次的做法是同一 `batch_row_id` 连插三次，期望「成功 / 跳过 / 跳过、最终 1 行」，
跑完删除自测数据。**不是**跑一次正常插入就算数 —— 正常路径从来不碰约束。

> 守卫的能力边界要认清：它能证明「这道防线还在不在」，证明不了「这道防线会不会生效」。
> 8-17 那条守卫两样都写了，但只有前一样是它做得到的。

## 红线 #18 — 差分实验的判据必须是**差分的**（2026-08-15）

**强制规则**：给 A/B 实验写判据时，两条硬要求 ——

1. **判据先拿基线跑一遍。基线自己过不了的判据，测不出任何变化。**
2. **「持平」一律写成单向：只禁变差，不禁变好。**

**实例（8-15 `reasoning_effort=low` 实验）**：预注册了三条判据，跑完 ①② 都判「不过」，
但两条都不是实验组变差 ——

| 判据 | 我怎么写的 | 为什么测不出东西 |
|---|---|---|
| ① 字数落 800-1200 | **绝对区间** | 基线自己就是 755，也不过。它没在区分两臂，实验组反而高 24 字 |
| ② 与现状差 <5% | **对称**的「持平」 | 章节 1.5→1.8、健康问题 1→0 都是**改善**，照样被判不过 |
| ③ 撞顶率下降 | —— | 唯一真判据，但生产频率 0.17%，n=10 两臂都是 0，无法裁决 |

> **判据写坏了要认，不能事后改口径把它救成「通过」。** 预注册的全部价值就在这一句上。
> 反过来同样成立：实验组「看着更好」的维度也不许事后捡回来当结论 ——
> 救实验与改判据是同一种病。

**配套**：③ 那类「事件频率极低」的判据，先算一遍**期望命中数**再决定样本量。
0.17% × 10 次 = 0.017 —— 这种实验不是样本不够，是设计上就答不了问题；
要么定向到能复现的样本，要么承认这个问题当前测不了（本次两者都试了，仍复现不出）。

---

## 红线 #13 — 告警文案只陈述事实，不写归因（2026-08-02）

**强制规则**：告警/错误文案里**只写可验证的事实与数据**，**不写"这多半是因为 X"**。

- ✅ 「今日调用 2004 次，超上限 2000」「本日均价 0.0195 元/次」
- ✅ 给线索可以，但必须是**可验证的数据**并写明怎么对照：「均价偏低 → 多为失败重试；持平 → 排产量太大」
- ❌ 「次数暴涨而花费不高，典型是**失败重试打转**」← 一句猜测，写死在文案里

**为什么是红线**：2026-08-01 LLM 日调用撞顶，熔断文案自带上面那句归因。8-02 排查时它把方向
直接带偏——按"重试打转"查了半天重试链路，实际根因是**行业月度 cron 一次性入队 593 行**
（平时 24 行），每篇本来就要 8~10 次调用，属于正常消耗撞天花板，与重试毫无关系。

反证只用了三个数：均价 0.0195 元/次（与近邻日 0.0177~0.0194 持平，重试打转应是大量廉价失败调用把均价拉低）、
8 条 llm_timeout 全部 `suppressedSinceLastAlert=0`（超时稀疏，凑不出 2000 次）、
2038÷219=9.3 次/篇（与正常日 8.1~8.3 同量级）。**这三个数文案里一个都没有，猜测倒是有一句。**

> **一条错误的归因比没有归因更糟**：没有归因，人会去查数据；有了错误归因，人会照着它查。
> 归因是排查者的工作，告警的工作是把事实和对照基准摆出来。

---

## 红线 #12 — 测试基线护栏（新增失败=阻塞项）

**背景**: 2026-07-08 对全量 `packages/server` 测试基线（203 文件 / 1463 测试）做过一次系统 triage。当时 52 红，六簇独立核查 + 加权红线（扣费/落库/幂等/权限/越权/跨租户/签名鉴权/数字承诺）逐条亲验 —— **真回归=0**，52 红全部是"过时漂移"（读活文件、功能仍在，只是断言钉住了旧文案/旧门控/旧路径）。分簇明细见附录 `docs/test-baseline-triage-20260708.md`。

**强制规则**:
1. **52 过时红是"已知漂移"**，逐簇慢清、**不阻断**开发；清理只可两种动作 —— ①**更新断言到现状**（功能仍在，跟进改名/搬家/换实现/门控演进）②**删读已删文件的死断言**（readSrc→ENOENT）。
2. **禁为过测试改生产代码**。测试红几乎都是断言过时，先核"功能是否仍在"，是→改测试；只有确认功能真丢/行为改坏才动生产（那属真回归，走修复 PR）。
3. **新增失败一律视为真回归嫌疑 = 阻塞项**，**不得带新失败合并**。你的 PR 让某个原本绿的测试变红 → 默认你的改动引入了回归，必须查清（是你改坏了功能，还是你合理改了行为但漏更新断言）再合。
4. 判"漂移 vs 真回归"沿用三分法 + 加权红线：**死**（读已删文件）/**过时**（读活文件、功能可核实仍在）/**真回归嫌疑**（读活文件、断言的是行为/钱/数据链路/权限，却核不出功能还在）。拿不准算嫌疑，宁可多报。

**基线怎么量（2026-07-29 补，规则 3 的前提条件）**

规则 3 判的是"新增失败"，而"新增"是个**差值**——基线量错，整条护栏就空转。已经踩过两次：

5. **必须在干净 worktree 上按 commit 跑，禁止在混着未提交改动的工作区量。**
   多 agent 并行时主工作区同时躺着别人的在制改动，量出来的既不是上一个 commit 也不是你这个 commit。
   > 教训：2026-07-25~28 连续几次报"零新增失败"，全建立在被污染的基线上。
   > 2026-07-29 用干净 worktree 复核，真实 commit 基线是 **45 失败文件 / 41 用例**，
   > 而当时以为的是 26/39 —— 差了 19 个文件，护栏等于几天没在工作。

6. **worktree 必须 symlink `.env`。** `config/env.ts` 是 fail-fast 设计（`findEnvFile()` 找不到直接
   throw），缺 `.env` 会让一批测试在 **import 期**就挂，看起来像"失败暴增"。
   > **识别信号：两次运行的「总用例数」对不上 = 环境没对齐，此时任何对比都无效。**
   > 实测漏 `.env` 时收集到 1929 个用例，对齐后是 2142 —— 先修环境，再看数字。

```bash
# 服务器上跑（Mac 跑不了 vitest，见 memory: vitest 本地跑不了→上服务器跑）
MAIN=/home/projects/bossmate; WT=/tmp/wt_<commit>
git -C "$MAIN" worktree add -q --detach "$WT" <commit>
ln -s "$MAIN/node_modules"                 "$WT/node_modules"
ln -s "$MAIN/.env"                         "$WT/.env"           # ← 别忘
ln -s "$MAIN/packages/server/node_modules" "$WT/packages/server/node_modules"
cd "$WT" && npx vitest run --reporter=basic
```
node_modules 用**绝对路径 symlink 指向主仓**：目录内部的相对 symlink 按物理路径解析，会落回主仓
的 `.pnpm` 不会断。对照用 `comm -13 base.txt now.txt` 出"新增失败"、`comm -23` 出"修好的"，
**别肉眼比清单**——40 行的清单人眼比不出 13 处差异。

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
| 15 | 回归锁锁**行为**，不锁**写法** | 断言的对象是**导出函数的输入输出**，不是源码字面。`readFile(x.ts)` + regex 匹配实现文本的测试，会把纯重构报成回归。**实例（8-13）**：`pr239-dvh-status-numeric` 用 regex 匹配 `query-task.ts` 里 `statusStr === "SUCCESS" \|\| ...` 这串字面；把判定收口成 `isDvhSuccessStatus()` 后测试全红，而它要守的东西（数字/字符串双轨兼容）**一个字都没变**。后果不是多改几行断言，是**久了没人敢动代码** —— 每次重构都要先证明自己不是回归 |
| 16 | 守卫判据绑**结构关系**，不用**文件级共现** | 「文件里有 A + 文件里有 B」是共现；「B **就近作用于** A」才是关系。**8-13 一天三例共现误报**（措辞闸：句子提到目录名就要求带版本年 → 10 篇报 35 条全假；占位素材闸：body 含标记即报 → 差点误伤真产物；轮换守卫：文件有模板名列表 + 文件有 `Math.random` → 把合法的 zod 枚举报成第二处轮换点）。三次修法完全相同：**把判据从共现收窄到关系**（同句、同窗口、同表达式）。宽判据的代价不是多报几条，是**报了假的就没人再看真的** |
| 17 | 收口类改动：**守卫先行，收口在后** | 「我全仓找过了」的可靠性是第④级，扫描守卫是第②级。**8-13 实证**：模板轮换收口，人工找到 2 处并宣布完成，守卫上线当场抓出第三处（`routes/admin.ts` 的 `LAYOUT_POOL`，且 `listicle` 就在里面 —— 正是运营点「随机轮换」会拿到的那条路）。顺序固定为：**先写守卫（此时应当报红，红的条数就是待收口清单）→ 逐条收口 → 守卫转绿**。守卫一开始就绿，说明判据写窄了或写错了地方 |
| 18 | 差分实验判据必须差分 | 判据先拿基线跑一遍（基线过不了的判据测不出变化）；「持平」写单向只禁变差。**判据写坏了要认，事后改口径救「通过」与事后捡回好看维度是同一种病**。见上方 |
| 19 | DB 行为类改动必须真库跑冲突路径 | 约束/索引/ON CONFLICT/触发器：**tsc 证明类型、单测证明逻辑、守卫证明代码形状，三者都证明不了 Postgres 会怎么执行**。8-17 实例：`onConflictDoNothing` 缺部分索引谓词，三层全绿，真库当场 42P10。验收要把**冲突本身**制造出来，正常插入不算。见上方 |
| 20 | 度量口径不许混用 | 同一个量的不同度量差一个数量级时，混用 = 判据完全失效。**两个口径都对不代表可以互换** —— 混用不会报错，判据照常运行，只是答的是另一个问题。已三次：评估次数 vs 内容篇数、槽位学科 vs 刊学科、raw body vs 净正文（差 12.7 倍）。写阈值时同行注释写清「哪种度量 + 依据哪组实测分布」。见上方 |
| 21 | 不重做存量内容 | 存量**只改标记不重新生成**：改状态/metadata/摘 body 可以（零 LLM），批量重生成/重跑质检/重渲染**禁止**，除非老韩单独批准并说明为什么这批值得重花一次钱。排查同理：「再跑一次看看」前先查库里有没有现成样本。判断标准 —— 这次调用**产生新信息还是重复已有信息**。见上方 |

---

## LLM 接入点：baseURL 与 API Key **成对配置**（2026-07-26）

**一句话**：同一个 `deepseek-v4-pro` 模型，既能走 DeepSeek 官方账户，也能走阿里云百炼（Model Studio）——**百炼与官网同价、同模型、质量零变化**，区别只是扣谁的余额。切换靠**一个开关**：

| DEEPSEEK_VIA | baseURL | API Key 来源 | 扣费账户 |
|---|---|---|---|
| `official`（默认，现状） | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | DeepSeek 官方 |
| `bailian` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `QWEN_API_KEY` | 阿里云百炼 |

**铁律**：baseURL 与 key 必须成对，**只改一半 = 每次调用 401**；而 401 是客户端错误、**不触发 qwen 兜底**，系统会"看起来在跑"却整天产废稿（"抱歉，AI暂时无法响应"，7-24 事故原型）。所以：

- 切换**只设 `DEEPSEEK_VIA`**，别手改 `DEEPSEEK_BASE_URL`（那是逃生口，改错会被启动期自检拦）。
- 真相源 = `packages/server/src/services/ai/llm-endpoints.ts`（model-router / provider-factory 都从它取，**不得再在别处硬编码 baseURL**）。
- 启动期 `assertLlmEndpointConfig()` 做**纯静态**配对校验（不发任何网络/计费请求），生产遇 error 级配错直接 `exit(1)`。
- 联网确认接入点：`pnpm --filter @bossmate/server llm:check`（只调**不计费**的 `/models`；401=key 不配套，404=路径写成了原生 `/api/v1`）。
- **别把 `DASHSCOPE_BASE_URL` 当 LLM 的 baseURL**：那是百炼**原生**接口（`/api/v1`，给 qwen-tts / 声音克隆），OpenAI 兼容端点是 `/compatible-mode/v1`。
- 记账：`cost_ledger.note` 带 `billing=deepseek|bailian`（`services/ai/llm-endpoints.ts#getBillingAccount`），否则 provider 名都叫 deepseek，切百炼后账会串。

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

**SVG 生成**: `packages/server/src/services/crawler/journal-chart-generator.ts` 含 5 个 generator（generateBarChart / generateIFTrendChart / generatePubVolumeChart / generateCASPartitionTable / generateJCRPartitionTable），实时读 jsonb → SVG → **内联 `<svg>`** 嵌模板。

> ⚠️ **8-10 更正**：原记「`<img src="data:image/svg+xml;...">`」**已过时**。实测 883 篇正文里内联 `<svg>` 197 篇、`src="data:` 112 篇 —— 图表走的是内联 SVG。
> 这条区别很要紧：**微信公众号正文不支持 data URI**（只认 HTTP/HTTPS 图片地址），所以走 data URI 的图在微信侧根本渲染不出来。`journal-template.buildCoverHero` 曾因此把每一张数据卡生成后丢弃（8-10 已改为内联 SVG，见 P1-C）。

**前端 React 渲染**: 截至 PR #125，`JournalDetailPage` 用数据表格（无 SVG）显示这 4 个 jsonb 字段；shunshi-style template 后端预渲染 SVG。

**填充率**: 国际期刊 35 行 multi_source 中 32/35 = 91% 有 if_history。中文期刊 LetPub/OpenAlex 覆盖率有限，CNKI/万方接入在 backlog（task #104）。

**数据覆盖 backlog（挂 task #104 旁）**:
- 🔴 **CNKI/万方接入（task #104）— 已从"覆盖率 backlog"提升为"国内内容线阻塞项"（2026-07-09）**。根因数据：**国内 verified 期刊池仅 427/3,707 = 12%**（多数国内学科 verified 近零：medicine 17/438、综合性人文社科 0/122、中国政治 0/43）。后果：daily-cron 国内槽位 verified 两层频繁枯竭 → 回退 legacy_unknown 生成内容；客服查国内刊大量落"未核实/转顾问"。**CNKI/万方接入是治本**（把国内刊多源核验、conf 提到 70+、升级 multi_source_verified）；**PR B 的 needs_review 标记（回退未核实源→人工复核）+ PR A 客服护栏是止血**，不解决覆盖率本身。国内内容质量要真起来，必须补中文权威源。
  - ✅ **task#104 阶段2 万方医学网回填（一次性完成，2026-07-17）**。万方搜索页可自动解析 perioId + 中信所核心影响因子（复合IF），实测桌面真实网络可抓。**结论数字**：医学国内刊候选池 ~581 本，处理 580（1 本 fetch 失败=`黑龙江畜牧兽医`，兽医非医学，真无果）；**perioId 命中写入 460 本、复合IF（provenance=wanfang）447 本、无果标记 120 本，全部 name_exact（0 fuzzy，无张冠李戴）**。**只加法**：只写 `metadata.wanfang.perioId` + `composite_impact_factor`（仅原 NULL）+ `fieldProvenance.compositeImpactFactor=wanfang` + 无果 `metadata.wanfang.searchedNoMatch`；`impact_factor`/`confidence`/`data_source` 零改动（终审误碰=0、无cif却打provenance=0）。无果全是**电子版/网络版/大学学报医学版/期刊改名（华南国防医学→联勤军事医学）/DB 刊名 typo（影响→影像、前言→前沿）/非医学正则误召（兽医·农药·地质）**——规律性 miss，非新问题。**执行约束**：阿里云服务器数据中心 IP 被万方封（ECONNREFUSED），**必须桌面真实网络跑**；且 SSH 隧道会抖动 + sshd 会限连——**解耦设计绕开**：桌面抓万方→本地 `results.jsonl` 逐本落盘（零 DB/SSH 依赖，崩了可 resume）→ 最后 server 端 psql 一次性 jsonb 合并落库（免隧道）。**非常态化**（不挂 cron）。**非医学国内刊 ~2556 搁置（D 方案），国内到 CSCD/北大核心为止；CNKI 阶段3 暂不接。**
  - 🟡 **backlog-A：orchestrator 链急切实例化 Redis worker/Queue（阶段2 副产）** — `services/batch/queue.ts:8` + `services/task/queue.ts:32/43/53` 的 `export const xQueue = new Queue(...)` 是**模块级急切实例化**（import 即连 Redis）。任何 import orchestrator 的独立脚本会被此拖住卡死（阶段2 committed `enrich-wanfang-batch.ts` 跑 orchestrator 即卡在"Redis 连接成功"后不处理任何刊）。**这是 memory `no-eager-module-instantiation` 反模式的活实例** → 应改懒实例化（`getQueue()` 工厂/懒代理）。回填因此改用**不 import orchestrator 的聚焦独立脚本**（纯 pg + fetch）。
  - 🟡 **backlog-B：万方 detail URL 格式过时** — `services/journal-enricher/fetchers/wanfang-fetcher.ts:109` 仍拼 `/Periodical/Detail/${perioId}`，**现网真实格式是 `/Periodical/${perioId}`（短码，无 /Detail/）**。resolver（`wanfang-perioid-resolver.ts`）已于 7-16 校准改对，但 orchestrator 用的 detail fetcher **未改** → orchestrator 万方 detail 抓取路径已失效。**修对或标注勿用**。committed `enrich-wanfang-batch.ts`（跑 orchestrator+急切 worker 会卡死）本次未用、已被聚焦脚本取代——别当能跑的脚本留仓库。
  - 🟡 **backlog-C：enrichment 供数 vs DB 校验 数据源不一致（2026-07-21 发现，碰数据链路核心，需专门一轮）** — 生成时 `article-skill.ts` 调 `ensureJournalEnriched`（`crawler/springer-journal-fetcher.ts:232`）**实时从 LetPub/springer 抓 IF/分区喂给 LLM，但抓到的值不回写 `journals` 表**（DB 仍为空）。后果：事后所有以 DB 为准的校验都把"enrichment 补了真数据、LLM 据实写"的内容误判为编造 —— ①7-20 部署的评分器反编造压分（`quality-check-v2` 调 `findBodyFabrication`）②标题编造校验（`checkTitleDataConsistency`）③正文编造检测。**受影响面 = 骑墙刊**：带 `sci-core` 标签、`journals` 表 IF/分区全空、但 LetPub 有真实数据的刊（实例：地理科学进展，DB 全 null，enrichment 抓到 IF 4.3/中科院1-2区，标题正文据实写"1区/IF4.3"却被三道校验当编造）。**当时的"改动3 骑墙刊编2区"结论是误判**——不是编造，是有据但未回写。**根治方向（二选一）**：① enrichment 抓到的 IF/分区**回写 `journals` 表**（让 DB 成为唯一真相源，校验就对了；注意 provenance 记 letpub，遵守 OpenAlex 源约束）② 或让三道校验也走 enrichment 后的 `journal` 对象而非 DB 快照。7-21 曾试"收紧国内刊判定排除 sci-core + 全局无据禁写红线"（commit `6577b9a`），对纯国内刊无害但对骑墙刊反而更糟（把有数据的刊当无数据），已 `git revert`（`11cb31d`）退回改动3 主体 `c930b00`。**纯国内刊（不含 sci-core，2379 本里绝大多数）的改动3 完全有效，此 backlog 只影响少数骑墙刊。**
    > ✅ **2026-07-25 已按方向①收口**：新增 `persistTrustedJournalFacts()`（`crawler/springer-journal-fetcher.ts`），`article-skill` 的 `ensureJournalEnriched` 新增 `{ writeBackJournalId }` 选项，把 **scrapling/LetPub 可信源**抓到的 `impactFactor / partition / casPartition / acceptanceRate / reviewCycle` **同步**回写 journals 表。三条铁律：**只收可信源**（AI 兜底那层的 `casPartitionNew` 等一律拦掉——它唯一来源是 `enrichJournalWithAI`，写进去等于给幻觉发权威背书）、**只填空绝不覆盖**（天然幂等，人工/多源核实值动不了）、**打 `field_provenance.<字段> = "letpub_inline_enrich"` 但不动 `dataSource`/`confidence`**（单源回写无权把 `multi_source_verified` 降级）。同步而非入队是必需的：本轮生成后续的六维评分与发布闸都现查 DB。回写面**精确等于校验器读的字段集**——病根是供数源与校验源不一致，对齐这两个集合即可，多写一列多一分污染。顺手拆了老 `ensureJournalEnriched` 里"AI 猜的 casPartition 直写信任列"的哑弹。**存量骑墙刊**用 `npx tsx src/scripts/journals-reenrich.ts --fence-sitters --dry-run` 手动回填（走 orchestrator 正规富化路径）。单测 `backlog-c-trusted-writeback.test.ts` 13 例锁死三条铁律。
    > 🔴 **2026-07-25 当天试启用即出事故 → 回写已改为"代码在但默认不启用"**。上线试跑发现**上游 LetPub 页面已改版**，`scripts/journal_scraper.py` 的选择器全部错位：抓回 `impactFactor=2026`（页面上的**年份**）、`name="按研究方向查看:"`（**侧边导航文案**）。而回写会把这些假值**永久钉进 `journals` 表**——一旦入库，三道防编造闸（`findBodyFabrication` / `checkTitleDataConsistency` / `quality-check-v2`）**全部失效**，因为它们都以 DB 为唯一真相源，DB 与喂给 LLM 的提示词"**一致地错**"，校验器反过来给假数据背书。已产出一篇《2026 逆天影响因子》。污染已回滚，scrapling 已卸载。**教训（比这条 backlog 本身更值钱）：回写把"一次抓取失败"升级成了"永久数据污染 + 校验体系失效"。抓取失败是常态（上游随时改版），所以写入侧必须有一道不依赖上游/不依赖 LLM/不联网的确定性闸门；而"多道校验闸"只要都读同一份 DB，就不是三道闸，是一道闸抄了三遍。****本轮加固**：① 新增纯函数 `validateTrustedFacts()`（`crawler/trusted-facts-validator.ts`）——IF 上界 300（一刀切死 1900-2100 年份区间）+ 年份型整数探针（真 IF 带小数，`2.026` 不误伤）、分区必须 Q1-Q4/1-4区、中科院分区必须 `[学科]N区[TOP]`、录用率 0-1 比值、审稿周期折算 0-1000 天、刊名导航文案探针（`sourceName`，只探测不入库）；任一不合理 → **整条拒写**（绝不部分写入）+ `logger.error` + 落 `ops_incidents`（`kind=enrich_writeback_rejected`）进次日简报；**多字段同时异常或命中年份/导航文案 → 判定"解析漂移"，告警升到 error**。② 开关 `ENRICH_WRITEBACK_ENABLED` **默认 false**（`isWriteBackEnabled()`，与 `ENRICH_SKIP_LETPUB` 同族直读 env）；**校验跑在开关之前**（影子模式）——关着也照样校验并告警，这样"上游到底修好没有"由日常运行自动探出来，而不是等哪天有人壮着胆子打开开关才发现还是坏的。③ 老 `ensureJournalEnriched` 缓存路径（直接覆盖、连"只填空"都没有的第二扇门）同样过护栏。**要真正启用回写还差什么**：(a) 重写 `journal_scraper.py` 的 LetPub 选择器并用真实期刊逐字段验证（IF/分区/中科院分区/录用率/审稿周期/刊名）；(b) 跑 `trusted-facts-guardrail.test.ts` 确认护栏拦得住；(c) 先只开一天，观察 `ops_incidents` 里 `enrich_writeback_rejected` 是否为 0，再常开。单测：`trusted-facts-guardrail.test.ts`（23 例，用事故真实脏值）+ `backlog-c-trusted-writeback.test.ts`（24 例，含护栏与开关）。
  - 🟢 **共享期刊池的 tenant 口径（2026-07-25 收口，同一个病犯了四次）** — 线上 8743 本期刊的 `tenant_id` 是 **NULL**（全局共享参考数据，只有租户自建刊才带 tenant_id）。SQL 里 `NULL = 'uuid'` 求值为 NULL（既不真也不假），所以 `eq(journals.tenantId, tenantId)` 会把**整个共享池排除**，端点对任何租户都返 0 条。发病四处并已全部修为 `or(isNull(tenantId), eq(tenantId, current))`：`POST /journals/match`（小程序选刊恒空，commit `7eb5e77`）、`GET /journals`（列表页恒空）、`GET /journals/meta/disciplines`（学科下拉恒空）、`GET /journals/:id/warning-check`（详情页能开、点预警检查却 404）。**规则：读放宽（共享池 + 自有刊），写严格（seed / enrich / enrich-all 只认自己的刊；`PATCH /journals/:id` 是显式授权的例外——owner/admin 角色闸在前，为的是改重点期刊）。**共享池的富化走 `pnpm journals:reenrich` 脚本，不走租户 API。回归锁：`journals-tenant-shared-pool.test.ts`（14 例，含写路径不许放宽）。
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

**⚠️ deploy 前服务器工作区必须干净（否则 git 操作 abort，整条部署失败）**：
- deploy:smart 走 `git fetch + merge/reset`，服务器工作区有**已跟踪文件的本地改动**时 git 会 abort（报 `Aborting`/`ELIFECYCLE`），部署起不来。`.env.bak-*` 等 untracked 不影响，只有 `M`（modified tracked）会卡。
- **两个已知脏源，别再踩**：① **绝不 `scp` 单文件到服务器**改代码——会弄脏工作区，一律走 git commit+deploy（2026-07-21 教训，scp daily-cron.ts 卡了 deploy）。② SVG 图表快照曾每跑一次 vitest 就被 `svg-charts.test.ts` 的 writeFileSync 重写、产生 diff 卡 deploy（abort 两次）——已于 2026-07-22 `git rm --cached` + gitignore 根治（`snapshots/*.svg` 不再跟踪），若再见类似"测试输出产物被跟踪导致每跑必脏"，同样处理：确认它是**测试输出而非输入 fixture**（无人 readFileSync 它）后 untrack + gitignore，别用"deploy 前 checkout 还原"治标。
- 万一 deploy 被 abort：`ssh ... 'cd /home/projects/bossmate && git status --short'` 找到 `M` 文件，确认是快照/被 scp 弄脏的代码后 `git checkout -- <file>` 还原，再重跑 deploy:smart。

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
