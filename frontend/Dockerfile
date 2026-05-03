# syntax=docker/dockerfile:1.7

# ─── 1. Build Arguments & Defaults ───
# API endpoints (override with: docker build --build-arg NEXT_PUBLIC_API_URL=https://...)
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws

# Network ID (0G Galileo = 16600, override for different network)
ARG NEXT_PUBLIC_NETWORK_ID=16600

# Reown/Walletconnect Project ID (get from https://cloud.reown.com)
ARG NEXT_PUBLIC_REOWN_PROJECT_ID=""

# Contract addresses (MUST provide during build or via docker-compose env)
ARG NEXT_PUBLIC_USDC_ADDRESS=""
ARG NEXT_PUBLIC_ESCROW_ADDRESS=""
ARG NEXT_PUBLIC_TREASURY_ADDRESS=""
ARG NEXT_PUBLIC_GATEWAY_ADDRESS=""
ARG NEXT_PUBLIC_CCTP_RECEIVER_ADDRESS=""

# Per-chain RPC overrides (Base / ETH / Arb Sepolia). Optional — wagmi
# falls back to publicnode.com when these are empty, but that endpoint
# rate-limits aggressively under user load and surfaces as a confusing
# "contract function reverted: Request is being rate limited" error in
# the deposit flow. Setting these to a paid Alchemy/Infura endpoint
# eliminates the false-revert symptom. Compose passes the values from
# .env / Dokploy env at build time; without these ARG declarations the
# values were silently dropped before this fix.
ARG NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=""
ARG NEXT_PUBLIC_ETH_SEPOLIA_RPC_URL=""
ARG NEXT_PUBLIC_ARB_SEPOLIA_RPC_URL=""

# Cache-bust handle (global ARG only — RUN goes inside the builder
# stage below, since RUN before any FROM is invalid in multi-stage
# Dockerfiles). Bump CACHE_BUST in docker-compose.yml's frontend
# args block (and the matching image tag) to force a full rebuild
# of the COPY+next-build layers. Without this, a redeploy that only
# changes NEXT_PUBLIC_* env values reuses cached layers and ships an
# old bundle — exactly the failure mode that left publicnode.com
# baked into the wagmi transport even after Alchemy URLs were set.
ARG CACHE_BUST=dev

# ─── 2. Validation Stage ───
FROM node:22-alpine AS validate
ARG NEXT_PUBLIC_REOWN_PROJECT_ID
ARG NEXT_PUBLIC_USDC_ADDRESS
ARG NEXT_PUBLIC_ESCROW_ADDRESS
ARG NEXT_PUBLIC_TREASURY_ADDRESS

RUN if [ -z "$NEXT_PUBLIC_REOWN_PROJECT_ID" ]; then \
      echo "⚠️ WARNING: NEXT_PUBLIC_REOWN_PROJECT_ID not provided. Wallet connection may fail."; \
    fi && \
    if [ -z "$NEXT_PUBLIC_USDC_ADDRESS" ]; then \
      echo "⚠️ WARNING: NEXT_PUBLIC_USDC_ADDRESS is empty."; \
    fi

# ─── 3. Base Image ───
FROM node:22-alpine AS base
RUN apk add --no-cache python3 make g++ git \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && pnpm config set store-dir /pnpm-store

# ─── 4. Builder Stage ───
FROM base AS builder
WORKDIR /app

# Re-declare ARGs in this stage so they are available
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_NETWORK_ID
ARG NEXT_PUBLIC_REOWN_PROJECT_ID
ARG NEXT_PUBLIC_USDC_ADDRESS
ARG NEXT_PUBLIC_ESCROW_ADDRESS
ARG NEXT_PUBLIC_TREASURY_ADDRESS
ARG NEXT_PUBLIC_GATEWAY_ADDRESS
ARG NEXT_PUBLIC_CCTP_RECEIVER_ADDRESS
ARG NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
ARG NEXT_PUBLIC_ETH_SEPOLIA_RPC_URL
ARG NEXT_PUBLIC_ARB_SEPOLIA_RPC_URL
ARG CACHE_BUST=dev
RUN echo "frontend builder cache-bust=${CACHE_BUST}"

# Next.js bakes these into the JS bundle at BUILD TIME
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_NETWORK_ID=$NEXT_PUBLIC_NETWORK_ID \
    NEXT_PUBLIC_REOWN_PROJECT_ID=$NEXT_PUBLIC_REOWN_PROJECT_ID \
    NEXT_PUBLIC_USDC_ADDRESS=$NEXT_PUBLIC_USDC_ADDRESS \
    NEXT_PUBLIC_ESCROW_ADDRESS=$NEXT_PUBLIC_ESCROW_ADDRESS \
    NEXT_PUBLIC_TREASURY_ADDRESS=$NEXT_PUBLIC_TREASURY_ADDRESS \
    NEXT_PUBLIC_GATEWAY_ADDRESS=$NEXT_PUBLIC_GATEWAY_ADDRESS \
    NEXT_PUBLIC_CCTP_RECEIVER_ADDRESS=$NEXT_PUBLIC_CCTP_RECEIVER_ADDRESS \
    NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=$NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL \
    NEXT_PUBLIC_ETH_SEPOLIA_RPC_URL=$NEXT_PUBLIC_ETH_SEPOLIA_RPC_URL \
    NEXT_PUBLIC_ARB_SEPOLIA_RPC_URL=$NEXT_PUBLIC_ARB_SEPOLIA_RPC_URL

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY frontend/package.json ./frontend/
COPY backend/api/package.json ./backend/api/
COPY backend/agent/package.json ./backend/agent/
COPY shared/package.json ./shared/
COPY backend/shared-infra/package.json ./backend/shared-infra/
COPY contracts/package.json ./contracts/

RUN --mount=type=cache,id=swarm-pnpm-store-v2,target=/pnpm-store,sharing=locked \
    pnpm install --no-frozen-lockfile --shamefully-hoist

COPY . .
RUN pnpm --filter frontend build

# ─── 5. Runner Stage ───
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/frontend/package.json ./frontend/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/next.config.ts ./frontend/

# Runtime environment variables (can be overridden at runtime)
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL} \
    NEXT_PUBLIC_NETWORK_ID=${NEXT_PUBLIC_NETWORK_ID} \
    NEXT_PUBLIC_REOWN_PROJECT_ID=${NEXT_PUBLIC_REOWN_PROJECT_ID} \
    NEXT_PUBLIC_USDC_ADDRESS=${NEXT_PUBLIC_USDC_ADDRESS} \
    NEXT_PUBLIC_ESCROW_ADDRESS=${NEXT_PUBLIC_ESCROW_ADDRESS} \
    NEXT_PUBLIC_TREASURY_ADDRESS=${NEXT_PUBLIC_TREASURY_ADDRESS} \
    NEXT_PUBLIC_GATEWAY_ADDRESS=${NEXT_PUBLIC_GATEWAY_ADDRESS} \
    NEXT_PUBLIC_CCTP_RECEIVER_ADDRESS=${NEXT_PUBLIC_CCTP_RECEIVER_ADDRESS}

EXPOSE 3000
CMD ["pnpm", "--filter", "frontend", "start"]
COPY --from=builder /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/next.config.ts ./frontend/

EXPOSE 3000
CMD ["pnpm", "--filter", "frontend", "start"]
