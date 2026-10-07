FROM tailscale/tailscale:v1.102.5@sha256:c507f3a2a6ab1cabd8d809b98edeb41edbd5c3fb6ad9632ffd098b4c7d0b4065 AS tailscale
FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600
RUN apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=10 update --error-on=any && apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=10 install -y --no-install-recommends python3 ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY sandbox/tailnet_gateway.py /opt/hm/tailnet_gateway.py
# Trusted fixed service only; no agent command interface or public SOCKS listener.
ENTRYPOINT ["python3", "/opt/hm/tailnet_gateway.py"]
CMD []
