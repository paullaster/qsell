# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

# Install the exact pnpm version and dependency graph declared by the manifest
# and lockfile. A missing lockfile fails the image build instead of resolving
# newer dependency versions implicitly.
FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Local development target. Compose bind-mounts the source tree.
FROM dependencies AS development
ENV NODE_ENV=development PORT=3069 HOSTNAME=0.0.0.0
EXPOSE 3069
CMD ["pnpm", "dev", "--hostname", "0.0.0.0", "--port", "3069"]

# Compile the web application once. Standalone output contains its traced
# production runtime dependencies and does not need a second dependency install.
FROM dependencies AS builder
COPY . .
ARG DEPLOYMENT_VERSION=local
# src/auth.ts validates AUTH_SECRET during module initialization at build time.
# This is a disposable build-only value; the runtime secret comes from .env.runtime.
ENV NODE_ENV=production \
    AUTH_SECRET=build-only-not-a-runtime-secret \
    DEPLOYMENT_VERSION=${DEPLOYMENT_VERSION}
RUN pnpm build

FROM node:${NODE_VERSION}-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3069 \
    HOSTNAME=0.0.0.0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN addgroup --system --gid 1001 nextjs \
 && adduser --system --uid 1001 --ingroup nextjs nextjs \
 && corepack enable \
 && corepack prepare pnpm@12.6.0 --activate

FROM runtime-base AS runner
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public
RUN mkdir -p .next/cache && chown -R nextjs:nextjs .next
USER nextjs
EXPOSE 3069
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3069/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]

# Background worker has a distinct runtime: Graphile Worker runs TypeScript
# task handlers via tsx and shares the same pinned dependency lockfile.
FROM runtime-base AS worker
COPY --from=dependencies --chown=nextjs:nextjs /app/node_modules ./node_modules
COPY --chown=nextjs:nextjs package.json pnpm-workspace.yaml tsconfig.json ./
COPY --chown=nextjs:nextjs src ./src
USER nextjs
CMD ["pnpm", "worker"]

# One-shot Drizzle migration image. Deploy runs this image before replacing app
# containers, so schema changes are applied using the same source revision.
FROM runtime-base AS migrator
COPY --from=dependencies --chown=nextjs:nextjs /app/node_modules ./node_modules
COPY --chown=nextjs:nextjs package.json pnpm-workspace.yaml tsconfig.json drizzle.config.ts ./
COPY --chown=nextjs:nextjs drizzle ./drizzle
COPY --chown=nextjs:nextjs src ./src
USER nextjs
CMD ["pnpm", "db:migrate"]
