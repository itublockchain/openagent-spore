# syntax=docker/dockerfile:1.7
# BuildKit features (cache mounts) require a syntax >= 1.4.

# ─── Base: Node + corepack-installed pnpm. Host doesn't need pnpm ──
FROM node:22-alpine AS base
# python3/make/g++/git: native deps for better-sqlite3 and friends.
# git: occasionally pulled by npm subdeps that ship as git+https://… refs.
RUN apk add --no-cache python3 make g++ git \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && pnpm config set store-dir /pnpm-store

# ─── AXL builder: Go binary used by the agent's start.sh ──────────
FROM golang:1.25-alpine AS axl-builder
WORKDIR /app
COPY axl/go.mod axl/go.sum ./
RUN go mod download
COPY axl/ ./
RUN go build -o axl-node ./cmd/node/

# ─── Builder: install workspace deps + compile TS ─────────────────
FROM base AS builder
WORKDIR /app

# Manifests first — Docker reuses the cached install layer until the
# lockfile or any package.json changes. Source code (COPY . .) lands
# in a later layer so editing TS files doesn't bust the install.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY shared/package.json ./shared/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY contracts/package.json ./contracts/
COPY frontend/package.json ./frontend/

# BuildKit cache mount so the pnpm content store survives across builds —
# zero-copy reuses for unchanged deps, ~10x faster reruns.
# --shamefully-hoist flattens to /app/node_modules so CommonJS tools
# (hardhat, typechain) resolve modules via the standard Node lookup.
# --no-frozen-lockfile lets a still-valid lockfile work while tolerating
# drift from a recent dep change that wasn't committed; switch to
# --frozen-lockfile in CI for strict determinism.
RUN --mount=type=cache,id=swarm-pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --no-frozen-lockfile --shamefully-hoist
# Hard sanity check — pnpm install must have populated node_modules.
# A silent no-op (corepack failure, lockfile corruption) used to slip
# through and only surface as "Cannot find module 'fastify'" at runtime.
RUN test -d node_modules && test -n "$(ls -A node_modules 2>/dev/null)" \
 || (echo "FATAL: pnpm install produced an empty node_modules" >&2 && exit 1)

# Cache-bust handle. Bump the CACHE_BUST value in docker-compose.yml
# (or pass --build-arg CACHE_BUST=...) to force the COPY/compile layers
# below to rebuild on the next `docker compose build`. Dokploy reuses
# build cache aggressively across redeploys; without a busted arg, a
# new commit's TS changes never reach the runner image.
ARG CACHE_BUST=dev
RUN echo "cache-bust=${CACHE_BUST}"

COPY . .

RUN pnpm --filter @swarm/contracts exec hardhat compile
RUN node_modules/.bin/tsc -p backend/shared-infra/tsconfig.json
RUN node_modules/.bin/tsc -p backend/api/tsconfig.json

# ─── Runner: minimal image, no pnpm needed at runtime ─────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache ca-certificates wget
WORKDIR /app

# ════════════════════════════════════════════════════════════════
# BAKED-IN CONFIG — fresh-checkout works without a local .env file.
#
# Repo is public; values below are visible to anyone with read access:
#   - testnet wallet (PRIVATE_KEY): pre-funded with 0G + mUSDC, intentionally
#     shared as a faucet-grade dev key. If anyone drains it, redeploy or
#     rotate — not a security boundary, just convenience.
#   - JWT_SECRET / MASTER_KEY: dev-grade. Rotate before pointing this image
#     at real users.
#   - Web search keys (Tavily / Brave) intentionally NOT baked. The
#     agent's WebSearch.ts chain falls back to DuckDuckGo when neither
#     is set, so search still works (lower-quality results). Provide
#     your own keys via .env to upgrade.
#   - OpenAI key was dropped entirely — compute routes through 0G's
#     central proxy (CentralComputeProxy → ZGComputeAdapter), no
#     openai SDK in the codebase.
# ════════════════════════════════════════════════════════════════
# Runtime + port
ENV NODE_ENV=development PORT=3001

# 0G Chain testnet
ENV OG_RPC_URL=https://evmrpc-testnet.0g.ai \
    OG_INDEXER_URL=https://indexer-storage-testnet-turbo.0g.ai \
    USE_ZG_STORAGE=true \
    STORAGE_FALLBACK=false \
    USE_L2=true

