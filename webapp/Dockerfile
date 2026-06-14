# Build stage: Install dependencies and build webapp
FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

# Copy package.json files first (for dependency resolution and caching)
# This layer is cached unless package.json files change
COPY stratos-core/package.json ./stratos-core/
COPY stratos-client/package.json ./stratos-client/
COPY webapp/package.json ./webapp/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# Install dependencies (cached unless package.json/lockfile changes)
# --ignore-scripts skips optional build scripts for dependencies (core-js, esbuild)
RUN pnpm install --ignore-scripts

# Copy lexicons (required by stratos-core lexicon imports)
COPY lexicons/ ./lexicons/

# Copy source code (after install, so cache invalidates only on source changes)
COPY stratos-core/ ./stratos-core/
COPY stratos-client/ ./stratos-client/
COPY webapp/ ./webapp/

# Build the webapp package
WORKDIR /build/webapp

ARG VITE_STRATOS_URL
ARG VITE_APPVIEW_URL
ARG VITE_WEBAPP_URL
ARG VITE_STRATOS_SERVICE_DID
ARG VITE_FEEDGEN_DID
ARG VITE_FEEDGEN_FEED
ARG VITE_ATPROTO_HANDLE_RESOLVER

ENV VITE_STRATOS_URL=${VITE_STRATOS_URL}
ENV VITE_APPVIEW_URL=${VITE_APPVIEW_URL}
ENV VITE_WEBAPP_URL=${VITE_WEBAPP_URL}
ENV VITE_STRATOS_SERVICE_DID=${VITE_STRATOS_SERVICE_DID}
ENV VITE_FEEDGEN_DID=${VITE_FEEDGEN_DID}
ENV VITE_FEEDGEN_FEED=${VITE_FEEDGEN_FEED}
ENV VITE_ATPROTO_HANDLE_RESOLVER=${VITE_ATPROTO_HANDLE_RESOLVER}

RUN pnpm build

# Generate client-metadata.json for OAuth discovery
RUN printf '{"client_id":"%s/client-metadata.json","client_name":"Stratos","client_uri":"%s","redirect_uris":["%s/"],"scope":"atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post?action=create&action=delete","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"web","dpop_bound_access_tokens":true}\n' \
  "$VITE_WEBAPP_URL" "$VITE_WEBAPP_URL" "$VITE_WEBAPP_URL" > dist/client-metadata.json

# Production stage
FROM nginx:alpine

COPY --from=build /build/webapp/dist /usr/share/nginx/html
COPY --from=build /build/webapp/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
