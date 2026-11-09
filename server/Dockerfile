# syntax=docker/dockerfile:1
# Build from the repository root (needs both client/ and server/):
#   docker build -f server/Dockerfile -t artifacts-canvas-server .
#
# Both stages pin the same Node major. The runtime image runs as a non-root user
# with no writable filesystem paths other than /tmp (the app writes nothing).

# --- client bundle (vite) ---
FROM node:22-alpine AS client-build
WORKDIR /src
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci --no-audit --no-fund
COPY client/ ./client/
RUN cd client && npm run build

# --- server (tsc) ---
FROM node:22-alpine AS server-build
WORKDIR /src
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --no-audit --no-fund
COPY server/ ./server/
RUN cd server && npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:22-alpine AS runtime
# node:22-alpine ships a non-root "node" user (uid 1000).
USER node
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/static
COPY --chown=node:node --from=server-build /src/server/dist ./dist
COPY --chown=node:node --from=server-build /src/server/node_modules ./node_modules
COPY --chown=node:node --from=server-build /src/server/package.json ./package.json
COPY --chown=node:node --from=client-build /src/client/dist ./static
EXPOSE 8080
# No HEALTHCHECK: /healthz and /readyz are probed by the Helm chart.
ENTRYPOINT ["node", "dist/index.js"]
