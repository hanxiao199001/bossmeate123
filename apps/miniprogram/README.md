# BossMate 期刊检索小程序

复用现有 BossMate 后端（`packages/server`）的微信小程序，支持两大功能：

1. **检索**（需登录）—— 按学科 / 分区 / 影响因子 / 关键词筛选期刊，分页 + 详情。
   走 `GET /api/v1/journals`、`GET /api/v1/journals/:id`。
2. **智能匹配**（免登录）—— 粘贴论文摘要，AI 推荐 5 本最对口期刊。
   走公开接口 `POST /api/v1/public/match-journals`。

登录方式为**微信一键登录**（`wx.login` + 手机号授权），后端复用手机号体系签发 JWT。

## 目录结构

```
apps/miniprogram/
├── app.js / app.json / app.wxss   全局逻辑、路由、样式
├── config.js                      ★ 部署前改 API_BASE
├── sitemap.json / project.config.json
├── utils/
│   ├── request.js                 请求封装（自动带 token、401 跳登录）
│   └── format.js                  学科映射 / 指标格式化
└── pages/
    ├── index/   检索页（tabBar）
    ├── match/   智能匹配页（tabBar）
    ├── detail/  期刊详情页
    └── login/   微信登录页
```

## 跑起来（3 步）

1. **导入项目**：微信开发者工具 → 导入 → 选 `apps/miniprogram` 目录 → 填入你的小程序 AppID。
2. **改后端地址**：编辑 `config.js`，把 `API_BASE` 改成你的线上域名（含 `/api/v1`）。
   - 本地联调：可在开发者工具「详情 → 本地设置」勾选「不校验合法域名」，并把 `API_BASE` 临时改为 `http://localhost:3000/api/v1`。
3. **配合法域名**：小程序后台「开发管理 → 开发设置 → 服务器域名 → request 合法域名」加入你的 **https** 域名（线上必须 https）。

## 后端需要做的配置

本次已在 `packages/server` 中新增：

- `POST /api/v1/auth/wx-login` —— 小程序登录接口（`src/routes/auth.ts`）。
- `src/services/wechat/miniprogram.ts` —— `code2session` / 取手机号 / 解密。
- `src/config/env.ts` 新增两个环境变量。

部署时在服务器 `.env` 填上小程序凭证（小程序后台 → 开发管理 → 开发设置）：

```
WECHAT_MINI_APPID=你的小程序AppID
WECHAT_MINI_SECRET=你的小程序AppSecret
```

> 登录采用「手机号 → 用户」映射：手机号已是 BossMate 用户即可直接登录；
> 新号需后台先发邀请（与短信登录 `/auth/sms/login` 同一套租户/邀请逻辑），否则返回「未注册」。
> 如需「微信免手机号注册即用」，可在 `wx-login` 里改为用 `openid` 建号——需给 `users` 表加 `wechatOpenid` 列。

## 接口对照

| 页面 | 方法 | 路径 | 鉴权 |
|------|------|------|------|
| 检索列表 | GET | `/journals?keyword=&discipline=&partition=&ifMin=&ifMax=&sortBy=&page=&pageSize=` | JWT |
| 期刊详情 | GET | `/journals/:id` | JWT |
| 智能匹配 | POST | `/public/match-journals` `{ abstract }` | 公开 |
| 登录 | POST | `/auth/wx-login` `{ code, phoneCode, encryptedData?, iv? }` | 公开 |

学科筛选值（英文）与后端 `disciplineMap` 一致：medicine / education / engineering / economics / law / psychology / biology / chemistry / physics / environment / materials / math。
