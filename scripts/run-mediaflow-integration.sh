#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${project_root}/docker/compose.mediaflow-test.yaml"

cleanup() {
  local result=$?
  if (( result != 0 )); then
    docker compose -f "${compose_file}" logs --no-color --tail 250 || true
  fi
  docker compose -f "${compose_file}" down -v --remove-orphans
  return "${result}"
}
trap cleanup EXIT

cd "${project_root}"
pnpm fixtures:generate
docker compose -f "${compose_file}" up -d --wait
docker run --rm --entrypoint python \
  --volume "${project_root}/docker/mediaflow/tests:/tests:ro" \
  animetvcut-mediaflow:2.4.9-atc23-test -m unittest discover -s /tests
MEDIAFLOW_TEST_URL="http://127.0.0.1:18888" \
MEDIAFLOW_TEST_ORIGIN_URL="http://fixture-origin:8090" \
  pnpm exec vitest run --config vitest.mediaflow.config.ts
