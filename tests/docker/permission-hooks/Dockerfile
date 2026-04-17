FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash curl jq ca-certificates \
  && groupadd --system --gid 1001 hookrunner \
  && useradd --system --uid 1001 --gid 1001 --create-home --shell /usr/sbin/nologin hookrunner \
  && chown -R hookrunner:hookrunner /workspace 2>/dev/null || true \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY scripts /workspace/scripts
COPY tests/docker/permission-hooks /workspace/tests/docker/permission-hooks

RUN chown -R hookrunner:hookrunner /workspace

ENV PATH=/usr/local/bin:/usr/bin:/bin

USER hookrunner

CMD ["node", "/workspace/tests/docker/permission-hooks/run-hook-case.mjs"]
