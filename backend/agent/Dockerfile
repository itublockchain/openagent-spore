# syntax=docker/dockerfile:1.7
# BuildKit features (cache mounts) require a syntax >= 1.4.

# ─── Base: Node + corepack-installed pnpm. Host doesn't need pnpm ──
FROM node:22-alpine AS base
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

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY shared/package.json ./shared/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY contracts/package.json ./contracts/
COPY frontend/package.json ./frontend/

# BuildKit cache mount → pnpm store survives across builds.
# --shamefully-hoist flattens deps so legacy CommonJS tools resolve.
RUN --mount=type=cache,id=swarm-pnpm-store,target=/pnpm-store,sharing=locked \
    pnpm install --no-frozen-lockfile --shamefully-hoist
RUN test -d node_modules && test -n "$(ls -A node_modules 2>/dev/null)" \
 || (echo "FATAL: pnpm install produced an empty node_modules" >&2 && exit 1)

# Cache-bust handle for parity with backend/api/Dockerfile. The agent
# image is tagged `swarm-agent:latest` (no version suffix), so Docker
# may try to reuse cached layers even when source has changed. Bumping
# CACHE_BUST in docker-compose.yml's agent.build.args invalidates this
# RUN line + everything after, forcing a fresh COPY + compile. Without
# this, a hot rebuild on Dokploy keeps shipping stale agent code while
# the API picks up new code via its versioned tag — exactly the split-
# brain failure mode that hid older MAX_RETRIES / planner-stake values
# in spawned containers long after their fixes had been merged.
ARG CACHE_BUST=dev
RUN echo "agent cache-bust=${CACHE_BUST}"

COPY . .

RUN pnpm --filter @swarm/contracts exec hardhat compile
RUN node_modules/.bin/tsc -p backend/shared-infra/tsconfig.json
RUN node_modules/.bin/tsc -p backend/agent/tsconfig.json

# ─── Runner: minimal image, no pnpm needed at runtime ─────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache ca-certificates wget
WORKDIR /app

# ════════════════════════════════════════════════════════════════
# BAKED-IN CONFIG — fresh-checkout works without a local .env file.
# Repo is public; same caveats as backend/api/Dockerfile apply (testnet
# wallet is a shared faucet key; web search degrades to DuckDuckGo
# when no Tavily/Brave key is provided in user .env).
# ════════════════════════════════════════════════════════════════
ENV NODE_ENV=development

# 0G Chain testnet
ENV OG_RPC_URL=https://evmrpc-testnet.0g.ai \
    OG_INDEXER_URL=https://indexer-storage-testnet-turbo.0g.ai \
    USE_ZG_STORAGE=true \
    STORAGE_FALLBACK=false \
    USE_L2=true

# AXL mesh — baseline agent identity. Spawned-on-deploy agents do NOT
# inherit this key because AgentRunner overrides AXL_PRIVATE_KEY per
# container with a freshly generated ed25519 seed; otherwise every
# spawned agent would share one yggdrasil identity and the mesh would
# refuse to peer them.
ENV AXL_NETWORK_ID=swarm-devnet \
    AXL_PEER=tcp://axl-seed:7000 \
    AXL_URL=http://localhost:9002 \
    AXL_PRIVATE_KEY=8c841708b49e5289e052bae960511ea073ff47620cb7cb92373a30130f9005835f531b6ed4e971d83f5b932cbdfc07a4bcde5432773307a6b99e9b127f0de81c

# L2 contract addresses load from contracts/deployments/og_testnet.json
# at runtime; these env vars are only the connection bits.
ENV OG_RPC_URL=https://evmrpc-testnet.0g.ai \
    L2_REQUIRED_CONFIRMATIONS=1 \
    L2_TX_TIMEOUT_MS=30000

# 0G Compute (central mode → routes through API proxy)
ENV ZG_COMPUTE_RPC_URL=https://evmrpc-testnet.0g.ai \
    ZG_COMPUTE_MODEL=qwen/qwen-2.5-7b-instruct \
    COMPUTE_MODE=central \
    COMPUTE_PROVIDER=0g

# Default agent identity — overridden per-container by the spawn flow.
ENV AGENT_ID=swarm-genesis \
    AGENT_PRIVATE_KEY=10c7172efc65e5dc6b3be55472935f8183e51a2019b540e6a54aa2b38b87b4dd \
    STAKE_AMOUNT=100 \
    USE_MOCK=false

# Web search keys NOT baked. tools/WebSearch.ts provider chain
# (Tavily → Brave → DuckDuckGo) falls through to DuckDuckGo when no
# keys are present. Set TAVILY_API_KEY / BRAVE_API_KEY in your local
# .env to upgrade quality. AgentRunner forwards whatever's in the host
# env to spawned agent containers, so .env values reach them too.

# Compose-network paths
ENV API_INTERNAL_URL=http://api:3001

COPY --from=axl-builder /app/axl-node .
COPY backend/agent/start.sh .
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/agent/dist ./
COPY --from=builder /app/backend/shared-infra/dist ./backend/shared-infra/dist
COPY --from=builder /app/backend/shared-infra/package.json ./backend/shared-infra/package.json
COPY --from=builder /app/backend/agent/package.json ./backend/agent/

ENTRYPOINT ["./start.sh"]
