# artifacts-canvas server

Collaborative annotation canvas for published artifacts: y-websocket rooms per artifact,
core-gate authorization, Yjs documents persisted as single S3/MinIO objects, Helm chart.
Apache-2.0. The single authoritative protocol — wire contract, core authz contract and the
server-side enforcement — is [`docs/protocol.md`](../docs/protocol.md).

## What it does

- One room per artifact key, speaking the stock **y-websocket** protocol (sync + awareness)
  plus two canvas messages: `IDENTITY (100)`, sent first and built only from the core's authz
  answer, and `NOTICE (101)`.
- **AuthZ on connect and every re-check** against the core's internal
  `POST /_gate/plugin/authz` — body `{"artifact": "/artifacts/<key>"}`, the visitor's cookie and
  `Authorization` header forwarded verbatim (the gate accepts either). Anything other than a
  well-formed `allowed: true` denies (fail-closed). Anonymous is accepted only inside `pub/`
  (configurable). Both link shapes `/_canvas/<bucket>/<key>` (what the core emits) and
  `/_canvas/<key>` resolve to the same artifact key.
- **Persistence**: the Yjs doc is one object, `_plugins/canvas/<artifact key>.ydoc`, with the
  artifact's `ttl` copied on as an S3 tag. Load on first join, debounced save, flush on last
  leave / shutdown. Survives restarts.
- **Expiry**: when the core says the artifact is gone/expired, the room is refused or dropped
  and the canvas object is deleted; a periodic sweep cleans orphans.
- **Server-stamped attribution** using the client's shared stamper: `attribution`, `users` and
  `history` are written by the server only; a client write to those roots closes the connection
  (`4403`) and is not applied.
- Abuse limits (rate, message size, document size, room capacity), stricter for anonymous.
- `/healthz`, `/readyz` on the public listener; Prometheus `/metrics` on a separate internal
  listener (`METRICS_PORT`, default 9091); structured pino logs.

## Requirements

Node.js ≥ 22. The client bundle (built `client/dist`) must be reachable via `STATIC_DIR`.

## Run

```bash
npm ci
npm run build          # tsc → dist/
GATE_AUTHZ_URL=http://core:8081/_gate/plugin/authz \
ARTIFACT_BASE_URL=http://core:8080 \
S3_BUCKET=artifacts \
npm start
```

