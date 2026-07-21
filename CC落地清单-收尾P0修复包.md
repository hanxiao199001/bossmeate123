# CC 落地清单 — 收尾 P0 修复包（2026-07-13）

> 交付前必修四条，全小工作量，消除"演示/交付时扎眼的破绽"。双端 tsc 零错误。

## 改动内容

| # | 问题 | 改动 |
|---|---|---|
| P0-1 | DVH 兜底是 example.com 死链（合成失败时用户拿到打不开的视频） | mock-fixture.ts 改为 env `DVH_MOCK_FIXTURE_BASE` 可配，默认指 OSS 占位桶 `dvh-fixtures/placeholder-{1,2,3}.mp4` |
| P0-2 | 生产以 development 身份跑（三道保险丝被架空） | **见下方"NODE_ENV 翻转"独立执行**（侦察清单前面会话已批） |
| P0-3 | "效果分析"导航点进去是营销测算器（续费叙事断点） | 导航改名"价值测算"；页面头加说明"测算工具非真实数据，真效果见首页" |
| P0-4 | "mock 账号"开发术语弹给用户 + 微信回调 token 用仓库硬编码默认值 | toast 改人话；env 加生产校验：WECHAT_VERIFY_TOKEN 仍是默认值则启动 fail-fast |

改动文件：`packages/server/src/services/digital-human/mock-fixture.ts`、`config/env.ts`、`apps/web/src/pages/ContentWorkbenchPage.tsx`、`components/layout/Sidebar.tsx`、`pages/CostComparisonPage.tsx`

## 提交 + 部署（桌面提交流）

```bash
cd ~/Desktop/02_AI项目与产品/【007】bossmate/bossmate-project
git add packages/server/src/services/digital-human/mock-fixture.ts \
        packages/server/src/config/env.ts \
        apps/web/src/pages/ContentWorkbenchPage.tsx \
        apps/web/src/components/layout/Sidebar.tsx \
        apps/web/src/pages/CostComparisonPage.tsx
git commit -m "fix(收尾P0): DVH兜底死链→env可配OSS占位桶 + '效果分析'导航改名'价值测算'(消续费叙事断点) + 清mock开发术语toast + 生产WECHAT_VERIFY_TOKEN默认值fail-fast守卫"
git push && pnpm deploy:smart
```

## ⚠️ 部署前/后两个动作（CC 必做）

1. **上传 DVH 占位样片**（否则兜底还是拿不到视频）：找 3 条已生成的正常数字人成片（或用之前的样片），传到 OSS：
   ```
   bossmate-media/dvh-fixtures/placeholder-1.mp4  (2.mp4 / 3.mp4)
   ```
   或在 `.env` 配 `DVH_MOCK_FIXTURE_BASE=<你的样片目录URL>`。**顺带确认生产 `DVH_REAL_MODE=true`**（正常极少走兜底，但兜底不能是死链）。

2. **生产 .env 设真 WECHAT_VERIFY_TOKEN**：新校验会让"仍是默认值 ai_butler_token_2026"的生产启动直接退出。部署前先 `ssh grep WECHAT_VERIFY_TOKEN .env`——若是默认值或没配，改成一个随机串（和公众号后台回调配置里填的一致），否则部署后服务起不来。

## P0-2 NODE_ENV 翻转（独立执行，别搭本包顺风车）

侦察清单前会话已批（3 个崩溃项服务器都就绪）。挑低峰：`.env` 设 `NODE_ENV=production` → 重启 → 全量 verify（health/登录/生成一篇 sample:article/日志变 JSON 正常）。翻转后本包的两个 fail-fast 守卫（微信 token / 已有的 JWT/embedding）才真正生效——所以**建议 NODE_ENV 翻转和本包一起做**，翻转后立即验证 WECHAT_VERIFY_TOKEN 已配真值不会崩。

## 验收
- 侧边栏"效果分析"→ 已变"价值测算"，点进去顶部有"测算工具非真实数据"说明
- 批量发布失败的 toast 不再出现"mock"字样
- （NODE_ENV=production 后）WECHAT_VERIFY_TOKEN 用默认值时启动报错退出；配真值正常起
- DVH 兜底路径返回的 URL 能真实播放（不再 example.com）
