# 短视频渠道方案：抖音 + 视频号（2026-06-10 拍板）

## 0. 一页结论

| 渠道 | 长久形态 | 现状/过渡 | 保底 |
|---|---|---|---|
| **抖音** | **A 轨：官方开放平台 API**（`video.create.bind` 服务端代发，客户扫码授权一次，无需装任何东西）。代码已落地（PR-D1 `3b0f039`），等能力审批 | 半自动发布助手 | B 轨本地 Agent |
| **视频号** | **B 轨：本地发布 Agent**（官方无发布 API，这是合规天花板） | 服务器端扫码浏览器自动化（已跑通，继续用） | —（B 轨即终态） |

最终形态大概率混合：抖音官方 API 直发 + 视频号本地 Agent。Agent 按多渠道设计,抖音申请被拒时挂进来即可,投入不浪费。

**B 轨启动触发条件（满足其一即开工）**：①视频号服务器端登录风控收紧 ②第一个企业客户要求绑定自己的账号 ③抖音 `video.create.bind` 申请被拒。

## 1. 背景与依据

### 抖音
浏览器自动化（机房 IP + puppeteer）被风控定性为不可信环境：扫码可过但强制二次验证，短信不下发、远程刷脸不可达（PR-S27~S31 打满补丁后定性为硬墙）。**放弃机房环境对抗。**

6-10 核实官方文档的关键纠偏：之前记录的"注册资本≥50万、仅创作工具类、营销内容不准入"门槛**只针对「发布能力」（SDK/H5 投稿，半自动）**。真正需要的 `video.create.bind`（"代替用户发布内容到抖音"，服务端直发）是另一个能力，《能力申请及使用规范》明文允许用于"企业内部或**签约的账号**的内容管理"——BossMate B2B 场景合规。能力实验室申请门槛未公开，提交才知道。

⚠️ 持续合规红线（两平台通用）：禁止"相似视频发布到多个账号"与营销感内容 → 矩阵内容必须差异化（不同账号不同模板/文案/封面），抖音每号每日上限 75 条。

### 视频号（6-10 官方文档核实）
**没有发布内容的官方 API，预期内也不会有。** 开放给第三方的只有 4 个权限集：留资组件数据(143)、留资直播数据(160)、达人电商数据(176)、商品橱窗管理(177)——全是电商/直播数据类。开放社区官方对"代用户发布视频 API"长期未开放。市面工具的"一键发视频号"全是浏览器自动化。
- 权限集: https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/product/channel_authority.html
- 视频号助手API列表: https://developers.weixin.qq.com/doc/channels/api/channels/

所以视频号的合规天花板 = 把登录和发布放到**客户自己的电脑**（环境可信：家用 IP + 真浏览器；授权真实：客户亲手扫码；凭证不托管：登录态留客户本机）。与易媒/蚁小二桌面软件形态一致。

## 2. 抖音 A 轨：已落地代码（PR-D1, commit 3b0f039）

| 文件 | 内容 |
|---|---|
| `packages/server/src/services/publisher/douyin-open-api.ts` | OAuth（授权URL/换token/刷新/续期）+ 上传（>50MB 自动分片）+ 创建视频；错误码人话翻译 |
| `packages/server/src/routes/douyin-callback.ts` | `GET /douyin/oauth/callback` 公开回调，state HMAC 签名防伪造，token AES-GCM 加密落库 |
| `packages/server/src/routes/accounts.ts` | `GET /accounts/:id/douyin-oauth-url` 生成授权链接（30 分钟有效） |
| `packages/server/src/services/publisher/adapters/douyin.ts` | 重写：官方调用链 + token 自动续期；未授权/能力未批时返回明确指引 |
| `packages/server/src/config/env.ts` | `DOUYIN_CLIENT_KEY` / `DOUYIN_CLIENT_SECRET` / `DOUYIN_OAUTH_REDIRECT_URL` / `DOUYIN_PRIVATE_STATUS`（默认 1=自见草稿模式） |

