# 前端交互审计清单(2026-06-10)

> 范围: apps/web/src 全部 84+ 个前端文件,逐条在代码里核实过(每条附 文件:行号 证据)。
> **本次只是审计,一行代码没改。** 圈选确认后再动手。

## 怎么用这份清单

老韩你只需要做一件事: **每条最后都有一个【决策点】,圈"保持现状"还是"同意合并/下线"。**

- 圈完哪条,我们做哪条;没圈的一律不动。
- 第一、二、三、四章是"用户能感觉到的乱",需要你拍板,因为会改变操作入口。
- 第五章是纯技术整理,不改变任何按钮、任何操作习惯,建议直接授权做。
- 每条都标了工作量(人天)和风险,方便你权衡。

一句话总结审计结论:
**系统功能是全的,但同一件事(生成内容、选账号发布)在 5-7 个不同地方各做了一套,长得还都不一样;另有 7 个页面做完了却没有入口,用户根本进不去。**

---

## 一、重复功能入口

### 1.1 "生成内容"入口有 7 条平行链路(初审说 4 个,实际更多)

**现状(每条都在代码里核实过):**

| # | 入口 | 在哪 | 证据 |
|---|------|------|------|
| 1 | 内容工坊顶栏 3 个按钮: [+生成图文][🎬生成视频][📚多刊盘点] | 侧边栏"内容工坊" /workbench | `components/workbench/WorkbenchTopBar.tsx:26-42`,弹 3 个各自独立的 modal: `ManualGenerateModal.tsx`(390行)/`ManualGenerateVideoModal.tsx`(249行)/`RoundupGenerateModal.tsx`(271行) |
| 2 | 内容管理页"⚙️高级模式"折叠区 4 个按钮: AI推荐 / 批量CSV / 选题创作 / AI对话 | 侧边栏"内容管理" /content | `pages/ContentPage.tsx:347-356` |
| 3 | 8 步选题创作流水线(关键词→聚类→标题→找刊→模板→创作→核对→发布) | /workflow/article,只能从上面第 2 条的折叠区进 | `pages/WorkflowPage.tsx`(全文 1928 行,自带生成 `:475`、校验 `:510`、发布 `:346`) |
| 4 | AI 对话生成(skill=article/video,带模板选择弹窗) | /chat | `pages/ChatPage.tsx:228-252` |
| 5 | 全局右下角聊天悬浮球(又一套独立迷你聊天) | 登录后所有页面 | `App.tsx:53-54` + `components/chat-drawer/ChatPanel.tsx`(注释自述"复用 ChatPage 的 API"但 UI 全新写) |
| 6 | 关键词中心"一键生成文章"按钮 | /keywords(注意: 这个页面没有任何入口,见第三章) | `pages/KeywordsPage.tsx:194-205` |
| 7 | 图片转视频三步向导 | /video/create,首页"🎬视频"按钮进 | `pages/VideoCreationPage.tsx`(384行,合成调用 `:121`);而 WorkflowPage 里**又**调了一遍同一个视频合成接口 `pages/WorkflowPage.tsx:1250` |

另外"生成数字人视频"按钮散落在 ≥3 处: 工坊右侧卡(`DistributionCard.tsx:108-114`)、内容详情页(`ContentDetailPage.tsx:289`)、推荐后门页(`RecommendationFeedPage.tsx:57`)。

**初审纠错:** 初审说"4 个入口、各有自己的生成 modal"——方向对,数字保守了。ManualGenerateModal/ManualGenerateVideoModal 其实只在内容工坊一处使用(没有被到处复制),真正的问题不是 modal 重复,而是**七条互不知晓的生成链路**:工坊批量生成、8 步工作流、聊天生成、关键词生成、图转视频,各自调不同后端接口、各自有进度提示、生成结果都进同一个内容库。

**用户视角为什么乱:** 员工问"我要写一篇文章,从哪进?"——答案有 7 个,且每个界面长得完全不一样、能选的参数也不一样(有的能选学科,有的能选模板,有的能选期刊,没有一个全能)。新员工培训成本高,老员工只会用自己摸到的那一条。

