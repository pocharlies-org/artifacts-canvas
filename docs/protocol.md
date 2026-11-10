# artifacts-canvas — protocol (client ⇄ server ⇄ core)

Status: v1, 2026-11-10. This is the **single authoritative protocol document** for the whole
repository. The wire contract, the document schema and the attribution stamper live in the
shared workspace [`shared/`](../shared) (`@pocharlies/artifacts-canvas-shared`) and both sides
import them, so client and server cannot drift. The reference implementation of every server
duty below is the service in [`server/`](../server) (unit-tested in `server/test/`, and
end-to-end against the real server in [`client/e2e-server/`](../client/e2e-server)); the
in-memory dev room [`client/dev/yroom.ts`](../client/dev/yroom.ts) exists only for client
development and the client's own Playwright suite. When this document and the code disagree,
fix one of them in the same change.

Words: **MUST** / **MUST NOT** are requirements; everything else is advice.

## 1. Routes

All routes live on the artifacts host under the plugin prefix `/_canvas/` (core plugin
contract, design §8). The segment `_/` is reserved for the canvas itself, so an artifact key
can never collide with it. The ingress may forward the full `/_canvas/...` path or strip the
prefix; both work (the server strips `/_canvas` itself, and the ws route also accepts the
stripped `/ws/`).

| Route | Authz | What |
|---|---|---|
| `GET /_canvas/<artifact key>` | yes | The wrapper page: `client/dist/index.html` with an inline config (§2). Headers: the CSP in §1.1, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. |
| `GET /_canvas/_/assets/*`, `GET /_canvas/_/reporter.js`, `GET /_canvas/_/vendor/html-to-image.js` | no | The static bundle from `client/dist/` (build with `npm run build`; base path `/_canvas/_/`, override with `CANVAS_BASE`). `assets/*` are `max-age=31536000, immutable`, everything else `max-age=60`. They carry no artifact data, so they need no authz. |
| `GET /_canvas/_/frame/<artifact key>` | yes | The artifact HTML with the reporter injected (§3), fetched from `ARTIFACT_BASE_URL` with the visitor's cookie (and `Authorization` when present). Upstream 3xx is refused (403) — the credentials are never sent to a redirect target. Non-HTML passes through unchanged. |
| `WS /_canvas/_/ws/<artifact key>[?anon=NNNN]` | yes + re-check | The room of that artifact (§4). |
| `GET /healthz`, `/readyz`, `/metrics` | no | Liveness, readiness (cached `store.ready()`: a one-key list of `<CANVAS_PREFIX>/`, which the prefix-scoped `plugin-canvas` user may do — a HeadBucket would be denied), Prometheus. Also served under `/_canvas/…` (prefix stripped). |

Every route that reveals anything about an artifact (wrapper, frame, ws) MUST first get
`allowed: true` from the core's `POST /_gate/plugin/authz` for that key and the visitor's
credentials (§7), and MUST answer exactly like the gate would for a denied artifact
otherwise (no existence leak). One exception mirrors the gate: when `LOGIN_URL` is set and
the gate answers `unauthenticated` (no session; not a bearer caller), the **wrapper** answers
`302` to `LOGIN_URL` with `{rd}` = the URL-encoded original path, so a visitor who opens a
canvas link first logs in and comes back. Frame and ws never redirect.

### 1.1 Wrapper CSP (sent by the server)

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; connect-src 'self'; frame-src 'self';
frame-ancestors 'self'; base-uri 'none'
```

(`connect-src 'self'` covers `wss:` to the same host in current browsers.)

### 1.2 The artifact key end to end

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

## 2. Wrapper configuration

The client derives everything from the URL: on `/_canvas/runs/x/report.html` the artifact key
is `runs/x/report.html`, the frame is `/_canvas/_/frame/runs/x/report.html` and the socket is
`wss://<host>/_canvas/_/ws/runs/x/report.html`. The service MAY override any field with an
inline element in the wrapper HTML (JSON, HTML-escaped):

```html
<script type="application/json" id="artifacts-canvas-config">
{"artifactPath":"runs/x/report.html","title":"Nightly report","pageWidth":980,"lang":"es","maxImageBytes":2097152}
</script>
```

Fields: `artifactPath`, `room`, `frameUrl`, `wsUrl`, `vendorUrl`, `shareUrl`, `pageWidth`,
`title`, `lang` (`es` default, `en`), `maxImageBytes`, `dev` (never `true` in production: it
enables a local identity and the `?as=` / `?room=` / `?artifact=` query parameters).

## 3. Frame: the artifact, isolated

