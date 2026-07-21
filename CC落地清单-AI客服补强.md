# CC 落地清单 — AI 客服补强（2026-07-02）

> 三件：① handoff 企微通知运营（自建应用推送）② 接待人员企微端回复回流落库 + AI 自动让位 ③ 非文本消息占位落库 + 管理页标签。双端 tsc 零错误。migration **022**（幂等加两列）。

## 0. 提交 + 部署

```bash
cd /home/projects/bossmate && rm -f .git/*.lock
git add packages/server/src/models/migrations.ts packages/server/src/models/schema.ts \
        packages/server/src/routes/work-wechat-kf.ts \
        packages/server/src/services/work-wechat/kf-client.ts \
        packages/server/src/services/work-wechat/kf-responder.ts \
        apps/web/src/pages/KfServicePage.tsx
git commit -m "feat(kf): 客服补强三件 — ①handoff企微通知运营(自建应用message/send, agent_secret_enc+notify_userids, migration 022) ②接待人员origin=5回复回流落库(ai_action=human_wecom)+会话自动置manual(AI让位防抢答) ③非text客户消息占位落库([图片]等,不触发AI)+管理页'企微端人工'标签"
git push && pnpm deploy:smart   # 022 自动跑
npx vitest run packages/server/src/__tests__/work-wechat-callback.test.ts   # 回归(未触碰断言, 应全绿)
```

## 1. 配置（han 企微后台，一次配齐两个 Secret）

| 项 | 在哪拿 | 干什么用 |
|---|---|---|
| **微信客服 Secret**（kfSecret） | 企微后台 → 微信客服 → 开发配置 | 收发客户消息（上周就要的那个） |
| **自建应用 Secret**（agentSecret） | 企微后台 → 应用管理 → agentId 对应的自建应用详情页 | 给运营推 handoff 通知（本次新增，两者不是同一个） |
| 回调 Token + EncodingAESKey | 微信客服 → 回调配置 | 回调 URL：`https://<域名>/api/v1/work-wechat/callback` |
| 可信 IP | 服务器出口 IP 加白 | 不加 gettoken 报 60020 |

配置写入（一次 PUT）：
```
PUT /api/v1/admin/work-wechat/config
{ "corpId": "...", "agentId": "...", "token": "...", "encodingAesKey": "...",
  "kfSecret": "...", "agentSecret": "...", "notifyUserIds": "运营的企微userid,逗号分隔" }
```
notifyUserIds 不填 = 通知发自建应用可见范围内 @all；**接收人必须在该自建应用可见范围内**。

## 2. FAQ 录入

按《运营素材-AI客服FAQ初稿与验收题集.md》：han 补【待填】→ web「AI 客服 → FAQ 管理」录入（≤30 条生效）。

## 3. 联调验收

跑题集 20 题（同文件第二部分），通过标准：期刊类零编造、FAQ 命中口径一致、16-18 题转人工全触发且**运营企微收到通知**、接待人员在企微端回一条后该会话 AI 自动停答（管理页可切回）。

## 已知限制（v2 再说）
- 通知里是 external_userid 简写非客户昵称（拿昵称需另调 kf/customer/batchget）
- 接待人员发的图片等非 text 不回流
- 前端配置表单没做，配置走 API 直调