**合并方案:** 保留 2 条主链路——
1. **内容工坊** = 唯一的"批量/常规生产"入口(现有 3 按钮保留,把"AI推荐""批量CSV"两个 modal 也搬进工坊顶栏);
2. **AI 对话** = 唯一的"自由创作"入口(ChatPage 与悬浮球抽屉二选一,建议留悬浮球、/chat 页面保留但不再独立宣传)。
8 步工作流(1928 行)降级为"专家模式",入口收进工坊;关键词页的一键生成按钮跳转到工坊预填参数,而不是自己再发请求。

**影响范围:** ContentPage 高级模式区、WorkbenchTopBar、KeywordsPage 按钮、WorkflowPage 入口位置。后端接口全部不动。

**决策点 1.1:** 【 保持现状 / 同意收敛为"工坊+对话"两条主链路 】

### 1.2 视频生成本身也有 3 条链路

图转视频向导(/video/create)、工坊"🎬生成视频"modal(从文章或主题生成数字人视频)、详情页/推荐卡上的"生成数字人视频"按钮。三者后端不同(`/video/compose` vs `/admin/generate-video` vs `/articles/:id/generate-dvh-video`),功能确有差异,但对用户都叫"生成视频"。

**合并方案:** 不合并后端,只做**一个统一的"生成视频"弹窗**,里面三个选项卡(图片转视频/文章转数字人/主题直生),三处入口都弹同一个窗。

**决策点 1.2:** 【 保持现状 / 同意统一视频生成弹窗 】

---

## 二、重复组件

### 2.1 "选账号发布"界面写了 5 遍(初审说 3 遍,实测 5 遍 + 1 个变体)

同一个东西——"按平台分组列出账号、打勾、点发布"——在以下 5 处各自实现:

| # | 位置 | 证据 | 样子 |
|---|------|------|------|
| 1 | 工坊右侧单篇发布卡 | `components/workbench/DistributionCard.tsx:41-81` | 平台分组+勾选+已验证✓ |
| 2 | 工坊批量发布卡 | `components/workbench/BulkDistributeCard.tsx:36-69`(注释自己承认"同 DistributionCard 模式") | 几乎一样,又写一遍 |
| 3 | 一键生成 modal 第 3 段 | `components/workbench/ManualGenerateModal.tsx:88-99, 314-340` | 不分组的扁平列表,样式不同 |
| 4 | 内容详情页发布面板 | `pages/ContentDetailPage.tsx:903-1000`(平台图标/名字映射直接写在 JSX 里 `:911-928`) | 带"全选本平台",样式又不同 |
| 5 | 工作流第 8 步发布 | `pages/WorkflowPage.tsx:1791-1845`(又一份 platformCfg + 组勾选) | 卡片式,样式又不同 |

变体 6: 盘点生成 modal 用的是单选下拉框(`RoundupGenerateModal.tsx:166-177`)。

**初审纠错:** 初审说的 3 处里"ManualGenerateVideoModal"不对——它根本没有账号选择(核实过全文,只有主播模板选择);但初审漏了更大的两处: ContentDetailPage 发布面板和 WorkflowPage 第 8 步。重复代码量约 280 行(不止初审估的 150 行)。

**用户视角为什么乱:** 同样是"选账号发布",5 个地方默认勾选规则不一样(有的默认勾已验证账号,有的全不勾)、有的能按平台全选有的不能、"已验证"标记长相不一样。员工在 A 处学会的操作到 B 处对不上。

**合并方案:** 抽一个 `<AccountSelector>` 公共组件(分组+勾选+全选+已验证标记,带"单选模式"开关),5 处全部替换。视觉上统一成工坊 DistributionCard 的样子(它最新最完整)。

**影响范围:** 上述 5 个文件。操作逻辑统一为"默认勾选已验证账号+支持平台全选",其中详情页和工作流的用户会感觉到默认勾选行为变化(变得更智能)。

**决策点 2.1:** 【 保持现状 / 同意抽统一账号选择组件 】

### 2.2 平台中文名(公众号/抖音/小红书…)写了 8 遍

