# BossMate

BossMate(AI 超级员工)是一套面向中小企业的 AI 内容运营系统:后端生成图文/短视频内容,
前端提供管理界面,微信小程序面向终端用户,本地 Agent 负责把生成的视频从客户自己的电脑
发布到视频号/抖音(登录态留在本机,不经过服务器)。

## 技术栈

- **Monorepo**: pnpm workspace(Node.js >= 22, TypeScript, ESM)
- **后端** `packages/server`: Fastify 5 + PostgreSQL(pg)+ Redis(ioredis)+ BullMQ 任务队列
- **前端** `apps/web`: React 19 + Vite + Tailwind CSS 4 + Zustand + React Router 7
- **小程序** `apps/miniprogram`: 微信原生小程序
- **本地 Agent** `packages/agent`: Puppeteer 有头浏览器自动化(macOS/Windows 便携包)
- **共享** `packages/shared`: 公共类型与工具
- **测试/Lint**: Vitest、oxlint;**部署**: Docker Compose + Nginx

## 目录结构

```
apps/
  web/            # React 管理端
  miniprogram/    # 微信小程序
packages/
  server/         # Fastify 后端(API、任务队列、内容生成)
  agent/          # 本地发布 Agent
  shared/         # 共享类型与工具
docs/             # 项目文档(docs/internal/ 为历史遗留内部文档)
scripts/          # 部署与辅助脚本
nginx/            # Nginx 配置
```

## 本地开发

```bash
# 前置: Node >= 22, pnpm 9, PostgreSQL, Redis
pnpm install

cp .env.example .env        # 按注释填入本地配置
pnpm db:migrate             # 数据库迁移
pnpm db:seed                # 种子数据(可选)

pnpm dev                    # 同时启动 server + web
# 或分开: pnpm dev:server / pnpm dev:web

pnpm test                   # Vitest
pnpm lint                   # oxlint
pnpm build                  # 全量构建
```

部署使用 `pnpm deploy:smart`(`scripts/deploy-with-fallback.sh`),服务器地址通过
环境变量 `BOSSMATE_DEPLOY_SERVER` 指定。

## License

待定(暂未选择开源协议,默认保留所有权利)。
