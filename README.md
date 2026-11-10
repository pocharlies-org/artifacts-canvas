# artifacts-canvas

A shared, live drawing canvas on top of any published artifact (an HTML page): people annotate it together,
Miro-style, and the canvas keeps who drew what. It is the first plugin of
[`pocharlies-org/artifacts`](https://github.com/pocharlies-org/artifacts).

![The canvas over a sample artifact, three people annotating](docs/screenshots/desktop-1440x900.png)

- **The full toolset**: select / move / resize / rotate / marquee, hand and space-pan, freehand pen with
  pressure-like smoothing, highlighter, eraser, arrows that bind to shapes and follow them, line, text, sticky
  notes, rectangle, ellipse and 17 more shapes, frames, pasted or dropped images, and a laser pointer that is
  never stored. Style panel with 12 colours, fills, strokes (solid, dashed, dotted, sketchy), sizes, fonts,
  arrowheads, opacity, order, group and lock. Per-user undo, zoom, zoom to fit, minimap.
- **Live**: strokes appear on every screen while they are drawn; live cursors with names; presence avatars;
  *Presentar* (everyone follows the presenter) and *Seguir a* (follow one person).
- **Attribution**: every shape records who created and last edited it, and when. Name tags, a hover card, an
  authors panel with counts and a per-person show/hide toggle, and a history timeline. Attribution is stamped by
  the server from the verified identity, so it cannot be forged: a client that writes the attribution roots is
  disconnected (4403) and the write is not applied.
- **Isolation**: the artifact runs in a sandboxed, opaque-origin iframe (`sandbox="allow-scripts"`), unchanged; the
  drawings are anchored to its content and move with it.
- **Persistence**: one Yjs document per artifact, stored as a single S3/MinIO object under `_plugins/canvas/`,
  saved debounced and flushed on last leave. Canvas data never outlives the artifact (expiry + orphan sweep).
- **Export** to PNG and PDF, current view or the whole artifact.
- Spanish UI by default, English with `?lang=en` (or the server config).

This is a re-implementation of the behaviour of tools like tldraw, written from scratch. It contains no tldraw
code, assets or fonts. Runtime dependencies are MIT-licensed: [Yjs](https://github.com/yjs/yjs),
y-websocket, y-protocols, lib0, [perfect-freehand](https://github.com/steveruizok/perfect-freehand) and
[html-to-image](https://github.com/bubkoo/html-to-image).

## Layout

| Path | What |
|---|---|
| `shared/` | The single source of the wire protocol, the Yjs document model and the attribution stamper. Both sides import it (`@pocharlies/artifacts-canvas-shared`), so client and server cannot drift. |
| `client/` | The wrapper page: TypeScript + SVG, no framework, built with Vite. |
| `server/` | The canvas service: rooms, core authz, stamper enforcement, S3 persistence. |
| `dev/` | Local full-stack dev: the real server against a fake core authz and an in-memory S3 (`npm run dev`). |
| `chart/` | Helm chart for the service. |
| `docs/protocol.md` | The single authoritative protocol: routes, key chain, frame, WebSocket messages, attribution, document schema, authz contract, enforcement. |
| `docs/design.md` | Product decisions and design. |
| `docs/mockups/` | The approved UI mockup. |

## Quick start

Requires Node 22+.

```sh
npm install
npm run dev
```

`npm run dev` builds `shared` and `server`, then starts the **real server** against a fake core authz and an
in-memory S3, with the client in `vite build --watch`. It prints ready-to-open URLs: two browser windows as
`alice` and `bob` collaborate through the production code path (authz, stamper, persistence), and anonymous
visitors work on `pub/` keys. The dev core seeds the artifacts under `client/dev/artifacts/`.

For client-only work (no server): `npm run dev -w client` serves the client with an in-memory dev room
(`client/dev/yroom.ts`); open the same URL in two windows to collaborate, `?as=Your%20Name` to pick a
development identity, `?room=x` for a separate room, `?lang=en` for English.

```sh
npm run typecheck      # all workspaces
npm run test           # unit tests (vitest, client + server)
npx playwright install chromium
npm run e2e            # Playwright: client suite (dev stack) + server suite (real server + fake core + S3 mock)
npm run build          # shared/dist, client/dist (the bundle), server/dist
```

Keyboard: V select, H hand (or hold Space), D pen, ⇧D highlighter, E eraser, A arrow, L line, T text, N note,
R rectangle, O ellipse, F frame, K laser, ⌘Z / ⇧⌘Z undo/redo, ⌘A, ⌘D duplicate, ⌘G / ⇧⌘G group, ⇧L lock,
[ / ] back/front, ⇧1 zoom to fit, ⇧0 100%, Delete, Esc.

## Production: registering with the core

The canvas is a core plugin (design §8): the core answers *who may see this artifact* (`POST
/_gate/plugin/authz`), the canvas serves everything else under `/_canvas/`. See
[`docs/protocol.md`](docs/protocol.md) for the full contract.

1. **Create the canvas S3 user** (least privilege, scoped to the canvas prefix only): user `plugin-canvas`
   with `Get/Put/Delete/GetTagging/PutTagging` on `_plugins/canvas/*` and `ListBucket` on the prefix. Put its
   credentials in a Kubernetes secret named `plugin-canvas-s3` (the name the chart and the core entry default
   to): the core's bootstrap Job reads that secret to create/attach the user, and the canvas chart consumes the
   same one. The canvas never sees artifact data outside that prefix, and the core keeps its own users for reads.
2. **Register the plugin in the core's Helm values** (`pocharlies-org/artifacts` chart). The name must be a
   DNS-1123 label; the path is the plugin prefix the core links into:

   ```yaml
   plugins:
     - name: canvas
       path: /_canvas/
   ```

   The core then emits canvas links as `<read_base>/_canvas/<bucket>/<key>`; the canvas server accepts both
   that shape and `/_canvas/<key>` (the bucket segment is stripped — see the key chain in
   [`docs/protocol.md`](docs/protocol.md) §1.2).
3. **Install the canvas chart** ([`chart/`](chart)), pointing at the core:

   ```sh
   helm install canvas ./chart \
     --set core.gateAuthzUrl=http://artifacts-core:8081/_gate/plugin/authz \
     --set core.artifactBaseUrl=http://artifacts-core:8080 \
     --set s3.bucket=artifacts
   ```

   The chart ships the Deployment, Service, ConfigMap, ServiceAccount and a NetworkPolicy that allows ingress
   only from the ingress controller's namespace and the core's namespace.

## Configuration reference (server)

All values are environment variables; the chart maps them from `values.yaml`.

| Variable | Default | Meaning |
|---|---|---|
| `GATE_AUTHZ_URL` | — (required) | Core internal authz endpoint (`POST /_gate/plugin/authz`). |
| `ARTIFACT_BASE_URL` | — (required) | Internal base URL to fetch artifact HTML (frame route). |
| `S3_BUCKET` | — (required) | Bucket holding the artifacts and the canvas objects. |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Listen address. |
| `S3_ENDPOINT` | (AWS default) | S3-compatible endpoint (MinIO, etc.). |
| `S3_REGION` | `us-east-1` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | (SDK default chain) | The `plugin-canvas` credentials. |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style addressing (needed by MinIO). |
| `CANVAS_PREFIX` | `_plugins/canvas` | Prefix of the stored canvas objects (`<prefix>/<key>.ydoc`). |
| `AUTHZ_TIMEOUT_MS` | `3000` | Gate call timeout; anything late or wrong fails closed. |
| `AUTHZ_RECHECK_SECONDS` | `300` | Re-check interval per connection; on a deny the client is dropped (4403). |
| `FRAME_FETCH_TIMEOUT_MS` | `10000` | Artifact fetch for the frame route. |
| `STATIC_DIR` | `client/dist` | Built client bundle served under `/_canvas/_/`. |
| `CANVAS_INJECT_CONFIG` | `true` | Inject the wrapper config element (§2 of the protocol). |
| `SAVE_DEBOUNCE_MS` | `2000` | Persistence debounce (flushed on last leave and shutdown). |
| `SWEEP_INTERVAL_SECONDS` | `3600` | Orphan sweep: deletes canvas objects whose artifact is gone/expired. |
| `READYZ_CACHE_MS` | `5000` | `/readyz` caches the `HeadBucket` result. |
| `EXPIRED_REASONS` / `GONE_REASONS` | `expired` / `object-missing` | Gate reasons classified as expired/gone. |
| `ARTIFACT_PREFIXES` | (all) | Optional allowlist of artifact key prefixes the canvas serves. |
| `ANON_ALLOWED_PREFIXES` | `pub/` | Prefixes where anonymous access is accepted. |
| `MAX_CONNS_PER_ROOM` / `MAX_CONNS_PER_ROOM_ANON` / `MAX_CONNS_PER_ANON_VISITOR` | `50` / `10` / `2` | Room capacity (anon gets the stricter set); over capacity closes `1013`. |
| `MSG_RATE_PER_SEC` / `MSG_BURST` | `120` / `240` | Per-connection message rate → `4429`. |
| `ANON_MSG_RATE_PER_SEC` / `ANON_MSG_BURST` | `30` / `60` | Same for anonymous. |
| `MAX_DOC_BYTES` / `ANON_MAX_DOC_BYTES` | `20 MiB` / `5 MiB` | Document size limit → `4413`. |
| `MAX_MESSAGE_BYTES` / `ANON_MAX_MESSAGE_BYTES` | `8 MiB` / `2 MiB` | Message size limit → `4413`. |
| `MAX_IMAGE_BYTES` / `ANON_MAX_IMAGE_BYTES` | `2 MiB` / `1 MiB` | Announced to the client as its paste cap. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |

### Container image

```sh
docker build -f server/Dockerfile -t artifacts-canvas-server:dev .
```

The image builds all three workspaces from the root lockfile and runs `server/dist/index.js` as a non-root
user; the built client bundle ships as the static dir (`STATIC_DIR=/app/static`).

## License

Apache License 2.0. Copyright 2026 Daniel Ibáñez. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