### 审批通过后的使用流程
1. `.env` 配置 `DOUYIN_CLIENT_KEY/SECRET` + `DOUYIN_OAUTH_REDIRECT_URL=https://<域名>/api/v1/douyin/oauth/callback`
2. 账号管理建抖音账号 → `GET /accounts/:id/douyin-oauth-url` → 客户打开链接用抖音 App 确认授权 → 回调自动落 token
3. 正常批量发布。默认 `private_status=1`（自见）：过审后仅作者可见，客户在抖音 App「我>作品」检查后改公开；`DOUYIN_PRIVATE_STATUS=0` 改全自动公开
4. token：access 15 天 / refresh 30 天，发布时自动续期落库；refresh 临期自动 renew（官方最多 5 次，之后需重新授权一次）

## 3. 能力申请清单（A 轨，当前行动项）

前置（按顺序）：
1. **企业主体开发者账号**（个人主体建不了网站应用）：营业执照 + 对公打款验证，约 3 个工作日 ← **老韩**
2. **ICP 备案域名**（回调域名要求）：跟服务器迁移（119.91.52.13）一起做 ← **老韩**
3. **创建"网站应用"**（不是测试应用，需上线转正）
4. 控制台 > 应用详情 > 能力管理 > **能力实验室 > 代替用户发布内容到抖音**，提交申请（5 个工作日内反馈）

申请材料：
- 产品定位话术：学术期刊知识科普内容管理工具，服务签约企业客户管理**其自有/签约抖音账号**的内容发布（贴官方允许场景原话）
- 产品截图：账号管理页（体现"客户授权自己的账号"）+ 发布页（体现内容预览、用户主动点发布）
- **前端待办：发布界面补「是否同步到抖音」「是否同步删除」勾选框**（使用规范硬要求，申请截图要用）← Claude 做
- 内容样例：选知识科普向成品视频（避免营销感）

被拒处理：看拒因。类目问题 → 调定位重新申请；主体门槛 → 抖音转 B 轨。

## 4. B 轨：BossMate 本地发布 Agent（视频号终态 + 抖音保底）

```
┌─────────── 服务器（不变） ───────────┐      ┌──────── 客户电脑 ────────┐
│ 选题/文案/视频合成/审核/排期          │      │ BossMate Agent (托盘程序) │
│ 任务队列: publish_tasks 表           │◄────►│  - 轮询/长连接领任务       │
│ GET /agent/tasks  POST /agent/ack   │ HTTPS│  - 下载视频+文案           │
│ (复用现有 JWT + tenant 隔离)         │      │  - 本地 Chrome(有头,持久   │
└─────────────────────────────────────┘      │    profile)分渠道上传发布  │
                                             │  - 回报结果→已发落库        │
                                             └───────────────────────────┘
```

- **多渠道设计**：每个任务带 `platform` 字段（wechat_video / douyin / 后续小红书），Agent 按渠道加载站点脚本。视频号脚本从现有 browser-session/wechat-video 适配器整体移植（发布脚本是通的，之前卡的只是登录环境）。
- **Agent 形态**：Electron 托盘应用（或 Node 单文件 + pkg）。内嵌 Playwright 驱动有头 Chrome，每账号一个持久 user-data-dir。
- **登录**：首次客户本机扫码（可信环境秒过）；登录态留客户本机不上传（规避凭证托管责任）。
- **服务器侧改造**：`publish_tasks` 表（pending/claimed/done/failed）+ 领任务/回报两个路由。预估 1-2 周 MVP。
- **何时启动**：见第 0 节触发条件。未触发前不开工。

## 5. 排除项与决策记录

- 住宅代理/指纹浏览器：**排除** — 对抗性手段不可长期维护，撑不起 B2B 产品。
- 视频号第三方平台服务商权限集：只覆盖电商数据，不解决发内容，不投入。
- 服务器迁移不解决机房 IP 本质问题，但 ICP 备案域名是 A 轨前置 → 迁移优先级提升。
- 半自动发布助手：永久兜底保留（演示/过渡/Agent 故障时均可用）。
