FROM denoland/deno:latest AS builder
WORKDIR /app
COPY . .
RUN deno cache src/bin/main.ts

FROM denoland/deno:latest
WORKDIR /app
COPY --from=builder /app .
CMD ["deno", "run", "--allow-all", "src/bin/main.ts"]
