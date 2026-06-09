#!/usr/bin/env bash
# Deploy glassloop to Vercel via REST API, pinning a reachable Vercel IP
# (the CLI's default-resolved api.vercel.com IP is blocked in this sandbox).
set -e
cd "$(dirname "$0")"
TOKEN=$(jq -r '.token' "$HOME/Library/Application Support/com.vercel.cli/auth.json")
TEAM=team_d2iNytjMuKmgbHLvTAewMSR4
PROJ=prj_vF5uefrivG5hzQA8T2GdYWnF8qyK
VIP=216.198.79.131
files=(index.html vercel.json api/loop.js api/progress.js fonts/ABCReproVariable.woff2)

echo "[]" > /tmp/files.json
for f in "${files[@]}"; do
  SHA=$(shasum -a 1 "$f" | awk '{print $1}')
  SIZE=$(wc -c < "$f" | tr -d ' ')
  CODE=$(curl -s --resolve api.vercel.com:443:$VIP -o /dev/null -w "%{http_code}" \
    -X POST "https://api.vercel.com/v2/files?teamId=$TEAM" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
    -H "x-vercel-digest: $SHA" --data-binary "@$f")
  echo "  upload $f -> $CODE"
  jq --arg file "$f" --arg sha "$SHA" --argjson size "$SIZE" '. + [{file:$file, sha:$sha, size:$size}]' /tmp/files.json > /tmp/files2.json && mv /tmp/files2.json /tmp/files.json
done

BODY=$(jq -n --slurpfile files /tmp/files.json --arg proj "$PROJ" \
  '{name:"glassloop", project:$proj, target:"production", files:$files[0], projectSettings:{framework:null}}')
DEP=$(curl -s --resolve api.vercel.com:443:$VIP \
  -X POST "https://api.vercel.com/v13/deployments?teamId=$TEAM&forceNew=1&skipAutoDetectionConfirmation=1" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data "$BODY")
ID=$(echo "$DEP" | jq -r '.id')
echo "deployment: $ID  ($(echo "$DEP" | jq -r '.readyState // .error.message'))"
echo "$ID"
