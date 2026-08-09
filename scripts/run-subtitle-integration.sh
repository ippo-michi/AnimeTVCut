#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${project_root}/docker/compose.stremio-test.yaml"
cleanup() { docker compose -f "${compose_file}" down -v --remove-orphans; }
trap cleanup EXIT
cd "${project_root}"
pnpm fixtures:generate
docker compose -f "${compose_file}" up -d --wait
METADATA_STREMIO_TEST_MANIFEST_URL="http://127.0.0.1:19092/metadata/test-user/metadata-secret/manifest.json" \
UPSTREAM_TEST_MANIFEST_URL="http://127.0.0.1:18989/stremio/test-user/test-secret/manifest.json" \
MEDIAFLOW_TEST_URL="http://127.0.0.1:18888" \
  pnpm exec vitest run --config vitest.stremio.config.ts
