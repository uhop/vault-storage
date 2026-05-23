# Multi-stage build: install deps once, ship a slim runtime image.
# Base must be Debian-flavored (not alpine) so onnxruntime-node and node:sqlite
# link cleanly against glibc.
FROM node:26-slim AS deps

WORKDIR /app

# Copy only manifests first so npm cache hits across builds when source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ----------------------------------------------------------------------
FROM node:26-slim AS runtime

# Tiny utilities for the healthcheck. `node:slim` is already minimal so this
# is a small additive — wget is ~150 KB, lets us avoid shipping a healthcheck
# binary or pulling curl.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates tini git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Set ownership at copy-time via --chown so the final RUN doesn't need to
# `chown -R` over /app/node_modules (thousands of onnxruntime/transformers
# files — measured at ~28s on a 4-core box).
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node static ./static
COPY --chown=node:node tsconfig.json ./

# `node:26-slim` ships with a `node` user (uid 1000, gid 1000). Reuse it instead
# of creating a custom one — covers the common host-uid case without conflict.
# Hosts that need a different uid override via compose `user: "<uid>:<gid>"`.
RUN mkdir -p /data /home/node/.cache/huggingface \
    && chown node:node /data /home/node/.cache /home/node/.cache/huggingface

USER node

ENV NODE_ENV=production \
    VAULT_DATA_PATH=/data \
    VAULT_HOST=0.0.0.0 \
    VAULT_PORT=8123 \
    VAULT_AUTO_REINDEX=true \
    VAULT_AUTO_WATCH=true \
    HF_HOME=/home/node/.cache/huggingface

EXPOSE 8123

# tini reaps zombies and forwards SIGTERM to node so graceful shutdown works.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.ts", "serve"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD wget -q -O - --header="Authorization: Bearer ${VAULT_API_TOKEN}" \
        http://127.0.0.1:${VAULT_PORT}/system/status || exit 1
