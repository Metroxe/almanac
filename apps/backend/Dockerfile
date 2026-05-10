# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/discoverer/package.json apps/discoverer/
COPY apps/mcp/package.json apps/mcp/
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS builder
WORKDIR /repo
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN npm run build -w @almanac/shared \
 && npm run build -w @almanac/backend \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app
COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/shared/package.json packages/shared/package.json
COPY --from=builder /repo/packages/shared/dist packages/shared/dist
COPY --from=builder /repo/apps/backend/package.json apps/backend/package.json
COPY --from=builder /repo/apps/backend/dist apps/backend/dist
EXPOSE 8787
USER node
CMD ["node", "apps/backend/dist/index.js"]
