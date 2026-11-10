# syntax=docker/dockerfile:1
# Build from the repository root (npm workspaces: shared/ + client/ + server/, one lockfile):
#   docker build -f server/Dockerfile -t artifacts-canvas-server .
#
# One build stage: `npm ci` from the root lockfile, then the root `npm run build`
# (shared → client → server) and `npm prune --omit=dev`. The runtime keeps the workspace
# layout because server imports @pocharlies/artifacts-canvas-shared through the root
# node_modules symlink (node_modules/@pocharlies/... -> ../../shared), so /app/shared must
# exist next to /app/node_modules. The runtime image runs as a non-root user and the app
# writes nothing (documents go to S3).

FROM node:22-alpine AS build
WORKDIR /src
# shared/ is copied whole BEFORE `npm ci` because its `prepare` lifecycle script builds
# dist/ during install (that is what lets client/server import it right after a fresh
# clone) — `npm ci` would fail on a package.json-only copy.
COPY package.json package-lock.json ./
COPY shared/ ./shared/
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci --no-audit --no-fund
COPY client/ ./client/
COPY server/ ./server/
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
# node:22-alpine ships a non-root "node" user (uid 1000).
USER node
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/static
COPY --chown=node:node --from=build /src/node_modules ./node_modules
COPY --chown=node:node --from=build /src/shared/package.json ./shared/package.json
COPY --chown=node:node --from=build /src/shared/dist ./shared/dist
COPY --chown=node:node --from=build /src/server/package.json ./server/package.json
COPY --chown=node:node --from=build /src/server/dist ./server/dist
COPY --chown=node:node --from=build /src/client/dist ./static
EXPOSE 8080
# No HEALTHCHECK: /healthz and /readyz are probed by the Helm chart.
ENTRYPOINT ["node", "server/dist/index.js"]
