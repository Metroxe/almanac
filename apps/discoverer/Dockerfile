# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20
ARG PLAYWRIGHT_VERSION=v1.49.1

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
COPY apps/discoverer apps/discoverer
RUN npm run build -w @almanac/shared \
 && npm run build -w @almanac/discoverer \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}-jammy AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/shared/package.json packages/shared/package.json
COPY --from=builder /repo/packages/shared/dist packages/shared/dist
COPY --from=builder /repo/apps/discoverer/package.json apps/discoverer/package.json
COPY --from=builder /repo/apps/discoverer/dist apps/discoverer/dist
USER pwuser
CMD ["node", "apps/discoverer/dist/index.js"]
