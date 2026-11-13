# artifacts-canvas server image: the built server, the shared package and the client bundle on a
# digest-pinned Node base. Build from the repository root (npm workspaces: shared/ + client/ +
# server/, one lockfile; the root .dockerignore is an allow-list that keeps tests, e2e, git and
# node_modules out of the context):
#   docker build -f server/Dockerfile --build-arg REVISION="$(git rev-parse HEAD)" -t artifacts-canvas-server:dev .
# Run as the numeric non-root user below; the server writes nothing (documents go to S3), so a
# read-only root filesystem with a writable /tmp works (the Helm chart runs it that way).
# Published images: .github/workflows/publish.yml (README, "Image"). Smoke test: tests/image_smoke.sh.
#
# Both stages use the same node:22-alpine, pinned by its multi-platform index digest
# (node v22.23.5 on Alpine 3.24.4, resolved 2026-11-13). Bump both lines together.

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /src
# `npm ci` from the root lockfile is the only network fetch of the build. shared/ is copied whole
# BEFORE it because its `prepare` lifecycle script builds dist/ during install (that is what lets
# client/server import it right after a fresh clone): a package.json-only copy would fail.
COPY package.json package-lock.json ./
COPY shared/ ./shared/
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci --no-audit --no-fund
COPY client/ ./client/
COPY server/ ./server/
# The root build (shared -> client -> server), then drop the dev dependencies offline.
RUN npm run build && npm prune --omit=dev --offline --no-audit --no-fund

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime

# REVISION is the 40-hex commit the image is built from; the publish workflow sets it.
ARG REVISION=""
ARG SOURCE="https://github.com/pocharlies-org/artifacts-canvas"
LABEL org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.title="artifacts-canvas-server" \
      org.opencontainers.image.description="artifacts-canvas: collaborative annotation canvas server, a plugin of the artifacts core" \
      org.opencontainers.image.licenses="Apache-2.0"

# The runtime needs only node: no package manager (npm, npx, corepack, yarn) stays in the image.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg

# No --max-old-space-size here or in NODE_OPTIONS: the server refuses to start with it (it would
# override every room worker's heap limit); size the process with HEAP_LIMIT_MB.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/static

# Root-owned (COPY's default) and not writable by the runtime user: it can read the code, never
# change it. The runtime keeps the workspace layout because server imports
# @pocharlies/artifacts-canvas-shared through the root node_modules symlink
# (node_modules/@pocharlies/... -> ../../shared), so /app/shared must exist next to /app/node_modules.
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/shared/package.json ./shared/package.json
COPY --from=build /src/shared/dist ./shared/dist
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/client/dist ./static

# Numeric uid/gid (`node` in the base image), so Kubernetes runAsNonRoot can verify it; the chart
# runs the pod as 1000:1000.
USER 1000:1000

EXPOSE 8080
# No HEALTHCHECK: /healthz and /readyz are probed by the Helm chart (compose has its own check).
ENTRYPOINT ["node", "server/dist/index.js"]