The client renders `frameUrl` in `<iframe sandbox="allow-scripts">` — never
`allow-same-origin` — so the artifact runs in an opaque origin: no cookies, no storage, no
same-origin access to the wrapper. The frame response MUST also carry
`Content-Security-Policy: sandbox allow-scripts` (defence in depth; the same header the host
already stamps on artifacts) and `Cache-Control: no-store`.

**Reporter injection.** The service MUST insert `client/dist/reporter.js` (or
`client/public/reporter.js`; same file) as an inline `<script>` right after the opening
`<head>` tag (fallback: after `<!doctype>`, else at the very start), escaping `</script` as
`<\/script`. Reference: `injectReporter()` in `client/dev/plugin.ts`, mirrored by
`injectReporter()` in `server/src/http.ts`. Non-HTML artifacts (PNG, PDF, text) are out of
scope for v1; the service may wrap them in a minimal HTML page.

**Why** (design §7 "scroll and size"): the iframe is laid out at a fixed page width
(`pageWidth`, stored in the document so every participant gets the same layout) and sized to
the artifact's full content height. It never scrolls; the canvas camera pans and zooms the
iframe and the drawings together, so world coordinates are artifact CSS pixels and
annotations stay on the element they were drawn on. Wheel and touch go to the canvas; the
artifact is view-only inside the wrapper (the plain artifact link still works for interacting
with it).

**postMessage.** Only the following, validated on both sides (`event.source` is checked;
payloads are clamped):

| Direction | Message |
|---|---|
| frame → wrapper | `{source:'artifacts-canvas-reporter', type:'size', w, h}` content size, on load and on every resize |
| frame → wrapper | `{source:'artifacts-canvas-reporter', type:'title', title}` |
| frame → wrapper | `{source:'artifacts-canvas-reporter', type:'scroll', x, y}` the artifact tried to scroll (anchor link): the wrapper pans there |
| wrapper → frame | `{source:'artifacts-canvas', type:'snapshot', id, rect:{x,y,w,h}, scale, lib}` export request; `lib` is the `vendorUrl` |
| frame → wrapper | `{source:'artifacts-canvas-reporter', type:'snapshot', id, dataUrl}` a `data:image/png` of `rect`, or `null` |

The snapshot uses `html-to-image` (SVG `foreignObject`, no extra iframe, so it works in the
sandbox). Images the artifact loads from other origins cannot be captured from an opaque
origin and appear blank in exports.

## 4. WebSocket room

`WS /_canvas/_/ws/<artifact key>?anon=NNNN` — one room per artifact key. The client is the
stock `y-websocket` client (`WebsocketProvider`, BroadcastChannel disabled), so the room
speaks the standard y-websocket protocol: every message is `varUint type` + payload.

| Type | Name | Direction | Payload |
|---|---|---|---|
| 0 | SYNC | both | y-protocols/sync (step 1, step 2, update) |
| 1 | AWARENESS | both | y-protocols/awareness update |
| 2 | AUTH | server → client | y-protocols/auth (permission denied + reason) |
| 3 | QUERY_AWARENESS | client → server | — |
| **100** | **IDENTITY** | server → client | `varString` JSON `Identity` (below). MUST be the **first** message on every connection. |
| **101** | **NOTICE** | server → client | `varString` JSON `{kind, message?}`, `kind` ∈ `revoked`, `expired`, `readonly`, `rate-limited`, `too-large`, `shutdown` |

```ts
interface Identity {
  id: string;          // UPN for logged-in users; "anon:NNNN" for anonymous pub/ visitors. ≤ 256 chars
  name: string;        // display name from the verified identity; "Anónimo NNNN" for anonymous. ≤ 128 chars
  anonymous: boolean;
  color?: string;      // "#rrggbb", optional; the client derives a stable colour from id otherwise
  attribution: 'server' | 'client';   // production: always 'server' (§5)
  readOnly?: boolean;  // the client disables editing
}
```

- Identity comes from the authz answer (`user: {id, name, anonymous}`), never from anything
  the client sends. **There is no client→server identity**: the server never parses an
  incoming `100`; one closes the connection (`1003`).
- `anon=NNNN` is the pseudonym the visitor keeps in `localStorage`
  (`artifacts-canvas:anon`, 4 digits). The server MAY use it for anonymous connections
  (`anon:NNNN`, after checking `^\d{4}$`) and MUST ignore it for logged-in ones. Anonymous
  connections are accepted only for keys inside `ANON_ALLOWED_PREFIXES` (default `pub/`);
  anything else is denied with reason `anon_outside_pub` (§7).
