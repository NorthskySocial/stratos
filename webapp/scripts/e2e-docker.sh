#!/usr/bin/env bash
#
# Runs the webapp Playwright e2e suite inside the official Playwright container
#
#
# Any arguments are forwarded to `playwright test`, e.g.
#   ./scripts/e2e-docker.sh --project=chromium
set -euo pipefail

# Keep this tag in sync with the @playwright/test version in package.json.
PLAYWRIGHT_VERSION="v1.60.0-noble"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}"

WEBAPP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${WEBAPP_DIR}/.." && pwd)"
COMPOSE_FILE="${WEBAPP_DIR}/docker-compose.e2e.yml"

# pnpm forwards the `--` separator itself as an argument (e.g.
# `pnpm run test:e2e:docker -- --project=chromium` arrives here as
# `-- --project=chromium`). Drop a single leading `--` so it is not passed to
# `playwright test`, where it would be treated as a test-file filter and match
# nothing ("No tests found").
if [ "${1:-}" = "--" ]; then
  shift
fi

cleanup() {
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting webapp dev server..."
docker compose -f "${COMPOSE_FILE}" up -d --wait

WEBAPP_CID="$(docker compose -f "${COMPOSE_FILE}" ps -q webapp)"
if [ -z "${WEBAPP_CID}" ]; then
  echo "Could not determine the webapp container id." >&2
  exit 1
fi

echo "Running Playwright e2e tests..."
# Run tests as host user (UID 1000) to avoid permission issues
set +e
docker run --rm --init --ipc=host \
  --network "container:${WEBAPP_CID}" \
  -v "${REPO_ROOT}:/workspace" \
  -w /workspace/webapp \
  -u "$(id -u):$(id -g)"  \
  -e E2E_BASE_URL="http://localhost:5173" \
  -e CI="${CI:-}" \
  "${PLAYWRIGHT_IMAGE}" \
  npx playwright test "$@"
exit_code=$?
set -e
if [ $exit_code -ne 0 ]; then
  echo "Playwright tests failed with exit code $exit_code" >&2
  exit $exit_code
fi
