FROM node:24.18.0-bookworm-slim AS workspace
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ ./apps/
COPY packages/ ./packages/
RUN chmod -R a+rX apps packages && pnpm install --frozen-lockfile

FROM workspace AS api
RUN pnpm --filter @bv/server build
WORKDIR /repo/apps/server
USER node
RUN test -r dist/main.js && test -r db/migrate.cjs && test -r db/seed-dev-owner.cjs
CMD ["node", "dist/main.js"]

FROM workspace AS web-build
RUN pnpm --filter @bv/web build

FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /repo/apps/web/dist/ /srv/
