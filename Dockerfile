# Stratos Private Namespace Service - Docker Image
#
# Uses tsx for TypeScript execution without compilation,
# as the codebase uses dynamic imports and runtime transpilation.

FROM node:24-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY stratos-core/package.json ./stratos-core/
COPY stratos-service/package.json ./stratos-service/

# Install all dependencies (tsx is a production dependency needed for runtime)
RUN pnpm install --frozen-lockfile

# Copy source files
COPY tsconfig.json ./
COPY stratos-core/ ./stratos-core/
COPY stratos-service/ ./stratos-service/
COPY lexicons/ ./lexicons/

# Create data directory
RUN mkdir -p /app/data && chown -R node:node /app/data

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

# Run the service using tsx from stratos-service (where it's installed)
WORKDIR /app/stratos-service
CMD ["pnpm", "exec", "tsx", "src/bin/stratos.ts"]
