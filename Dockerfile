# BossMate Docker 构建文件
# 多阶段构建：先编译，再用精简镜像运行

# ====== 阶段1: 构建 ======
FROM node:22-slim AS builder

RUN npm install -g pnpm@9.15.0

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile || pnpm install

COPY . .

# 构建后端
RUN pnpm --filter @bossmate/server build

# 构建前端
RUN pnpm --filter @bossmate/web build

# 清理不必要的文件以减小最终镜像
RUN pnpm prune --prod

# ====== 阶段2: 运行 ======
FROM node:22-slim AS runner

WORKDIR /app

# 创建非 root 用户
RUN useradd -m -u 1000 node && \
    mkdir -p /app/data/lancedb /app/data/uploads /app/logs && \
    chown -R node:node /app

# 只复制运行需要的文件
COPY --from=builder --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=node:node /app/packages/server/package.json ./packages/server/
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/server/node_modules ./packages/server/node_modules

# 切换到非 root 用户
USER node

EXPOSE 3000

ENV NODE_ENV=production

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

CMD ["node", "packages/server/dist/index.js"]
