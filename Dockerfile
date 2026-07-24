# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 编译同源 OIDC BFF。
FROM node:22-alpine AS server-build

WORKDIR /app/server
COPY server/package.json ./
RUN npm install
COPY server ./
RUN npm run build && npm prune --omit=dev

# 运行镜像：由 BFF 同时托管 SPA 和受限 OIDC 网关代理。
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY --from=server-build /app/server/package.json ./server/package.json
COPY --from=server-build /app/server/node_modules ./server/node_modules
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=web-build /app/web/dist ./web/dist

EXPOSE 3000
CMD ["node", "server/dist/index.js"]
