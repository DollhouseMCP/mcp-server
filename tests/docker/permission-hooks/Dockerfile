FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash curl jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY scripts /workspace/scripts
COPY tests/docker/permission-hooks /workspace/tests/docker/permission-hooks

CMD ["node", "/workspace/tests/docker/permission-hooks/run-hook-case.mjs"]
