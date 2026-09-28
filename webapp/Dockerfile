# Build stage: Install dependencies and build webapp
FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

# Copy package.json files first (for dependency resolution and caching)
# This layer is cached unless package.json files change
COPY stratos-core/package.json ./stratos-core/
COPY stratos-client/package.json ./stratos-client/
COPY stratos-browser/package.json ./stratos-browser/
COPY webapp/package.json ./webapp/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# Install dependencies (cached unless package.json/lockfile changes)
# --ignore-scripts skips optional build scripts for dependencies (core-js, esbuild)
RUN pnpm install --ignore-scripts

# Copy lexicons (required by stratos-core lexicon imports)
COPY lexicons/ ./lexicons/
COPY lexicons-spaces/ ./lexicons-spaces/

# Copy source code (after install, so cache invalidates only on source changes)
COPY stratos-core/ ./stratos-core/
COPY stratos-client/ ./stratos-client/
COPY stratos-browser/ ./stratos-browser/
COPY webapp/ ./webapp/

# Build the Stratos client (generates dist/ consumed by the webapp lexicon import)
WORKDIR /build/stratos-client
RUN pnpm build

WORKDIR /build/stratos-browser
RUN pnpm build

# Build the webapp package
WORKDIR /build/webapp

ARG VITE_STRATOS_URL
ARG VITE_APPVIEW_URL
ARG VITE_WEBAPP_URL
ARG VITE_STRATOS_SERVICE_DID
ARG VITE_FEEDGEN_DID
ARG VITE_FEEDGEN_FEED
ARG VITE_ATPROTO_HANDLE_RESOLVER
ARG VITE_PLC_DIRECTORY
ARG VITE_ATPROTO_OAUTH_PROXY_URL

ENV VITE_STRATOS_URL=${VITE_STRATOS_URL}
ENV VITE_APPVIEW_URL=${VITE_APPVIEW_URL}
ENV VITE_WEBAPP_URL=${VITE_WEBAPP_URL}
ENV VITE_STRATOS_SERVICE_DID=${VITE_STRATOS_SERVICE_DID}
ENV VITE_FEEDGEN_DID=${VITE_FEEDGEN_DID}
ENV VITE_FEEDGEN_FEED=${VITE_FEEDGEN_FEED}
ENV VITE_ATPROTO_HANDLE_RESOLVER=${VITE_ATPROTO_HANDLE_RESOLVER}
ENV VITE_PLC_DIRECTORY=${VITE_PLC_DIRECTORY}
ENV VITE_ATPROTO_OAUTH_PROXY_URL=${VITE_ATPROTO_OAUTH_PROXY_URL}

RUN pnpm build

# Use the published template so production metadata has the same scope as the webapp.
RUN node -e 'const fs = require("node:fs"); const metadata = JSON.parse(fs.readFileSync("public/client-metadata.json.template", "utf8")); const base = process.env.VITE_WEBAPP_URL; metadata.client_id = `${base}/client-metadata.json`; metadata.client_uri = base; metadata.redirect_uris = [`${base}/`]; metadata.scope = metadata.scope.replace("VITE_STRATOS_SERVICE_DID_ENCODED", encodeURIComponent(process.env.VITE_STRATOS_SERVICE_DID ?? "")); fs.writeFileSync("dist/client-metadata.json", `${JSON.stringify(metadata)}\n`);'

# Production stage
FROM nginx:alpine

COPY --from=build /build/webapp/dist /usr/share/nginx/html
COPY --from=build /build/webapp/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