`PLATFORM_LABEL` 之类的"英文代号→中文名"对照表,在 8 个文件里各写一份:
`DistributionCard.tsx:32` / `BulkDistributeCard.tsx:9` / `RiskAuditModal.tsx:33` / `dashboard/RecommendationPanel.tsx:19` / `dashboard/PreviewCardRow.tsx:27`(这是个死文件,见 2.4) / `AccountsPage.tsx:32`(带图标和颜色) / `WorkflowPage.tsx:1791-1797`(带图标) / `ContentDetailPage.tsx:911-928 与 :1511`(一页里写了两遍)。

**初审纠错:** 初审把 `KeywordsPage.tsx:61` 的 PLATFORM_LABELS 也算进来——那个是"爬虫数据源"(百度学术/PubMed)的标签,不是发布平台,不算重复。

**风险实例:** 8 份表内容已经不一致——RiskAuditModal 那份少了百家号/头条/知乎;将来上新平台(比如 B 站)要改 8 个地方,漏一个就出现界面上显示英文 "bilibili" 的尴尬。

**合并方案:** 全部收进现成的 `utils/i18n.ts`(项目本来就有这个集中翻译文件,见 2.3),加一个 `platformLabel` 导出,8 处引用。纯替换,界面零变化。

**决策点 2.2:** 【 保持现状 / 同意收口(界面零变化,建议直接做) 】

### 2.3 内容状态标签(草稿/已发布…)各写一份,且已经互相矛盾 ⚠️

**初审说"StatusBadge 类多处各写一份"——核实结果: 项目根本没有 StatusBadge 组件**,是各页面手写 STATUS_LABELS + STATUS_COLORS:

- `pages/ContentPage.tsx:39-55` — 用了集中文件 i18n.ts 的新 6 状态(草稿/生成中/失败/已生成/已发布/归档),自己补色;
- `pages/ContentDetailPage.tsx:97-110` — **还是旧 4 状态**(草稿/审核中/已通过/已发布);
- `pages/DataDashboardPage.tsx:251-253` — 又一份旧 4 状态;
- `pages/AccountsPage.tsx:69-81` — 账号状态(已验证/过期),这个是另一个领域,不算重复。

**实际后果(不是理论风险):** 同一篇文章,列表页显示"已生成"(绿色),点进详情页因为旧表里没有 generated 这个词,**直接显示英文原码 "generated"**(`ContentDetailPage.tsx:733` 的兜底逻辑 `STATUS_LABELS[content.status] || content.status`)。"已发布"的颜色列表页是天蓝(sky)、详情页是宝蓝(blue)。

**合并方案:** 做一个 `<StatusBadge status={...}/>` 小组件,词表/颜色只认 `utils/i18n.ts`(它已经有 articleStatusLabel 全集 `utils/i18n.ts:21-28`),3 处替换。

**决策点 2.3:** 【 保持现状 / 同意统一状态标签(修掉详情页显示英文的 bug,建议直接做) 】

### 2.4 死组件 4 个 + 1 个坏链接

全代码搜索确认零引用: `dashboard/HeroSection.tsx`、`dashboard/Pipeline24hStrip.tsx`、`dashboard/PreviewCardRow.tsx`、`SmartInput.tsx`(DashboardPage.tsx:4-5 的注释自己承认"老组件保留,5-23+ 单独 PR 清理",一直没清)。其中 SmartInput.tsx:9 还写着跳转到 `/data-dashboard` ——**这个路由不存在**(真实路由是 /dashboard),即使哪天复用也是个坏链接。

**决策点 2.4:** 【 保留备用 / 同意删除(用户完全无感知,建议直接做) 】

### 2.5 页面顶部导航条复制了 12 遍,导航体系一国两制

全站有两套导航: 新版左侧栏(Sidebar,只包 7 个路由,`App.tsx` 中 MainLayout 包裹的那些)和旧版页内顶栏。**12 个页面各自手写了一遍几乎相同的顶栏**(grep `<nav className="bg-white border-b` 命中: AccountsPage:366 / AdminJournalsAuditPage:158 / BatchProgressPage:117 / ContentDetailPage:715 / ContentPage:264 / KeywordsPage:440 / KnowledgePage:134 / RecommendationFeedPage:69 / SalesPage:277 / TemplatesPage:80 / VideoCreationPage:180 / WorkflowPage:605)。

