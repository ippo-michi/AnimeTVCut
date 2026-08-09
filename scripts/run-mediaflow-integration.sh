#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${project_root}/docker/compose.mediaflow-test.yaml"

cleanup() {
  docker compose -f "${compose_file}" down -v --remove-orphans
}
trap cleanup EXIT

cd "${project_root}"
pnpm fixtures:generate
docker compose -f "${compose_file}" up -d --wait
MEDIAFLOW_TEST_URL="http://127.0.0.1:18888" \
MEDIAFLOW_TEST_ORIGIN_URL="http://fixture-origin:8090" \
  pnpm exec vitest run --config vitest.mediaflow.config.ts
