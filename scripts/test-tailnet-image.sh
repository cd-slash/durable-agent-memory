#!/usr/bin/env bash
set -euo pipefail
# Fake key, no networking and no agent code; zero Cloudflare/Tailscale calls.
image="${1:-hm-tailnet:test}"
container="hm-tailnet-image-test-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$container" --network none --cap-drop ALL --security-opt no-new-privileges \
  -e TAILSCALE_AUTH_KEY=tskey-auth-fixture -e HM_GATEWAY_TOKEN=fixture \
  -e 'HM_TAILNET_TARGETS=[{"name":"test","host":"test.example.ts.net","ports":[22],"sshUsers":["root"]}]' "$image" >/dev/null
for attempt in 1 2 3 4 5; do
  if docker exec "$container" python3 -c 'import json,urllib.request; r=urllib.request.urlopen("http://127.0.0.1:8080/health",timeout=1); assert json.load(r)=={"ready":False}' 2>/dev/null; then
    echo 'PASS: trusted image starts without Linux capabilities; fake-key health stays unenrolled with network disabled'
    exit 0
  fi
  sleep 1
done
echo 'FAIL: trusted image health unavailable' >&2
exit 1