**用户视角的直接后果:**
- 点侧边栏"内容管理"进 /content → **侧边栏消失了**(ContentPage 不在 MainLayout 里,`App.tsx:148-155`),想去别的页只能先点 logo 回首页;"账号""设置"同理。
- 反过来 /content/:id 详情页**两层导航都有**(外面套了 MainLayout `App.tsx:160-163`,里面又画了一条顶栏 `ContentDetailPage.tsx:715`)。

**合并方案:** 把所有登录后页面统一放进 MainLayout(侧边栏),删除 12 份手写顶栏(返回按钮、退出按钮迁入 Sidebar/页面标题区)。

**影响范围:** 12 个页面的头部视觉变化,导航习惯统一为"永远有侧边栏"。这是本清单里用户感知最明显的一项,但也是治"乱"最见效的一项。

**决策点 2.5:** 【 保持现状 / 同意全站统一侧边栏导航 】

---

## 三、孤儿/重叠页面

逐条验证过"是否有任何页面跳转得到它"(不只看菜单)。**初审说 8 个孤儿,核实结果: 真孤儿 4 个 + 链式孤儿 2 个 + 有意后门 1 个;初审列的 /chat 不是孤儿(有 3 处入口),已剔除。**

### 3.1 真孤儿(全代码无任何链接指向,只能手敲网址)

| 页面 | 规模 | 证据 | 建议 |
|------|------|------|------|
| /keywords 关键词中心 | **1162 行**,有爬词/聚类/趋势/词典/一键生成全套功能 | 路由在 `App.tsx:140-147`,全代码搜索无一处 Link/navigate 指向 | 功能不弱,值得给入口(放工坊顶栏"选题"按钮),或确认弃用 |
| /templates 模板管理 | 172 行 | 路由 `App.tsx:177-184`,无入口 | admin 工具,可挂到设置页 |
| /admin/journals 期刊管理 | 655 行 | 路由 `App.tsx:266-273`,无入口(侧边栏只有"期刊审计"/admin/journals/audit) | 挂到期刊审计页顶部 |
| /sales 旧销售页 | 531 行,且被 VITE_SALES_ENABLED 开关包着(`App.tsx:236-245`) | 无入口;功能与侧边栏"销售雷达"(/sales-radar)重叠 | 确认被销售雷达取代后下线 |

### 3.2 链式孤儿(入口只存在于另一个孤儿里)

| 页面 | 证据 |
|------|------|
| /dashboard 数据报告(DataDashboardPage,345 行) | 唯一入口在孤儿页 TemplatesPage:82;另一个入口在死组件 SmartInput.tsx:9 且路径还写错(/data-dashboard) |
| /knowledge 知识库(KnowledgePage,**892 行**,含搜索/审计/冷启动) | 唯一入口在上面的 /dashboard(`DataDashboardPage.tsx:184`) |

### 3.3 有意后门(不算问题,记录在案)

/recommend-feed — `App.tsx:99` 注释明确写"留后门(调试/未来 role-based 路由复用),不暴露 nav"。保持即可。

### 3.4 重叠页面(同一数据三个展示面)

"今日推荐 10 篇"同一个接口(GET /content/recommendations)在 3 个页面各画了一遍: 工坊"推荐"tab(`ContentWorkbenchPage.tsx:6`)、内容管理页"📅今日推荐"tab(`ContentPage.tsx:360-369`)、后门页 /recommend-feed。另外首页(/)叫 DashboardPage、数据报告页(/dashboard)叫 DataDashboardPage,连开发者自己都容易搞混。

**合并方案(整章):**
1. 6 个孤儿逐一拍板: 给入口 or 下线(代码先留,路由注释掉);
2. "今日推荐"只保留工坊一处,内容管理页的推荐 tab 改成跳转工坊;
3. /sales 确认下线。

