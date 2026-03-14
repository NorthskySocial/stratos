FROM denoland/deno:latest AS builder
WORKDIR /app
COPY . .
RUN deno install
RUN deno cache src/bin/main.ts

FROM denoland/deno:latest
WORKDIR /app
COPY --from=builder /app .
COPY --from=builder /deno-dir /deno-dir
CMD ["deno", "run", "--allow-all", "--cached-only", "src/bin/main.ts"]