# AXL mesh — peer/url use compose-network DNS aliases (axl-seed).
# AXL_PRIVATE_KEY is the API node's stable yggdrasil ed25519 identity;
# baked so peer tables survive restarts. Different per-service so the
# three nodes (seed, api, agent) don't collide on the same identity.
ENV AXL_NETWORK_ID=swarm-devnet \
    AXL_PEER=tcp://axl-seed:7000 \
    AXL_URL=http://localhost:9002 \
    AXL_PRIVATE_KEY=c92b8d017e34839e4a3d2189c6b4685b8fd8ef2d28c2f2f1542e50d8e3e95ac5202233f04023712b7fadf3b978d929dbbc9716ffa13962654d615261852f7e59

# L2 / 0G contract addresses are loaded at runtime from
# contracts/deployments/og_testnet.json (and base_sepolia.json) — the
# baked deploy file IS the source of truth. Override individual
# addresses at runtime via L2_*_ADDRESS / BASE_*_ADDRESS env vars on
# the docker-compose service if you need to point at a non-default
# deployment.
ENV OG_RPC_URL=https://evmrpc-testnet.0g.ai \
    L2_REQUIRED_CONFIRMATIONS=1 \
    L2_TX_TIMEOUT_MS=30000 \
    BASE_RPC_URL=https://base-sepolia-rpc.publicnode.com \
    BASE_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
    BASE_GATEWAY_ADDRESS=0x409e4d7af7fc0641c8f070c79d13ecb94d91e443 \
    BRIDGE_STATE_DIR=/data

# New tokenless 0G contract addresses (override static-imported og_testnet.json).
ENV L2_TREASURY_ADDRESS=0x36b79557d2E364C84989b92EBcD74FD06ed6Bbbc \
    L2_ESCROW_ADDRESS=0x7384557b02Cc2D3dAbCa4458aaED28276Ba5345A \
    L2_DAG_REGISTRY_ADDRESS=0xb187cf541B337ac08D588C47C3073D5220fAC7BD \
    L2_SLASHING_VAULT_ADDRESS=0xd950E64a5e6c214957DdDD1eb0C267BA7423d5AD \
    L2_AGENT_REGISTRY_ADDRESS=0x3A90Ee31AB3D13682480F35F29b950dBa21aDe3e

# 0G Compute relay
ENV ZG_COMPUTE_RPC_URL=https://evmrpc-testnet.0g.ai \
    ZG_COMPUTE_MODEL=qwen/qwen-2.5-7b-instruct \
    COMPUTE_MODE=central

# Operator wallet — signs Treasury.spendOnBehalfOf + deploys agents.
ENV PRIVATE_KEY=10c7172efc65e5dc6b3be55472935f8183e51a2019b540e6a54aa2b38b87b4dd \
    L2_PRIVATE_KEY=10c7172efc65e5dc6b3be55472935f8183e51a2019b540e6a54aa2b38b87b4dd

# Auth + agent secret encryption
ENV JWT_SECRET=swarm-dev-secret-key-1234 \
    MASTER_KEY=1034c2bcb225e412b0b73e18f51de852ca4ebddfc87c79ce7c2cf8231dc38e02

# CORS
ENV CORS_ORIGINS=http://localhost:3000

# Web search keys (Tavily / Brave) intentionally NOT baked. Agent's
# WebSearch.ts provider chain falls through to DuckDuckGo (no key
# needed) when both are absent. Set TAVILY_API_KEY / BRAVE_API_KEY in
# your local .env (compose forwards optionally) to upgrade quality.

# Compose-network paths + persistent volume
ENV DOCKER_HOST=tcp://docker-proxy:2375 \
    DOCKER_SOCKET=/var/run/docker.sock \
    AGENT_SECRETS_PATH=/data/agent-secrets.json

# AXL node binary + startup script.
COPY --from=axl-builder /app/axl-node .
COPY backend/api/start.sh .
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/api/dist ./
COPY --from=builder /app/backend/shared-infra/dist ./backend/shared-infra/dist
COPY --from=builder /app/backend/shared-infra/package.json ./backend/shared-infra/package.json
COPY --from=builder /app/backend/api/package.json ./backend/api/

EXPOSE 3001
ENTRYPOINT ["./start.sh"]
