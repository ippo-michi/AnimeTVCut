#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
META_PORT="${META_PORT:-18101}"
APP_PORT="${APP_PORT:-18102}"
FAILSOFT_APP_PORT="${FAILSOFT_APP_PORT:-18103}"
DEAD_META_PORT="${DEAD_META_PORT:-18199}"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT

cd "$root"

echo "==> Starting fake metadata Stremio addon on :$META_PORT"
FIXTURE_METADATA_PORT="$META_PORT" node scripts/fixture-metadata-addon.mjs &
pids+=("$!")

wait_for_http() {
  local url="$1"
  local tries=50
  while ! curl -fsS "$url" >/dev/null 2>&1; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      echo "FAIL: $url never became ready" >&2
      exit 1
    fi
    sleep 0.2
  done
}

wait_for_http "http://127.0.0.1:${META_PORT}/health"
echo "==> Metadata addon ready"

echo "==> Starting AnimeTVCut on :$APP_PORT against the live metadata addon"
METADATA_STREMIO_MANIFEST_URL="http://127.0.0.1:${META_PORT}/metadata/test-user/metadata-secret/manifest.json" \
PUBLIC_BASE_URL="http://127.0.0.1:${APP_PORT}/" \
PORT="$APP_PORT" HOST="127.0.0.1" \
AIOMETADATA_WATCH_TRACKING_ENABLED=false \
  ./node_modules/.bin/tsx apps/server/src/server.ts &
pids+=("$!")
wait_for_http "http://127.0.0.1:${APP_PORT}/health"
echo "==> AnimeTVCut ready"

status="$(curl -s -o /tmp/animetvcut-smoke-search.json -w "%{http_code}" \
  "http://127.0.0.1:${APP_PORT}/v2/catalog/series/animetvcut-v2/search=Synthetic.json")"
echo "search=Synthetic -> HTTP $status"
[ "$status" = "200" ] || { echo "FAIL: expected 200, got $status"; exit 1; }
grep -q '"atc:tv:' /tmp/animetvcut-smoke-search.json || { echo "FAIL: missing atc:tv: IDs"; exit 1; }
grep -q '"atc:season:' /tmp/animetvcut-smoke-search.json || { echo "FAIL: missing atc:season: IDs"; exit 1; }
grep -q '"atc:series:' /tmp/animetvcut-smoke-search.json || { echo "FAIL: missing atc:series: IDs"; exit 1; }
echo "==> search returned expanded atc: IDs OK"

status="$(curl -s -o /tmp/animetvcut-smoke-page.json -w "%{http_code}" \
  "http://127.0.0.1:${APP_PORT}/v2/catalog/series/animetvcut-v2/search=Synthetic&skip=300.json")"
echo "search=Synthetic&skip=300 -> HTTP $status"
[ "$status" = "200" ] || { echo "FAIL: expected 200, got $status"; exit 1; }
[ "$(cat /tmp/animetvcut-smoke-page.json)" = '{"metas":[]}' ] || {
  echo "FAIL: expected empty page"; exit 1; }
echo "==> skip=300 returned empty page OK"

echo "==> Starting AnimeTVCut on :$FAILSOFT_APP_PORT against an unreachable metadata addon"
METADATA_STREMIO_MANIFEST_URL="http://127.0.0.1:${DEAD_META_PORT}/metadata/test-user/metadata-secret/manifest.json" \
PUBLIC_BASE_URL="http://127.0.0.1:${FAILSOFT_APP_PORT}/" \
PORT="$FAILSOFT_APP_PORT" HOST="127.0.0.1" \
AIOMETADATA_WATCH_TRACKING_ENABLED=false \
  ./node_modules/.bin/tsx apps/server/src/server.ts &
pids+=("$!")
wait_for_http "http://127.0.0.1:${FAILSOFT_APP_PORT}/health"

status="$(curl -s -o /tmp/animetvcut-smoke-failsoft.json -w "%{http_code}" \
  "http://127.0.0.1:${FAILSOFT_APP_PORT}/v2/catalog/series/animetvcut-v2/search=Synthetic.json")"
echo "unreachable metadata -> HTTP $status"
[ "$status" = "200" ] || { echo "FAIL: expected 200, got $status"; exit 1; }
[ "$(cat /tmp/animetvcut-smoke-failsoft.json)" = '{"metas":[]}' ] || {
  echo "FAIL: expected empty metas for unreachable metadata"; exit 1; }
echo "==> fail-soft empty catalog OK"

echo
echo "SMOKE TEST PASSED: search returns results, pagination is bounded, and metadata failures stay at HTTP 200 {metas:[]}."