Dev (no build): `npm run dev`. Tests: `npm test` (unit + integration against a fake core and
an in-memory object store; the S3 store is covered against s3rver — no Docker needed).

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `GATE_AUTHZ_URL` | — (required) | Core internal authz endpoint, full URL. |
| `ARTIFACT_BASE_URL` | — (required) | Internal base URL to fetch artifact HTML for the frame route. |
| `S3_BUCKET` | — (required) | Bucket holding `_plugins/canvas/…`. |
| `S3_ENDPOINT` | — | MinIO/S3-compatible endpoint; omit for AWS. |
| `S3_REGION` | `us-east-1` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — (else ambient credentials) | Scope to the `_plugins/canvas/` prefix. |
| `S3_FORCE_PATH_STYLE` | `true` | |
| `CANVAS_PREFIX` | `_plugins/canvas` | Object prefix (trailing `/` tolerated). |
| `STATIC_DIR` | `../client/dist` | Built client bundle. |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | |
| `AUTHZ_TIMEOUT_MS` | `3000` | |
| `AUTHZ_RECHECK_SECONDS` | `300` | Mid-session revocation/expiry latency bound. |
| `FRAME_FETCH_TIMEOUT_MS` | `10000` | |
| `SAVE_DEBOUNCE_MS` | `2000` | |
| `SWEEP_INTERVAL_SECONDS` | `3600` | Orphan sweep cadence. |
| `READYZ_CACHE_MS` | `5000` | |
| `MAX_CONNS_PER_ROOM` / `MAX_CONNS_PER_ROOM_ANON` / `MAX_CONNS_PER_ANON_VISITOR` | `50` / `10` / `2` | Over capacity → close `1013`. |
| `MSG_RATE_PER_SEC` / `MSG_BURST` | `120` / `240` | Over → NOTICE + `4429`. |
| `ANON_MSG_RATE_PER_SEC` / `ANON_MSG_BURST` | `30` / `60` | |
| `MAX_DOC_BYTES` / `ANON_MAX_DOC_BYTES` | `5 MiB` / `1.25 MiB` | An update that would grow the doc past the sender's cap → NOTICE + `4413` for that connection only. Lowered at start (warning) to what one share of the room memory budget holds. |
| `MAX_MESSAGE_BYTES` / `ANON_MAX_MESSAGE_BYTES` | `4 MiB` / `1 MiB` | Never above the room caps. A message longer than the larger + 64 KiB closes `1009` unread. |
| `WS_INCOMING_TIMEOUT_MS` / `WS_INCOMING_MIN_BYTES_PER_SEC` | `30000` / `32768` | Deadline of an unfinished message (a frame or fragments without the last one): the first + its bytes at the second, then the connection is dropped. |
| `MAX_IMAGE_BYTES` / `ANON_MAX_IMAGE_BYTES` | `2 MiB` / `512 KiB` | Advertised to the client in the wrapper config (at most 70% of the message cap). The wrapper also advertises the visitor's room cap, so the editor says the canvas is full before the server would refuse an image. |
| `MAX_SPLITS_PER_MESSAGE` | `5000` | Cuts of items one update may make (inserts or deletes inside an item, origins of structs the room has): each is a struct of its own in the stored room and costs Yjs a copy of the item. Over → NOTICE + `4413` for that connection. |
| `MAX_APPLY_MS` | `50` | Yjs time the cuts and placement scans of one update may take, by the server's estimate (costs measured on x86, `config.ts`). Over → NOTICE + `4413`. The whole apply is also charged to the CPU budgets before it runs: an update they cannot cover → NOTICE `busy` + `1013`. |
| `ARTIFACT_PREFIXES` | *(any valid key)* | Optional key-space allowlist (comma separated). |
| `ANON_ENABLED` | `true` (chart: `false`) | Anonymous drawing. `false`: a visitor without credentials is refused before the core is asked, and any anonymous answer of the core too, whatever `ANON_ALLOWED_PREFIXES` holds. |
| `ANON_ALLOWED_PREFIXES` | `pub/` | With `ANON_ENABLED`, anonymous is only ever accepted here (a list with no prefix: nowhere). |
| `EXPIRED_REASONS` / `GONE_REASONS` | `expired` / `object-missing` | Authz `reason` values (core gate vocabulary) treated as expired / gone. |
| `ALLOWED_ORIGINS` | origin of `ARTIFACT_BASE_URL` | Comma-separated browser origins (`scheme://host[:port]`) allowed to open the WebSocket; missing/`null`/foreign Origin → `4403`. |
| `METRICS_PORT` / `METRICS_HOST` | `9091` / `0.0.0.0` | Internal Prometheus listener (`/metrics` only); `0` disables it. Never routed publicly. |
| `ANON_COOKIE_SECRET` | *(random per process)* | Signs the anonymous-visitor cookie (server-assigned pseudonyms). |
| `CANVAS_INJECT_CONFIG` | `true` | Inject the wrapper config element. |
| `LOG_LEVEL` | `info` | pino level. |

## Container

`server/Dockerfile` builds the client bundle and the server from the repository root:

```bash
docker build -f server/Dockerfile -t artifacts-canvas:dev .
```

The image runs as the numeric uid/gid 1000:1000, read-only friendly (writes nothing). Published images,
provenance verification and the smoke test: the root README, [Image](../README.md#image).

## Deployment

The Helm chart lives at [`../chart`](../chart). It renders a single-replica Deployment
(rooms are in-memory; scale-out with sticky routing is a documented later step), a NetworkPolicy
that admits only the ingress controller and the core's gate, and a NOTES.txt showing how to
register the plugin in the core chart's `plugins:` list.
