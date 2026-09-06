# Clubhouse production image.
#
# Build from the workspace root because Clubhouse consumes the workspace-local
# stratos-browser and stratos-client packages:
#   docker build -f clubhouse/Dockerfile -t clubhouse .
FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Keep dependency installation cacheable while retaining the workspace graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY stratos-core/package.json ./stratos-core/
COPY stratos-client/package.json ./stratos-client/
COPY stratos-browser/package.json ./stratos-browser/
COPY clubhouse/package.json ./clubhouse/

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY lexicons/ ./lexicons/
COPY lexicons-spaces/ ./lexicons-spaces/
COPY stratos-core/ ./stratos-core/
COPY stratos-client/ ./stratos-client/
COPY stratos-browser/ ./stratos-browser/
COPY clubhouse/ ./clubhouse/

# `VITE_*` values are compile-time public configuration. Supply them with
# Docker build args (the accompanying Compose file does this).
ARG VITE_STRATOS_URL
ARG VITE_STRATOS_SERVICE_DID
ARG VITE_FEEDGEN_URL
ARG VITE_FEEDGEN_DID
ARG VITE_CLUBHOUSE_URL
ARG VITE_CLUBHOUSE_ROOM_STATUS_URL
ARG VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON
ARG VITE_ATPROTO_HANDLE_RESOLVER
ARG VITE_ATPROTO_OAUTH_PROXY_URL
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_ENVIRONMENT
ARG VITE_SENTRY_RELEASE
ARG VITE_SENTRY_TRACES_SAMPLE_RATE

ENV VITE_STRATOS_URL=${VITE_STRATOS_URL}
ENV VITE_STRATOS_SERVICE_DID=${VITE_STRATOS_SERVICE_DID}
ENV VITE_FEEDGEN_URL=${VITE_FEEDGEN_URL}
ENV VITE_FEEDGEN_DID=${VITE_FEEDGEN_DID}
ENV VITE_CLUBHOUSE_URL=${VITE_CLUBHOUSE_URL}
ENV VITE_CLUBHOUSE_ROOM_STATUS_URL=${VITE_CLUBHOUSE_ROOM_STATUS_URL}
ENV VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON=${VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON}
ENV VITE_ATPROTO_HANDLE_RESOLVER=${VITE_ATPROTO_HANDLE_RESOLVER}
ENV VITE_ATPROTO_OAUTH_PROXY_URL=${VITE_ATPROTO_OAUTH_PROXY_URL}
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
ENV VITE_SENTRY_ENVIRONMENT=${VITE_SENTRY_ENVIRONMENT}
ENV VITE_SENTRY_RELEASE=${VITE_SENTRY_RELEASE}
ENV VITE_SENTRY_TRACES_SAMPLE_RATE=${VITE_SENTRY_TRACES_SAMPLE_RATE}

RUN pnpm --filter @northskysocial/stratos-client build \
    && pnpm --filter @northskysocial/stratos-browser build \
    && pnpm --filter @northskysocial/clubhouse build

# OAuth servers fetch this document from the public client ID. Its scope must
# exactly match the scopes constructed in src/lib/auth.ts.
RUN node -e "\
  const fs = require('node:fs'); \
  const required = ['VITE_STRATOS_URL', 'VITE_STRATOS_SERVICE_DID', 'VITE_FEEDGEN_URL', 'VITE_FEEDGEN_DID', 'VITE_CLUBHOUSE_URL']; \
  for (const name of required) { if (!process.env[name]) throw new Error(name + ' is required for a production Clubhouse build'); } \
  for (const name of ['VITE_STRATOS_SERVICE_DID', 'VITE_FEEDGEN_DID']) { if (!process.env[name].startsWith('did:')) throw new Error(name + ' must be a DID, not a URL'); } \
  const baseUrl = process.env.VITE_CLUBHOUSE_URL.replace(/\\/+$/, ''); \
  const scope = [ \
    'atproto', \
    'repo:zone.stratos.actor.enrollment', \
    'repo:zone.stratos.feed.post', \
    'rpc:zone.stratos.feedgen.getFeed?aud=*', \
    'space:zone.stratos.space.feed?authority=' + encodeURIComponent(process.env.VITE_STRATOS_SERVICE_DID) + '&collection=zone.stratos.feed.post&action=read&action=create&action=update&action=delete', \
  ].join(' '); \
  fs.writeFileSync('clubhouse/dist/client-metadata.json', JSON.stringify({ \
    client_id: baseUrl + '/client-metadata.json', \
    client_name: 'Clubhouse', \
    client_uri: baseUrl, \
    redirect_uris: [baseUrl + '/'], \
    scope, \
    grant_types: ['authorization_code', 'refresh_token'], \
    response_types: ['code'], \
    token_endpoint_auth_method: 'none', \
    application_type: 'web', \
    dpop_bound_access_tokens: true, \
  }, null, 2) + '\\n'); \
"

FROM nginx:1.29-alpine AS clubhouse

COPY clubhouse/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/clubhouse/dist/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