- Close codes (RFC 6455 private range; the client does not reconnect on 44xx): `4403`
  forbidden (authz denied, revoked, or a forbidden write, §5), `4404` artifact gone, `4410`
  artifact expired, `4413` document/message too large, `4429` rate-limited, `4503`
  restarting (client reconnects), `1013` room at capacity (retry later). `4401`
  (unauthenticated) is reserved and unused in v1 — the gate denies unauthenticated visitors
  as `4403`/`4404`. Send a NOTICE before closing when there is something to tell the user.
- Re-check authz every `AUTHZ_RECHECK_SECONDS` (default 300; the chart ships 300) and on ACL
  change; on a deny send NOTICE `revoked`/`expired` and close 4403/4410.
- Without an IDENTITY message the production client stays read-only (it shows the document
  but never writes).

### 4.1 Sync handling (who sends what)

- **On join** the server sends IDENTITY, then **SYNC step 2** with the full room state (the
  server is the source of truth — it just loaded the doc from the object store). The server
  never sends a step 1, so a correct client never needs to answer one.
- **Client step 1** (state vector): the server answers with step 2 for that vector.
- **Client step 2** payload is `[state vector][update]`: the state vector
  (`varUint(count)` + count × (`varUint clientId`, `varUint clock`)) is skipped before the
  §5.3 guard and the apply, so a step 2 must not be able to smuggle a stamper-root write
  past `forbiddenRootWrite`.
- **Client update** (type 2 of SYNC): guarded (§5.3) and applied with the connection as
  transaction origin.
- Any other sync type closes the connection with `1003` (`unknown sync type`).

## 5. Attribution: server-stamped, never client-written

Attribution must not be forgeable (design §4), so clients never write it. In production the
server announces `attribution: 'server'` and MUST:

1. **Apply each client update with the connection as transaction origin**
   (`Y.applyUpdate(roomDoc, update, conn)`).
2. **Stamp** after every such transaction: run `attachStamper(roomDoc, {userOf: origin =>
   conn identity})` from
   [`shared/src/stamper.ts`](../shared/src/stamper.ts)
   (`@pocharlies/artifacts-canvas-shared/stamper` — the same code the client uses in dev, so
   there is one implementation, not a port). It writes, with origin
   `artifacts-canvas:stamper`:
   - `attribution[shapeId] = {createdBy, createdAt, updatedBy, updatedAt}` (ms epoch;
     `updatedAt` refreshed at most every 5 s per user; the entry is kept when the shape is
     deleted so an undo restores the original author),
   - `users[userId] = {name, anonymous, color?}` for the user who made the change,
   - `history.push({t, by, verb, shapeId, shapeType, geo?, highlight?, owner?})`, verbs
     `create | move | resize | rotate | edit | style | delete | order | group | lock`,
     rate-limited per (user, shape, verb) to one line per 10 s, the author's own creation
     gesture coalesced, capped at 300 entries.
   These stamper transactions are broadcast to every connection, including the sender.
3. **Reject client writes to `attribution`, `users` and `history`**: before applying an
   update, call `forbiddenRootWrite(roomDoc, update)` (same file). It decodes the update and
   returns the root name if any insertion or deletion touches those types. A malformed update
   that makes decoding throw counts as forbidden too. Then close the connection with `4403`
   and do **not** apply the update. This applies to plain updates and to step-2 payloads
   alike (§4.1).
4. **Overwrite the awareness `user` field** of every awareness update from a connection with
   that connection's identity (`awarenessProtocol.modifyAwarenessUpdate`), so live cursors
   and labels cannot lie either. States for clientIds already owned by another connection
   are dropped.

`attribution: 'client'` exists only for development against a plain relay (e.g.
`npx y-websocket`): the client then runs the same stamper for its own transactions. Never
announce it in production.

## 6. Document schema (Yjs)

| Root | Type | Written by | Content |
|---|---|---|---|
| `shapes` | `Y.Map<Y.Map>` | clients | one Y.Map per shape, key = shape id |
| `assets` | `Y.Map<string>` | clients | pasted images as data URLs, key = asset id (client caps at `maxImageBytes`, default 2 MiB, downscaled to ≤1600 px) |
| `meta` | `Y.Map` | clients | `pageWidth` (set once by the first client) |
| `attribution` | `Y.Map<Attribution>` | server | §5 |
| `users` | `Y.Map<UserInfo>` | server | §5 |
| `history` | `Y.Array<HistoryEntry>` | server | §5 |

