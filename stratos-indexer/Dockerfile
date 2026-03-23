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
CMD ["sh", "-c", "\
  if [ -n \"$MEM_LIMIT\" ]; then \
    HEAP_SIZE=$MEM_LIMIT; \
  else \
    if [ -f /sys/fs/cgroup/memory.max ] && [ \"$(cat /sys/fs/cgroup/memory.max)\" != 'max' ]; then \
      MEM_BYTES=$(cat /sys/fs/cgroup/memory.max); \
    elif [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then \
      MEM_BYTES=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes); \
    else \
      MEM_BYTES=$(awk '/MemTotal/{print $2 * 1024}' /proc/meminfo); \
    fi && \
    HEAP_SIZE=$((MEM_BYTES * 80 / 100 / 1024 / 1024)); \
  fi && \
  echo \"v8 heap: ${HEAP_SIZE}MB\" && \
  exec deno run --allow-all --cached-only --v8-flags=--max-old-space-size=$HEAP_SIZE src/bin/main.ts"]
