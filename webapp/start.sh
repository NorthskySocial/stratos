#!/usr/bin/env bash
# Start the webapp with a Cloudflare quick tunnel for HTTPS.
#
# Starts the webapp and cloudflared, waits for the tunnel URL, and prints it.
#
# Usage:
#   ./start.sh                  # start
#   ./start.sh --build          # rebuild webapp image first
set -euo pipefail

cd "$(dirname "$0")"

BUILD_FLAG=""
if [[ "${1:-}" == "--build" ]]; then
  BUILD_FLAG="--build"
fi

echo "Starting webapp and cloudflared..."
docker compose up -d $BUILD_FLAG

# Wait for cloudflared to output its tunnel URL
echo "Waiting for Cloudflare tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(docker compose logs cloudflared 2>&1 \
    | grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1) || true
  if [[ -n "$TUNNEL_URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "ERROR: Failed to get tunnel URL after 30s"
  docker compose logs cloudflared
  exit 1
fi

echo ""
echo "=== Webapp running ==="
echo "Tunnel URL: $TUNNEL_URL"
echo ""
echo "Stop:"
echo "  docker compose down"