Shape map fields (types in [`shared/src/model.ts`](../shared/src/model.ts)): `id`, `type`
(`draw | line | arrow | text | note | geo | frame | image`), `x, y, w, h, rotation`
(radians), `index` (z order), `groupId`, `locked`, style keys `color, fill, dash, size, font,
arrowheads, opacity`, and per type: `points: Y.Array<number>` (flat `x, y, pressure`,
appended live while drawing), `highlight, ow, oh, done, pen` (draw);
`start, end: {x, y, bind?: {shapeId, nx, ny}}, bend` (line/arrow); `text: Y.Text` (text,
note, geo label), `fixedWidth` (text); `geo` (geo); `name` (frame); `assetId` (image).

The laser pointer, cursors, viewports, presenting and following live **only in awareness**,
never in the document:

```ts
interface PresenceState {
  user: {id, name, color, anonymous};          // overwritten by the server (§5.4)
  cursor?: {x, y} | null;                      // world coordinates
  status?: 'cursor.typingNote' | 'cursor.typing' | null;
  laser?: {pts: [x, y, tMs][], now: tMs} | null;  // last ~1 s of the trail
  viewport?: {x, y, w, h} | null;              // the world rectangle this person sees
  presenting?: boolean;
  following?: string | null;                   // user id
}
```

## 7. AuthZ: the core contract (matches core `gate/gate.py` + `docs/plugins.md` §1)

On every connect, and every `AUTHZ_RECHECK_SECONDS`, the server calls the core's internal
gate:

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
  identity the server sends in IDENTITY and writes into awareness comes **only** from this
  answer.
- `user.anonymous: true` (the gate sends `id: null`, `name: "anonymous"`) is accepted only
  for keys inside `ANON_ALLOWED_PREFIXES` (default `pub/`); anything else is denied with
  reason `anon_outside_pub`. The server composes the `anon:<NNNN>` pseudonym itself from
  `?anon=`.
- `artifact.ttl` is an **integer number of days** (or null); valid values (0–999) are copied
  onto the canvas object as an S3 tag `ttl=<n>` (design §6.3). `artifact.expires` is an ISO
  8601 datetime (ACL `expires`, else lastModified + ttl) — a past value means expired even
  when `allowed: true`, so canvas data never outlives the artifact.
- `reason` is informational for the decision; the server only classifies it for expiry:
  expired → `expired`; gone → `object-missing` (gate: allowed-but-HEAD-404). Both
  configurable via `EXPIRED_REASONS` / `GONE_REASONS`.

## 8. Persistence

One S3/MinIO object per artifact: `<CANVAS_PREFIX>/<artifact key>.ydoc` (default prefix
`_plugins/canvas`). The room loads it on first join (`Y.applyUpdate`, origin `'load'` — never
stamped, never re-broadcast), saves debounced (`SAVE_DEBOUNCE_MS`) and flushes on last leave
and on shutdown. Saves are serialized. Credentials are scoped by the core to
`_plugins/canvas/` (Get/Put/Delete/List on the prefix only).

## 9. Expiry and orphan sweep

When authz (connect, re-check, or HTTP gate) says expired/gone, the server refuses or drops
the room (NOTICE + `4410`/`4404`) and **deletes the canvas object**. A periodic sweep
(`SWEEP_INTERVAL_SECONDS`, default 3600) lists the prefix, asks the gate about each object's
artifact, and deletes objects whose artifact is gone or expired.

## 10. Enforcement summary (the server enforces; defaults)

- **Path validation** before anything else: reject traversal, control chars, encoded
  traversal, absolute paths, and the reserved namespaces `_gate/`, `_plugins/`, `_/`,
  dotfiles (`.acl.json`). Optional allowlist `ARTIFACT_PREFIXES`.
- **Stamper** (§5, shared code): client updates are applied with the connection as
  transaction origin; `attribution`/`users`/`history` are written server-side only. A client
  write to those roots closes `4403` and the update is **not** applied
  (`forbiddenRootWrite`, throw treated as forbidden).
- **Awareness hardening** (§5.4): the `user` field is overwritten with the verified
  identity; states for clientIds already owned by another connection are dropped.
- **Limits** (anonymous gets the stricter set): messages `120/s` burst 240 (anon 30/60) →
  `4429`; message size 8 MiB (anon 2 MiB) → `4413`; document 20 MiB (anon 5 MiB) → `4413`;
  room connections 50 (anon rooms 10; per anon visitor 2) → `1013`.

## 11. Known model constraint

The shared stamper assumes every value in the `shapes` root is a `Y.Map` (the client model's
invariant). A malicious client that writes a non-map value into `shapes` gets the connection
closed (`1003`, the stamper's guard throws inside the server transaction); the offending
value is not stamped. v1 accepts this: the room stays consistent, the writer is dropped.
