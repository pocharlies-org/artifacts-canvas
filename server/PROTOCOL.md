# artifacts-canvas — server protocol notes

This file documents the **server side** of the protocol. The authoritative wire contract is
[`docs/protocol.md`](../docs/protocol.md) in the client tree; where the two differ, that one
wins. This document adds what only the server sees: the core plugin contract (authz, storage,
expiry) and the exact enforcement the server applies.

## 1. Routes (served under `/_canvas`)

| Route | Authz | Notes |
|---|---|---|
| `GET /_canvas/<artifact key>` | yes | Wrapper: client `index.html` + injected `<script type="application/json" id="artifacts-canvas-config">` (`artifactPath`, `dev:false`, `maxImageBytes`). CSP `default-src 'self'; frame-ancestors 'self'`, `Referrer-Policy: no-referrer`, `nosniff`, `no-store`. |
| `GET /_canvas/_/frame/<artifact key>` | yes | Artifact HTML fetched from `ARTIFACT_BASE_URL` with the visitor cookie (and `Authorization` when present), reporter injected inline, `Content-Security-Policy: sandbox allow-scripts`, `no-store`. Upstream 3xx is refused (403) — the credentials are never sent to a redirect target. Non-HTML passes through unchanged. |
| `GET /_canvas/_/…` (static) | no | Client bundle from `STATIC_DIR` (`assets/*` immutable, everything else `max-age=60`). Serves no artifact data, so no authz. |
| `WS /_canvas/_/ws/<artifact key>[?anon=NNNN]` | yes + re-check | The y-websocket room. |
| `GET /healthz`, `/readyz`, `/metrics` | no | Liveness, readiness (cached `store.ready()`), Prometheus. |

The ingress may forward the full `/_canvas/...` path or strip the prefix; both work.

### The artifact key end to end

The core's discovery links carry the bucket: `<read_base>/_canvas/<bucket>/<key>` (e.g.
`/_canvas/artifacts/pub/run/index.html`, from `ARTIFACTS_PLUGINS="canvas=/_canvas/;..."`),
while the client protocol speaks `/_canvas/<key>`. Both are accepted on every route
(wrapper, frame, ws): a leading segment equal to `S3_BUCKET` is stripped
(`paths.stripBucketSegment`). From there one canonical key drives everything:

```
core link      /_canvas/<bucket>/<key>   (or client shape /_canvas/<key>)
server route   strips /_canvas prefix + bucket segment → key
authz path     POST /_gate/plugin/authz  {"artifact": "/artifacts/<key>"}
S3 object      <CANVAS_PREFIX>/<key>.ydoc      (default _plugins/canvas/<key>.ydoc)
room name      <key>
```

Known ambiguity: an artifact key that itself starts with `<bucket>/` cannot be told apart
from a bucket-prefixed link; the bucket-prefixed reading wins (that is what the core emits).

## 2. WebSocket messages

Stock y-websocket framing (`varUint type` + payload): `0` SYNC, `1` AWARENESS, `3`
QUERY_AWARENESS, plus the canvas extensions:

- `100 IDENTITY` (varString JSON) — **always the first message** on a connection, built
  exclusively from the authz answer: `{id, name, anonymous, color?, attribution:'server', readOnly?}`.
  The server never trusts identity data the client sends; there is no client→server identity.
- `101 NOTICE` (varString JSON `{kind, message?}`) — `revoked | expired | readonly |
  rate-limited | too-large | shutdown`.

Close codes: `4403` forbidden (authz deny, forged stamper-root write), `4404` artifact gone,
`4410` artifact expired, `4413` too large (message or document), `4429` rate limited,
`4503` shutting down, `1013` room at capacity (retry later).

## 3. AuthZ: the core contract (matches core `gate/gate.py` + `docs/plugins.md` §1)

On every connect, and every `AUTHZ_RECHECK_SECONDS` (default 300; the chart ships 300, tests
1), the server calls the core's internal gate:

```
POST {GATE_AUTHZ_URL}            # e.g. http://artifacts-core:8081/_gate/plugin/authz
Content-Type: application/json
Cookie: <visitor cookie, verbatim>            # the gate accepts cookie or bearer
Authorization: <bearer token, verbatim, when present>

{"artifact": "/artifacts/<key>"}  # key percent-encoded per segment; gate does urlsplit + unquote
```

