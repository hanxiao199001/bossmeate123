# BossMate Docker 构建文件
# 多阶段构建：先编译，再用精简镜像运行

# ====== 阶段1: 构建 ======
FROM node:22-slim AS builder

RUN npm install -g pnpm@9.15.0

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/server/package.json packages/server/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile || pnpm install

COPY . .

# 构建后端
RUN pnpm --filter @bossmate/server build

# 构建前端
RUN pnpm --filter @bossmate/web build

# ====== 阶段2: 运行 ======
FROM node:22-slim AS runner

RUN npm install -g pnpm@9.15.0

WORKDIR /app

# 只复制运行需要的文件
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules

# 创建数据目录
RUN mkdir -p /app/data/lancedb /app/data/uploads /app/logs

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "packages/server/dist/index.js"]
