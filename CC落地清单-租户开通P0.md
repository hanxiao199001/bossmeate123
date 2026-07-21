# CC 落地清单 — 多租户开通 P0（2026-07-03）

> ① 平台管理员白名单（env 手机号）② 客户开通页（替代 ssh CLI，运营 30 秒表单+欢迎短信优雅降级）③ 老板首登 5 步向导卡（tenantPreferences 存储，无 migration）④ 生产环境关自注册（register + register-company 双闸，dev/test 不受影响）。
> 双端 tsc 零错误；provision 幂等单测 8/8；auth 现有测试零触碰。

## 0. 提交 + 部署

```bash
cd /home/projects/bossmate && rm -f .git/*.lock
git add -A packages/server/src apps/web/src
git commit -m "feat(platform): 多租户开通P0 — ①PLATFORM_ADMIN_PHONES白名单+platformAdminOnly ②客户开通页(provision抽service幂等+CLI薄包装, POST/GET /platform/tenants, 欢迎短信降级) ③owner首登5步向导卡(tenantPreferences存储无migration) ④生产关自注册(register/register-company双闸, ALLOW_SELF_REGISTER可重开)"
git push && pnpm deploy:smart   # 前端有改动要 build
npx vitest run packages/server/src/__tests__/provision-tenant-service.test.ts
```

## 1. 配置（han 一项必做）

服务器 `.env` 加：
```
PLATFORM_ADMIN_PHONES=<老韩手机号>[,运营手机号]
```
欢迎短信可选：阿里云再申请一个模板（"您的 BossMate 已开通，用本手机号验证码登录：boss-mates.com"，变量 {company}）→ `.env` 配 `SMS_WELCOME_TEMPLATE_CODE=SMS_xxx`。不配也能用，开通页会提示"请口头通知客户"。

## 2. 验收四步

1. 白名单手机号登录 → 侧边栏出现「平台管理」→ 表单开通一个测试租户
2. 用测试租户 owner 手机号验证码首登 → 首页见 5 步向导卡（去完成/标记完成/跳过/进度条/可收起）
3. 非白名单账号：看不到入口，直敲 /platform 被弹回、API 403
4. 生产 `POST /api/v1/auth/register` → 403 SELF_REGISTER_DISABLED

## 3. 运营 SOP 更新提醒

《运营SOP-短信接入与新客户开通》第二部分"跑开通命令"已过时——开通改为「平台管理」页面表单操作，CLI 保留为应急备用。CC 部署后顺手在该 md 里加一行说明。

## 已知限制
- 向导卡只对 owner 显示；跳转指向 /settings、/accounts、/workbench 现有页
- 欢迎短信域名写死在阿里云模板文案里
- P1 待办（未做）：邀请短信触达、邮箱注册改"申请试用"留资、平台客户列表的冻结/用量（现为只读薄列表）