**决策点 3:** 请逐行圈选——
- /keywords: 【 给入口 / 下线 】
- /templates: 【 给入口(设置页) / 下线 】
- /admin/journals: 【 给入口(审计页) / 下线 】
- /sales: 【 保留 / 下线 】
- /dashboard + /knowledge: 【 给正式入口(侧边栏) / 下线 】
- 推荐 feed 三处收敛到工坊: 【 保持现状 / 同意 】

---

## 四、提示与状态不一致

**初审属实,且查清了根源。** 项目其实有一套挺好的统一提示系统(`stores/toastStore.ts` + `components/Toast.tsx`,全局挂载于 `App.tsx:52`),API 层失败还会自动弹红色提示(`utils/api.ts:84,105`)。但是:

1. **浏览器原生 alert() 还有 5 处**(样子是系统弹窗,和全站风格完全两样): `KeywordsPage.tsx:200,202`(一键生成成功/失败居然用 alert 弹一大段技术信息含 batchId)、`ContentPage.tsx:527`、`BatchProgressPage.tsx:84,103`。
2. **原生 confirm() 9 处**(删除/取消确认,无法统一样式): JournalsAdminPage:406、AccountsPage:329、KeywordsPage:404、KnowledgePage:309、ContentDetailPage:683、ManualGenerateModal:203、ManualGenerateVideoModal:140 等。
3. **成功提示三种派系:** toast(工坊/详情页等 10 个文件在用)、页面内嵌横幅(WorkflowPage/RegisterPage/VideoCreationPage 自绘 setError/setMsg)、alert(上述)。同一个"发布成功",在工坊是右上角绿条,在工作流是页面里一块绿底,在关键词页是系统弹窗。
4. **状态标签矛盾** 已在 2.3 详述(列表页中文/详情页英文)。

**合并方案:** ① 5 处 alert 全部换成 toast(顺手把 KeywordsPage 那段技术味十足的文案改成人话);② confirm 暂时保留原生(做统一确认弹窗是锦上添花,可放低优先级);③ 成功提示统一 toast。

**影响范围:** 提示出现的位置和样子变统一,操作流程不变。

**决策点 4:** 【 保持现状 / 同意统一为 toast(建议直接做) 】

---

## 五、技术层(纯技术整理,不改变任何操作习惯,建议直接做)

### 5.1 API 调用层 — 结论比预期好 ✅

**初审的担心不成立。** 全站有统一 client(`utils/api.ts`,170 行): 自动带登录凭证、统一错误提示、登录过期统一处理(`api.ts:43-54`)、支持取消请求。几乎所有页面都在用。

仅 4 处绕开手写 fetch(各自手拼 Authorization 头):
- `components/BatchUploadModal.tsx:85` 和 `pages/VideoCreationPage.tsx:77` — 文件上传(FormData,统一 client 没提供上传方法,情有可原);
- `pages/BatchProgressPage.tsx:93` — 报告下载;
- `pages/TryPage.tsx:21` — 公开体验页(无需登录,合理)。

**整理方案:** 给 api.ts 加一个 `api.upload()`,收编前 3 处。工作量 0.5 天。

### 5.2 其他纯技术项汇总

| 项 | 出处 | 工作量 |
|----|------|--------|
| 删 4 个死组件 + SmartInput 坏链接(2.4) | 见 2.4 | 0.5 天 |
| 平台名收口 i18n.ts(2.2) | 8 个文件 | 0.5 天 |
| StatusBadge 统一 + 修详情页英文 bug(2.3) | 3 个文件 | 0.5 天 |
| alert → toast(四) | 5 处 | 0.5 天 |
| api.upload 收编(5.1) | 3 处 | 0.5 天 |

**决策点 5:** 【 同意以上 5 项打包直接做(合计约 2.5 人天,界面零感知或仅修 bug) / 再等等 】

---

## 六、建议的实施顺序

### 高优先级(先做,见效快/修 bug,合计约 3 人天)
1. **第五章打包**(2.5 天)— 零风险,顺手修掉"详情页状态显示英文"的真 bug;
2. **孤儿页面拍板**(0.5 天)— 只动路由和菜单,圈完当天能上。

