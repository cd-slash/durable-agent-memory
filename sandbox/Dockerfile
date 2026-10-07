# Official managed-image source digest, pinned for reproducible base selection.
FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /opt/hm && chown 1000:1000 /workspace
COPY sandbox/checkpoint.py /opt/hm/checkpoint.py
RUN chmod 0555 /opt/hm/checkpoint.py
# Root PID 1 owns the fixed lifetime. Commands use non-root uid 1000 (node).
# Container controller overrides explicitly with this same entrypoint.
ENTRYPOINT ["/bin/sleep", "75"]
# Clear inherited Node CMD so the fixed entrypoint has no appended arguments.
CMD []
