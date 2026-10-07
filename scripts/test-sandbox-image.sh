#!/usr/bin/env bash
set -euo pipefail
# Local/Docker runner only. No Cloudflare calls, credentials or registry pushes.
docker build --tag hm-coding:test --file sandbox/Dockerfile .
docker run --rm --network none --memory 256m --cpus 0.0625 \
  --entrypoint python3 --mount "type=bind,src=$PWD/sandbox,dst=/checks,readonly" \
  hm-coding:test /checks/test_checkpoint.py
timeout 60s docker run --rm --network none --memory 256m --cpus 0.0625 --user 1000 \
  --entrypoint /bin/sh hm-coding:test -c \
  'cd /workspace && node --version && npm --version && python3 --version && git init --quiet . && git status --porcelain && printf source > proof.txt && test "$(cat proof.txt)" = source'
