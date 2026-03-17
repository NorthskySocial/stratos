# Stratos Private Namespace Service - Docker Image
#
# Multi-stage build: compiles TypeScript at build time for fast startup.
# Stage 1 builds both packages; Stage 2 runs compiled JS directly with node.

# --- Build stage ---
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY stratos-core/package.json ./stratos-core/
COPY stratos-service/package.json ./stratos-service/
COPY stratos-client/package.json ./stratos-client/
COPY webapp/package.json ./webapp/
COPY infra/package.json ./infra/

# Install all dependencies (including devDependencies for tsc)
RUN pnpm install --frozen-lockfile

# Copy source files
COPY tsconfig.json ./
COPY stratos-core/ ./stratos-core/
COPY stratos-service/ ./stratos-service/
COPY lexicons/ ./lexicons/

# Generate version module, then compile both packages
RUN pnpm run --filter stratos-service generate:version \
    && pnpm run --filter stratos-core build \
    && pnpm run --filter stratos-service build

# Patch stratos-core package.json to export compiled dist/ for production
RUN node -e " \
  const fs = require('fs'); \
  const pkg = JSON.parse(fs.readFileSync('stratos-core/package.json', 'utf8')); \
  pkg.main = 'dist/index.js'; \
  pkg.types = 'dist/index.d.ts'; \
  pkg.exports = { \
    '.': { types: './dist/index.d.ts', import: './dist/index.js' }, \
    './validation': { types: './dist/validation/index.d.ts', import: './dist/validation/index.js' }, \
    './db': { types: './dist/db/index.d.ts', import: './dist/db/index.js' } \
  }; \
  fs.writeFileSync('stratos-core/package.json', JSON.stringify(pkg, null, 2) + '\n'); \
"

# --- Production stage ---
FROM node:24-alpine

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy package files — use patched stratos-core package.json from builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=builder /app/stratos-core/package.json ./stratos-core/
COPY stratos-service/package.json ./stratos-service/

# Install production dependencies only (no devDependencies)
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/stratos-core/dist/ ./stratos-core/dist/
COPY --from=builder /app/stratos-service/dist/ ./stratos-service/dist/

# Copy lexicons (needed at runtime for validation)
COPY lexicons/ ./lexicons/

# Create data directory structure
# /app/data/assets/ - optional static files served at /assets (e.g. OAuth consent screen logo)
RUN mkdir -p /app/data/assets && chown -R node:node /app/data

# Switch to non-root user
USER node

# Expose default port
EXPOSE 3100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3100/health || exit 1

# Set default environment
ENV NODE_ENV=production
ENV STRATOS_PORT=3100
ENV STRATOS_DATA_DIR=/app/data

# Run compiled JS directly — no tsx transpilation at startup
WORKDIR /app/stratos-service
CMD ["node", "dist/bin/stratos.js"]