Status codes and their handling:

| Status | Gate meaning | Server action |
|---|---|---|
| `200` | decision (denials included; anonymous deny is `allowed:false`) | accept iff `allowed: true` and body well-formed |
| `400` | malformed body, path outside `/artifacts/`, or key the gate refuses | deny (`bad_path`) — logged as a validation divergence |
| `405` | non-POST | deny (`core_error`) |
| `500` | identity-backend error | deny (`core_error`) |
| network error / timeout / malformed JSON | — | deny (`core_error`) — **fail closed** |

Body: `{allowed, reason, user:{id,name,anonymous}, artifact:{key,expires,ttl}}`.

- `user.id` (1–256 chars) and `user.name` (1–128) are required for identified visitors; the
  identity the server sends in IDENTITY and writes into awareness comes **only** from this answer.
- `user.anonymous: true` (the gate sends `id: null`, `name: "anonymous"`) is accepted only for
  keys inside `ANON_ALLOWED_PREFIXES` (default `pub/`); anything else is denied with reason
  `anon_outside_pub`. The server composes the `anon:<NNNN>` pseudonym itself from `?anon=`.
- `artifact.ttl` is an **integer number of days** (or null); valid values (0–999) are copied onto
  the canvas object as an S3 tag `ttl=<n>` (design §6.3). `artifact.expires` is an ISO 8601
  datetime (ACL `expires`, else lastModified + ttl) — a past value means expired even when
  `allowed: true`, so canvas data never outlives the artifact.
- `reason` is informational for the decision; the server only classifies it for expiry:
  expired → `expired`; gone → `object-missing` (gate: allowed-but-HEAD-404). Both configurable
  via `EXPIRED_REASONS` / `GONE_REASONS`.

## 4. Persistence

One S3/MinIO object per artifact: `<CANVAS_PREFIX>/<artifact key>.ydoc` (default prefix
`_plugins/canvas`). The room loads it on first join (`Y.applyUpdate`, origin `'load'` — never
stamped, never re-broadcast), saves debounced (`SAVE_DEBOUNCE_MS`) and flushes on last leave
and on shutdown. Saves are serialized. Credentials are scoped by the core to
`_plugins/canvas/` (Get/Put/Delete/List on the prefix only).

## 5. Expiry and orphan sweep

When authz (connect, re-check, or HTTP gate) says expired/gone, the server refuses or drops
the room (NOTICE + `4410`/`4404`) and **deletes the canvas object**. A periodic sweep
(`SWEEP_INTERVAL_SECONDS`, default 3600) lists the prefix, asks the gate about each object's
artifact, and deletes objects whose artifact is gone or expired.

## 6. Enforcement summary

- **Path validation** before anything else: reject traversal, control chars, encoded
  traversal, absolute paths, and the reserved namespaces `_gate/`, `_plugins/`, `_/`,
  dotfiles (`.acl.json`). Optional allowlist `ARTIFACT_PREFIXES`.
- **Stamper** (shared with the client, `src/vendor/stamper.ts`): client updates are applied
  with the connection as transaction origin; `attribution`/`users`/`history` are written
  server-side only. A client write to those roots closes `4403` and the update is **not**
  applied (`forbiddenRootWrite`).
- **Awareness hardening**: the `user` field is overwritten with the verified identity; states
  for clientIds already owned by another connection are dropped.
- **Limits** (defaults; anonymous gets the stricter set): messages `120/s` burst 240
  (anon 30/60) → `4429`; message size 8 MiB (anon 2 MiB) → `4413`; document 20 MiB
  (anon 5 MiB) → `4413`; room connections 50 (anon rooms 10; per anon visitor 2) → `1013`.

## 7. Known model constraint

The shared stamper assumes every value in the `shapes` root is a `Y.Map` (the client model's
invariant). A malicious client that writes a non-map value into `shapes` gets the connection
closed (`1003`, the stamper's guard throws inside the server transaction); the offending
value is not stamped. v1 accepts this: the room stays consistent, the writer is dropped.
