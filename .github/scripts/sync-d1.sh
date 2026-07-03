#!/usr/bin/env bash
set -euo pipefail

# Sync search-index.json to D1 via the Worker admin sync endpoint.
# Requires: API_BASE_URL and WORKER_API_KEY secrets in GitHub Actions.

API_URL="${API_BASE_URL:-}"
API_KEY="${WORKER_API_KEY:-}"
INDEX_FILE="data/other-data-api/search-index.json"

if [ -z "$API_URL" ] || [ -z "$API_KEY" ]; then
  echo "::warning::API_BASE_URL or WORKER_API_KEY not set — skipping D1 sync."
  exit 0
fi

if [ ! -f "$INDEX_FILE" ]; then
  echo "::warning::$INDEX_FILE not found — skipping D1 sync."
  exit 0
fi

SYNC_URL="$(echo "$API_URL" | sed 's:/*$::')/api/admin/sync"

echo "[d1-sync] Syncing $(wc -c < "$INDEX_FILE") bytes to $SYNC_URL ..."

HTTP_CODE=$(curl -s -o /dev/stderr -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --data-binary "@$INDEX_FILE" \
  "$SYNC_URL" || true)

if [ "$HTTP_CODE" = "200" ]; then
  echo "[d1-sync] Sync succeeded."
  exit 0
elif [ -z "$HTTP_CODE" ] || [ "$HTTP_CODE" = "000" ]; then
  echo "::warning::[d1-sync] Request failed (no response). D1 may be out of sync."
  exit 0
else
  echo "::warning::[d1-sync] Sync responded HTTP $HTTP_CODE. D1 may be out of sync."
  exit 0
fi
