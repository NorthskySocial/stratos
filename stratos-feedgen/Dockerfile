# Stratos Feed Generator
#
# Build context is the `stratos/` workspace root (so workspace deps resolve).
#
# Build:    docker build -f stratos-feedgen/Dockerfile -t stratos-feedgen .
# Run:      docker run --rm -p 3000:3000 \
#             -e FEEDGEN_SERVICE_DID=did:web:feedgen.example.com \
#             -e FEEDGEN_SIGNING_KEY=<hex> \
#             -e STRATOS_SERVICE_URL=https://stratos.example.com \
#             -e STRATOS_SERVICE_DID=did:web:stratos.example.com \
#             -e FEEDGEN_FEEDS_FILE=/app/config/feeds.yaml \
#             -v /path/to/feeds.yaml:/app/config/feeds.yaml:ro \
#             stratos-feedgen
#
# Persistence is opt-in and retains private feed data:
#             -e FEEDGEN_SQLITE_PATH=/app/data/feedgen.sqlite \
#             -v feedgen-data:/app/data \

# --- Build stage: install workspace deps and run esbuild bundle ---
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Workspace manifests for cached install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY stratos-core/package.json ./stratos-core/
COPY stratos-service/package.json ./stratos-service/
COPY stratos-indexer/package.json ./stratos-indexer/
COPY stratos-client/package.json ./stratos-client/
COPY stratos-feedgen/package.json ./stratos-feedgen/
COPY webapp/package.json ./webapp/

RUN pnpm install --frozen-lockfile --ignore-scripts

# Sources needed to bundle feedgen (stratos-core is bundled in via workspace).
COPY tsconfig.json ./
COPY lexicons/ ./lexicons/
COPY stratos-core/ ./stratos-core/
COPY stratos-feedgen/ ./stratos-feedgen/

RUN pnpm install --frozen-lockfile --ignore-scripts

RUN pnpm --filter @northskysocial/stratos-feedgen bundle

# --- Production stage: just the bundle + native externals ---
FROM node:24-alpine AS feedgen

WORKDIR /app

# Install only the runtime externals the bundle expects (keep versions in
# sync with stratos-feedgen/package.json and scripts/bundle.mjs `external`).
RUN apk add --no-cache wget \
    && npm install --omit=dev --no-package-lock --no-audit --no-fund \
        @libsql/client@0.17.0 \
        postgres@3.4.8 \
    && npm cache clean --force

# Bundled application (single ESM file + sourcemap).
COPY --from=builder /app/stratos-feedgen/dist-bundle/ ./

RUN mkdir -p /app/config && chown -R node:node /app/config

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENV NODE_ENV=production
ENV FEEDGEN_PORT=3000

CMD ["node", "main.mjs"]
