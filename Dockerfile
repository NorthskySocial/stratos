# Stratos Private Namespace Service - Docker Image
#
# Multi-stage build: compiles TypeScript at build time for fast startup.
# Target 1 (stratos): Node.js service for storage and XRPC.
# Target 2 (indexer): Deno-based standalone indexer.

# --- Build stage ---
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY stratos-core/package.json ./stratos-core/
COPY stratos-service/package.json ./stratos-service/
COPY stratos-indexer/package.json ./stratos-indexer/
COPY stratos-client/package.json ./stratos-client/
COPY webapp/package.json ./webapp/

# Install all dependencies (including devDependencies for tsc)
RUN pnpm install --frozen-lockfile

# Copy source files
COPY tsconfig.json ./
COPY stratos-core/ ./stratos-core/
COPY stratos-service/ ./stratos-service/
COPY stratos-indexer/ ./stratos-indexer/
COPY lexicons/ ./lexicons/

# Re-link workspace node_modules (COPY can disrupt pnpm symlinks)
RUN pnpm install --frozen-lockfile

# Generate version module, then compile packages
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

# --- Production stage for Stratos Service ---
FROM node:24-alpine AS stratos

RUN corepack enable && corepack prepare pnpm@latest --activate

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

# Run compiled JS directly
WORKDIR /app/stratos-service
CMD ["node", "dist/bin/stratos.js"]

# --- Production stage for Stratos Indexer ---
FROM denoland/deno:alpine AS indexer

# Install dependencies for sharp (libstdc++ and libc symlink are required for the native binary)
RUN apk add --no-cache libstdc++ && \
    ln -s /lib/libc.musl-$(uname -m).so.1 /lib/libc.so

WORKDIR /app

# Copy built stratos-core from builder (Deno uses its package.json and dist)
COPY --from=builder /app/stratos-core/ ./stratos-core/

# Copy indexer source files and package.json
COPY --from=builder /app/stratos-indexer/ ./stratos-indexer/

# Copy package.json for other workspace members to satisfy Deno workspace requirements
COPY --from=builder /app/stratos-service/package.json ./stratos-service/
COPY --from=builder /app/stratos-client/package.json ./stratos-client/
COPY --from=builder /app/webapp/package.json ./webapp/

# Copy workspace files for Deno to resolve dependencies correctly
COPY deno.json package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy lexicons (needed at runtime by stratos-core)
COPY lexicons/ ./lexicons/

# Deno needs wget for health checks in this setup (alpine base has it or we add it)
# The official deno:alpine image comes with wget.

# Expose default port for health server
EXPOSE 3002

# Set default environment
ENV BSKY_DB_POOL_SIZE=20

# Command to run the indexer main script
CMD ["run", "--allow-all", "--sloppy-imports", "/app/stratos-indexer/src/bin/main.ts"]