### 中优先级(改善一致性,合计约 5-6 人天)
3. **统一账号选择组件 2.1**(2 天)— 发布是高频操作,统一后培训成本立降;
4. **全站统一侧边栏 2.5**(2-3 天)— 用户感知最明显,建议放一个独立版本发,发完收集反馈;
5. **统一视频生成弹窗 1.2**(1 天)。

### 低优先级(动结构,需要想清楚再动,合计约 5-8 人天)
6. **生成入口收敛 1.1**(3-5 天)— 涉及 WorkflowPage(1928 行)降级和 ChatPage/抽屉二选一,牵动最多,建议等上面都稳了再做;
7. **推荐 feed 三处收敛 3.4**(1 天)— 依赖 6 的方向确定;
8. 原生 confirm 换统一确认弹窗(1 天,纯体验打磨)。

> 备注: 以上全部不动后端接口、不动数据库。所有"下线"均为注释路由保留代码,可随时恢复。

---

*审计方法: 路由表(App.tsx)、菜单(Sidebar.tsx)与全量跳转(Link/navigate)交叉比对;重复实现以 grep 全文检索核实;每条结论均附可点开复查的 文件:行号。初审 6 条结论: 2 条属实但低估(入口数/重复份数)、2 条属实(孤儿页/提示不一致,细节有出入已纠正)、1 条表述有误(无 StatusBadge 组件,实为散写的状态映射表)、1 条担心不成立(API 层已统一)。*

---

# 执行记录(2026-06-10 深夜, 老韩全部圈选"同意"后一次性实施)

| 决策点 | 内容 | 状态 | 提交 |
|---|---|---|---|
| 2.2 | 平台名 8 份→i18n.ts PLATFORM_META 一份(RiskAuditModal 缺平台真bug已修) | ✅ | e2e3d7d |
| 2.3 | StatusBadge 统一, 详情页英文原码真bug已修, 已发布颜色统一 | ✅ | e2e3d7d |
| 2.4 | 4 死组件已删(含 SmartInput 坏链接) | ✅ | e2e3d7d |
| 四 | 5 处 alert→toast(KeywordsPage 技术文案改人话); confirm 9 处按计划保留 | ✅ | e2e3d7d |
| 5 | api.upload/download 收编 3 处手写 fetch | ✅ | e2e3d7d |
| 3 | 6 孤儿页全部下线(路由注释代码保留): /keywords /dashboard /templates /knowledge /sales /admin/journals; 可达页活链接 0 处需清理 | ✅ | e7ef730 |
| 3.4 | 今日推荐收敛工坊, ContentPage 推荐 tab→引导块跳工坊 | ✅ | e7ef730 |
| 2.1 | AccountSelector 统一 5 处(~280行重复删除); 详情页/工作流默认勾选→勾已验证 | ✅ | db210da |
| 1.2 | UnifiedVideoModal 三选项卡, 4 入口共用; ManualGenerateVideoModal 删除 | ✅ | db210da |
| 2.5 | 全站统一侧边栏: 9 条路由纳入 MainLayout(含顺手 /settings、/journals/:id), 8 页手写顶栏删除, 退出由 Sidebar 承接 | ✅ | 4ea54aa |
| 1.1 | 链路收敛"工坊+对话": ContentPage 高级模式折叠区删除, AI推荐/批量CSV 搬进工坊顶栏, 专家模式链接→/workflow/article; 悬浮球+/chat 维持 | ✅ | 4ea54aa |

未做(本来就排除或低优先级): RoundupGenerateModal 单选下拉(2.1 变体)、原生 confirm 统一弹窗(六.8)、WorkflowPage 1928 行本体拆分(属 Phase 4 代码债)。
全部验证: apps/web 与 packages/server tsc --noEmit 零错误。**后端接口与提交数据结构零改动。**
人工验收建议(部署后过一遍): ①工坊顶栏 6 个入口各点一遍 ②详情页发布(默认勾选已验证+平台全选) ③任一页面确认侧边栏常驻+退出按钮在侧边栏底部 ④内容列表/详情状态标签中文一致。
