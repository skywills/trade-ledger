# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install the pinned dependency tree, compile the TypeScript
# server and the Vite frontend, then prune dev dependencies. better-sqlite3
# compiles against this exact Debian/Node pair so the runtime artifact matches.
# ---------------------------------------------------------------------------
FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app

# Native build toolchain for better-sqlite3 when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src

# Produces dist/src/server (compiled backend + copied migrations) and dist/web.
RUN npm run build \
  && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage: copy ONLY runtime artifacts, production dependencies and the
# compiled migrations. No compiler, source tree, tests or credentials.
# ---------------------------------------------------------------------------
FROM node:22.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    ALLOWED_ORIGIN=http://localhost:3000 \
    UPLOAD_LIMIT_BYTES=20971520

WORKDIR /app

# The official Node image already provides the non-root `node` user at
# UID/GID 1000; reuse it rather than creating a conflicting account. Only
# /data needs to be writable; the app tree stays read-only to the process.
RUN mkdir -p /data \
  && chown -R node:node /data

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node

EXPOSE 3000
VOLUME ["/data"]

# Readiness is database-backed only: it never depends on an inference server.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/ready').then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/src/server/main.js"]
