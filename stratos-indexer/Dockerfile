FROM denoland/deno:latest AS builder
WORKDIR /app
COPY . .
RUN deno install
RUN deno cache src/bin/main.ts

FROM denoland/deno:latest
WORKDIR /app
COPY --from=builder /app .
COPY --from=builder /deno-dir /deno-dir
ADD https://truststore.pki.rds.amazonaws.com/eu-central-1/eu-central-1-bundle.pem /usr/local/share/rds-combined-ca-bundle.pem
ENV DENO_CERT=/usr/local/share/rds-combined-ca-bundle.pem
CMD ["deno", "run", "--allow-all", "--cached-only", "--v8-flags=--max-old-space-size=7168", "src/bin/main.ts"]
