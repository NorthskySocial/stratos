FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY webapp/package.json ./webapp/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install only webapp dependencies
RUN pnpm install --frozen-lockfile --filter @northskysocial/stratos-webapp...

COPY webapp/ ./webapp/

ARG VITE_STRATOS_URL
ENV VITE_STRATOS_URL=${VITE_STRATOS_URL}

ARG VITE_WEBAPP_URL
ENV VITE_WEBAPP_URL=${VITE_WEBAPP_URL}

WORKDIR /app/webapp
RUN pnpm build

# Generate client-metadata.json for OAuth discovery
RUN printf '{"client_id":"%s/client-metadata.json","client_name":"Stratos","client_uri":"%s","redirect_uris":["%s/"],"scope":"atproto transition:generic","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"web","dpop_bound_access_tokens":true}\n' \
  "$VITE_WEBAPP_URL" "$VITE_WEBAPP_URL" "$VITE_WEBAPP_URL" > dist/client-metadata.json

FROM nginx:alpine

COPY --from=build /app/webapp/dist /usr/share/nginx/html
COPY webapp/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
