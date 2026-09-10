#!/usr/bin/env bash
set -euo pipefail

: "${BASE_URL:?Set BASE_URL, e.g. https://your-worker.workers.dev}"
: "${TRACKER_API_KEY:?Set TRACKER_API_KEY}"

command -v curl >/dev/null
command -v python3 >/dev/null

api() {
  curl -fsS "$@" -H "Authorization: Bearer ${TRACKER_API_KEY}" -H 'Content-Type: application/json'
}

echo '1/6 health'
curl -fsS "${BASE_URL}/health" | python3 -m json.tool

echo '2/6 create tracked email'
CREATE=$(api -X POST "${BASE_URL}/api/emails" -d '{"prospect_name":"Hexk Smoke Test","company_name":"MellowKraft","recipient_email":"test@example.com","subject":"Hexk smoke test","campaign":"smoke"}')
echo "$CREATE" | python3 -m json.tool
TRACKING_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["tracking_id"])' <<<"$CREATE")

echo '3/6 add tracked link + mark sent'
LINK=$(api -X POST "${BASE_URL}/api/emails/${TRACKING_ID}/links" -d '{"link_id":"example","destination_url":"https://example.com/","label":"Example"}')
echo "$LINK" | python3 -m json.tool
api -X POST "${BASE_URL}/api/emails/${TRACKING_ID}/sent" -d '{}' >/dev/null

echo '4/6 hit pixel twice'
curl -fsS -o /dev/null -A 'Mozilla/5.0 HexkSmokeBrowser' "${BASE_URL}/o/${TRACKING_ID}.gif"
sleep 1
curl -fsS -o /dev/null -A 'Mozilla/5.0 HexkSmokeBrowser' "${BASE_URL}/o/${TRACKING_ID}.gif"

echo '5/6 hit tracked link without following redirect'
TRACKED_URL=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["tracked_url"])' <<<"$LINK")
curl -fsS -o /dev/null -A 'Mozilla/5.0 HexkSmokeBrowser' "$TRACKED_URL"

echo '6/6 read resulting engagement'
sleep 1
DETAIL=$(api "${BASE_URL}/api/emails/${TRACKING_ID}")
echo "$DETAIL" | python3 -m json.tool

python3 - "$DETAIL" <<'PY'
import json, sys
j=json.loads(sys.argv[1])
e=j['email']
assert e['open_count'] >= 1, e
assert e['click_count'] >= 1, e
print('\nSmoke test passed:', e['tracking_id'], e['engagement']['label'])
PY
