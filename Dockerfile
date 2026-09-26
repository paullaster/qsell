# =============================================================================
# Multi-stage Dockerfile for Next.js 16 (App Router) with maximum performance
# =============================================================================

# -----------------------------------------------------------------------------
# Base image with security hardening
# -----------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN apk add --no-cache dumb-init curl tini
ENV PNPM_HOME="/pnpm" PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm && corepack prepare pnpm@latest --activate

# -----------------------------------------------------------------------------
# Dependencies stage - install all deps with caching
# -----------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

# -----------------------------------------------------------------------------
# Build stage - compile Next.js with TurboPack
# -----------------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time env (only non-secret vars)
ARG NEXT_TELEMETRY_DISABLED=1
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Generate Prisma client
RUN pnpm db:generate

# Build with TurboPack for speed
RUN pnpm build

# -----------------------------------------------------------------------------
# Production dependencies only
# -----------------------------------------------------------------------------
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=true --ignore-scripts

# -----------------------------------------------------------------------------
# Runner stage - minimal production image
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

# Security: non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    apk add --no-cache curl tini

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3069
ENV HOSTNAME="0.0.0.0"

# Copy built assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

USER nextjs

EXPOSE 3069

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Use tini for proper signal handling
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
