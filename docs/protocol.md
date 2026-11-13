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
| `GET /healthz`, `/readyz` | no | Liveness, readiness (cached `store.ready()`: a one-key list of `<CANVAS_PREFIX>/`, which the prefix-scoped `plugin-canvas` user may do — a HeadBucket would be denied). Also served under `/_canvas/…` (prefix stripped). |
| `GET /metrics` on `METRICS_PORT` | no | Prometheus, on a **separate internal listener** (default `9091`; `0` disables it). The public listener answers `404` for `/metrics` and `/_canvas/metrics`. |

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
S3 objects     <CANVAS_PREFIX>/<key>.ydoc         content   (default _plugins/canvas/<key>.ydoc)
               <CANVAS_PREFIX>/<key>.ydoc.ledger  ledger    (§8)
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
`title`, `lang` (`es` default, `en`), `maxImageBytes`, `maxDocBytes` (the visitor's room cap:
`MAX_DOC_BYTES`, `ANON_MAX_DOC_BYTES` for an anonymous visitor; the editor says the canvas is
full before an image would pass it, fv8 U1), `dev` (never `true` in production: it enables a
local identity and the `?as=` / `?room=` / `?artifact=` query parameters).

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

`WS /_canvas/_/ws/<artifact key>?anon=NNNN` — one room per artifact key. The upgrade MUST carry an
`Origin` listed in `ALLOWED_ORIGINS` (default: the origin of `ARTIFACT_BASE_URL`, i.e. the public
artifacts host); a missing, `null` or foreign Origin is closed `4403` before any authz call (the
browser attaches the session cookie to cross-site upgrades). The client is the
stock `y-websocket` client (`WebsocketProvider`, BroadcastChannel disabled), so the room
speaks the standard y-websocket protocol: every message is `varUint type` + payload.

A room is **two Yjs documents** (§5, §6): the **content** document (`shapes`, `assets`, `meta`),
synced both ways over the standard SYNC messages, and the **ledger** document (`attribution`,
`users`, `history`, `writers`), which only the server writes and which travels server → client on
its own message type, LEDGER (102).

| Type | Name | Direction | Payload |
|---|---|---|---|
| 0 | SYNC | both | y-protocols/sync (step 1, step 2, update) |
| 1 | AWARENESS | both | y-protocols/awareness update |
| 2 | AUTH | server → client | y-protocols/auth (permission denied + reason) |
| 3 | QUERY_AWARENESS | client → server | — |
| **100** | **IDENTITY** | server → client | `varString` JSON `Identity` (below). MUST be the **first** message on every connection. |
| **101** | **NOTICE** | server → client | `varString` JSON `{kind, message?}`, `kind` ∈ `revoked`, `expired`, `readonly`, `rate-limited`, `too-large`, `too-costly` (a delete the server would need too long to apply at once, closed `4413`: the canvas is not full, fewer shapes at a time go through), `shutdown`, `busy` (a capacity refusal, closed `1013`: the client reconnects by itself) |
| **102** | **LEDGER** | server → client **only** | `varUint8Array` Yjs update (v1) of the room's ledger document. A client that sends a 102 is closed `4403` (`ledger is read-only`); its bytes are never applied. |

```ts
interface Identity {
  id: string;          // UPN for logged-in users; "anon:<visitor id>" (16 base64url chars) for anonymous pub/ visitors. ≤ 256 chars
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
- Anonymous pseudonyms are **assigned by the server**. Each anonymous browser holds an
  HttpOnly cookie `canvas_anon=<visitor nonce>.<NNNN>.<hmac>` signed by the server
  (`ANON_COOKIE_SECRET`, else a per-process key), set on the wrapper page or on the 101 of
  the upgrade. The nonce identifies the visitor (per-visitor caps; two tabs share one
  pseudonym). `anon=NNNN` (the number the client keeps in `localStorage`,
  `artifacts-canvas:anon`) is only a **hint** for a visitor without a cookie; a number held
  by another visitor on a live connection of the room is never given out again — the
  server picks a free one. The hint only ever chooses the **number shown**: the anonymous
  attribution id is `anon:<visitor id>`, an HMAC of the cookie's nonce, so a later visitor
  who gets a freed number shows the same label but never writes as — or is credited with —
  the earlier visitor's shapes and history. Logged-in connections ignore both. Anonymous
  connections are accepted only for keys inside `ANON_ALLOWED_PREFIXES` (default `pub/`);
  anything else is denied with reason `anon_outside_pub` (§7).
- Close codes (RFC 6455 private range; the client does not reconnect on 44xx): `4403`
  forbidden (authz denied, revoked, or a forbidden write, §5), `4404` artifact gone, `4410`
  artifact expired, `4413` document/message too large (also a stored room that costs more than
  the joining principal's whole memory share, §10), `4429` rate-limited, `4503`
  restarting (client reconnects), `1013` try again later (room, principal or server capacity,
  join rate, server CPU, server memory, the core unable to answer authz; the client reconnects
  with backoff — a join is never refused with the terminal `4429`, fv5 M-6). `4401`
  (unauthenticated) is reserved and unused in v1 — the gate denies unauthenticated visitors
  as `4403`/`4404`. Send a NOTICE before closing when there is something to tell the user.
- Re-check authz every `AUTHZ_RECHECK_SECONDS` (default 300; the chart ships 300) and on ACL
  change; on a deny send NOTICE `revoked`/`expired` and close 4403/4410. When the core could not
  answer (`core_error`: timeout, network error, 5xx; `malformed`) nothing was decided: the
  connection is not kept unverified (fail closed) but is closed `1013` with NOTICE `busy`, and
  the client reconnects and is checked again; a join while the core cannot answer is refused
  the same way (fv7 F6: a core blip closed every open tab with the terminal `4403` `revoked`).
- Without an IDENTITY message the production client stays read-only (it shows the document
  but never writes).

### 4.1 Sync handling (who sends what)

- **On join** the server sends, in this order: IDENTITY; LEDGER with the full ledger state;
  **SYNC step 2** with the full content state; **SYNC step 1** with the content state vector;
  then the awareness states. The two big frames are encoded **once per room version** and
  shared by every join of that version, and the content frames go out only once the ledger
  frame drained below 256 KiB (a peer that does not read never gets them queued); room
  broadcasts meanwhile wait and follow in order, and a client step 1 that arrives meanwhile is
  answered right after (fv5 H-1: every join copied the whole room into its socket's buffer). The step 1 is what makes edits made while disconnected arrive: the
  stock y-websocket client answers it with a step 2 holding everything the room lacks (shapes
  drawn while the socket was down, or while the server restarted), which the server treats as a
  plain client update. Without it, a reconnected client's next edit depended on clocks the room
  never received and was refused as `pending`. **The canvas client holds its local updates**
  from the moment a socket opens until it has answered that step 1: the answer carries every
  local change made until then, so nothing it sends can depend on clocks the room lacks (fv5
  M-2: y-websocket sends local updates as soon as the socket is open, and a keystroke typed while
  reconnecting reached the server before the answer). For any other client, a `pending` update
  no longer closes the connection: it is dropped (never applied) and answered with a fresh
  step 1, whose step-2 answer carries it (at most one request outstanding; 20 requests per
  connection, +1 every 2 s, then `4403`). A process that is shutting down joins nobody
  (close `4503`), so a reconnect always lands on the next process.
- **Client step 1** (state vector): the server answers with step 2 of the content for that
  vector **merged with the state vector the connection was sent in full at join** (every later
  change was broadcast to it): no state vector, empty or forged, gets the whole room a second
  time. The first answer of a connection is free; every later one is charged by its size to the
  connection's sync budget (`SYNC_BYTES_PER_SEC` / `SYNC_BURST_BYTES`), and a later step 1 with an
  empty state vector closes `4429`. Nothing is computed for a peer whose outgoing buffer is over
  `WS_MAX_BUFFERED_BYTES` (beyond the join burst): it is dropped (fv4 H1: 200 four-byte step 1
  messages from a socket that never read buffered 3 GB in the server).
- **Client step 2** and **client update** carry the same payload, `varUint8Array(update)`
  (y-protocols `writeSyncStep2` = `varUint8Array(encodeStateAsUpdate(doc, sv))` — there is **no**
  state vector in a step 2). Both are guarded (§5.3) and applied with the connection as
  transaction origin.
- Any other sync type closes the connection with `1003` (`unknown sync type`).
- The ledger is sent as a full state on join and then as each stamper transaction's update, to
  every connection (the sender included). It has no client → server direction.

## 5. Attribution: server-stamped, never client-written

Attribution must not be forgeable (design §4), so clients never write it — and since the third
independent verification they cannot even reach the document that holds it. In production the
server announces `attribution: 'server'` and MUST:

1. **Keep two documents per room.** The **content** document (`shapes`, `assets`, `meta`) is the
   only one client updates are applied to. The **ledger** document (`attribution`, `users`,
   `history`, `writers`) is written only by the stamper and sent read-only (LEDGER, §4). The
   server never applies a client byte to the ledger; any client message on the ledger channel
   closes the connection `4403`. (Why: with one shared document, every Yjs integration path —
   items without a parent, parked pending structs, zero-length structs — was a way to forge or
   erase attribution past the guard. With two, a guard bug can at worst let a malformed value into
   the content document; it can never name an author.)
2. **Apply each client update to the content document with the connection as transaction
   origin** (`applyGuarded(content, update, {identity})`, which wraps `Y.applyUpdate`). Both
   documents live in the room's worker thread (§12): the guard, this apply and the stamper run
   there, never on the main thread.
3. **Stamp** after every such transaction: `attachStamper(content, ledger, {userOf: origin =>
   conn identity})` from [`shared/src/stamper.ts`](../shared/src/stamper.ts)
   (`@pocharlies/artifacts-canvas-shared/stamper` — the same code the client uses in dev). It
   observes the content transaction and derives the created / updated / deleted shape ids from
   it alone (`transaction.changed`, its deletions), attributes them to the verified identity of
   the connection that sent it, and writes the ledger with origin `artifacts-canvas:stamper`:
   - `attribution[shapeId] = {createdBy, createdAt, updatedBy, updatedAt, deletedAt?}` (ms
     epoch; `updatedAt` refreshed at most every 5 s per user; the entry is kept when the shape
     is deleted so an undo restores the original author, with `deletedAt` set; the server
     prunes it `ATTRIBUTION_RETENTION_DAYS` after the delete),
   - `users[userId] = {name, anonymous, color?}` for the user who made the change,
   - `history.push({t, by, verb, shapeId, shapeType, geo?, highlight?, owner?})`, verbs
     `create | move | resize | rotate | edit | style | delete | order | group | lock`,
     rate-limited per (user, shape, verb) to one line per 10 s, the author's own creation
     gesture coalesced, capped at 300 entries,
   - `writers[clientId] = principal` (decimal Yjs client id → identity id), see 5.
   These ledger transactions are broadcast to every connection, including the sender.
4. **Guard the content document** before applying (`checkClientUpdate(content, update,
   {serverClient, mayWriteClient})`, same file; `forbiddenRootWrite` returns only the reason).
   Its job is schema/size safety and pending-state hygiene, not attribution. It resolves every
   NEW struct to its parent type — Yjs omits `parent` (and the map key) for an item that has a
   left/right origin, so origins are followed through the room for clocks it has and through the
   update for new ones — and every deletion through the room. Refused (close `4403`, update
   **not** applied):
   - a write or delete in any root other than `shapes`, `assets`, `meta` (an allow-list: a
     ledger-named root in the content document, a root left by a pre-split document, any
     unknown root);
   - `malformed`: a **zero-length** struct (Yjs integrates a zero-length item even at a known
     clock: over a live map entry it erases that entry and the document can no longer be
     encoded) or a **zero-length delete range** (Yjs throws re-encoding it); a delete set that
     is not canonical — ranges unsorted or overlapping, a client listed twice, bytes after it
     (fv5 M-4: Yjs applies every range as listed, but `Y.isDeleted` binary-searches them, so an
     unsorted list hid "this update also deletes its own new `type`", and one range repeated
     60 000 times was subtracted 60 000 times from the text length); a client that
     appears in more than one struct block (Yjs keeps only the last one); a same-client
     dependency on a clock at or after the struct's own;
   - `pending`: anything that would not integrate completely — a struct starting beyond the
     room's clock for its client, a hole (Skip) or non-contiguous clocks, an origin/parent that
     neither the room nor the update has (**for structs the room already has too**: Yjs
     resolves their dependencies before it skips them), a cross-client dependency cycle, a
     delete of clocks nobody wrote yet;
   - `server-client` (a struct carrying the content document's own client id),
     `foreign-client` (new clocks for a client id bound to another principal, or not yet
     bound and announced in another principal's awareness), `overlap` (a struct that only partly
     overlaps the room);
   - `shapes-schema` / `assets-schema` / `meta-schema`: §6 — for every new item at a field key,
     a deleted (`ContentDeleted`) one included (it deletes the value there: a live shape's
     `type` can never go away). The text and point caps count the **resulting** length: the
     room's, plus the new elements the update leaves alive (one it inserts and deletes again —
     an offline paste the UndoManager undid — adds nothing, fv5 M-1), minus the live room
     elements it deletes.
   The check is one pass, O(update) plus a binary search per room lookup: origin chains of any
   length are followed iteratively and memoised, and a delete range walks the room's struct
   array once. There is **no slow path**: the scratch copy of the room it used to rebuild for
   every update it could not resolve cost O(room) per message (fv4 H2: a 46-byte update took
   966 ms on a 7.7 MB room). What the single pass cannot resolve — an origin cycle, an item
   with neither parent nor origin, a room item outside every root, nesting deeper than the
   schema allows (`malformed`), a shape's `type` overwritten twice in one update
   (`shapes-schema`; clients never change a shape's type) — is refused; no honest Yjs encoder
   produces any of it. A malformed update that makes decoding throw counts as forbidden too.
   Each **principal** (a user, an anonymous visitor cookie) has a **CPU budget**
   (`CPU_MS_PER_SEC` / `CPU_BURST_MS`) shared by all its connections: the time the server spends
   on their messages (and on their joins) is charged to it, and a principal that keeps the event
   loop busy has its connections closed `4429` (fv5 M-5: 20 connections of one user each had
   their own budget). The server as a whole has one too (`CPU_TOTAL_MS_PER_SEC`, and
   `ANON_CPU_TOTAL_MS_PER_SEC` for all anonymous connections together): while it is used up,
   messages bigger than `CPU_SHED_MIN_BYTES` are refused with `1013` (the client reconnects and
   resends), small ones still pass, and so are joins that would load a room or encode it in
   full (fv6 M-A); a principal in debt has its new joins refused with `1013` until its budget
   refilled. Loading a room counts against the server-wide budgets. A join gets the room as an
   encoded snapshot plus the updates broadcast since (the snapshot is shared by every join and
   encoded again only once those updates outgrow it: 256 messages, or a quarter of its size), so
   a client that changes the room before every join no longer makes every join encode it.
   Debounced saves (which encode the whole room too) share a server-wide CPU budget
   (`SAVE_CPU_MS_PER_SEC` 50 ms/s, burst 1 s): a save that is due waits while it is used up, so
   tiny edits in many big rooms cannot keep the server busy saving; the flush on last leave and
   on shutdown never waits. A visitor cookie whose join budget is used up, or whose principal is
   in CPU debt, is refused before the core is asked. One message costs at most O(its size), and its size is
   capped (§10): about 3 s of guard on this hardware at the old 8 MiB cap (4 MiB since fv7).
   **Whatever the apply does, the room never keeps pending state**: `applyGuarded` drops any
   parked structs/deletes in a `finally` — also when `Y.applyUpdate` throws half-way (a throw
   used to skip that check and leave the room pending, refusing every later writer as
   `room-pending`) — the sender is closed `4403` and the room is marked dirty. Saves encode the
   integrated documents only, and a stored object that has pending state is cleaned on load.
5. **Bind client ids.** A Yjs client id is bound to the first principal that adds clocks to it,
   in the ledger's `writers` map, so the binding is persisted and survives a room reload or a
   server restart. Nobody else may extend it (`foreign-client`). Awareness alone never binds an
   id: a state announced for an id the ledger binds to another principal is dropped, and an
   awareness claim only blocks ids that have no clocks yet. (An id with clocks from a document
   stored before the bindings existed is bound by its first writer.)
6. **Overwrite the awareness `user` field** of every awareness update from a connection with
   that connection's identity, so live cursors and labels cannot lie either. States for
   clientIds already owned by another connection are dropped. Every state is reduced to the
   presence schema of §6 (`cleanPresenceState`: only the known fields, typed and bounded, a
   field that does not fit is dropped; `laser.pts` at most 60 points; a state over 16 KiB of
   JSON is dropped unread), and the client applies the same check to what it receives (fv4 M3:
   `{laser: {pts: null}, status: 5}` made every other viewer throw). A connection holds **one**
   state (its own client id: the first it announces; a removal frees the slot) and a room at
   most `MAX_AWARENESS_PER_ROOM` (50): more are dropped (fv5 M-7: one 2 MiB message announced
   72 000 client ids and every viewer kept and walked them all).

`attribution: 'client'` exists only for development against a plain relay (e.g.
`npx y-websocket`): the client then runs the same stamper for its own transactions, into a
ledger document local to that tab (the ledger has no outgoing channel, so it is never shared).
Never announce it in production.

## 6. Document schema (Yjs)

| Document | Root | Type | Written by | Content |
|---|---|---|---|---|
| content | `shapes` | `Y.Map<Y.Map>` | clients | one Y.Map per shape, key = shape id |
| content | `assets` | `Y.Map<string>` | clients | pasted images as data URLs, key = asset id (client caps at `maxImageBytes`, default 2 MiB, downscaled to ≤1600 px) |
| content | `meta` | `Y.Map` | clients | `pageWidth` (set once by the first client) |
| ledger | `attribution` | `Y.Map<Attribution>` | server | §5 |
| ledger | `users` | `Y.Map<UserInfo>` | server | §5 |
| ledger | `history` | `Y.Array<HistoryEntry>` | server | §5 |
| ledger | `writers` | `Y.Map<string>` | server | Yjs client id (decimal) → principal, §5.5 |

Enforced schema of the content document (server guard `shapes-schema`/`assets-schema`/
`meta-schema`, the same rules the client reader applies to skip a malformed entry instead of
throwing; all in [`shared/src/model.ts`](../shared/src/model.ts)): every direct child of `shapes`
is a `Y.Map` (never a number, string, `null`, array or text); a new shape carries a `type` from
the list below in its first update and a live shape never loses it (not by a delete, not by a
deleted item at the key); `x, y, w, h, rotation, index, opacity, bend, ow, oh` are finite numbers
within ±1e9; `locked, highlight, done, pen, fixedWidth` booleans; `id, groupId, name, assetId`
strings ≤ 1024; the **style enums come from shared allow-lists**: `color` ∈ `COLOR_NAMES`
(`black grey violet pink blue light-blue orange yellow red green light-green white`), `fill` ∈
`none semi solid pattern`, `dash` ∈ `solid dashed dotted draw`, `size` ∈ `s m l xl`, `font` ∈
`draw sans serif mono`, `arrowheads` ∈ `none end both dot`; `geo` one of `GEO_KINDS`;
`start`/`end` terminals `{x, y, bind?: {shapeId, nx, ny}}` with no other keys and a plain
prototype; `text` a `Y.Text` (or a string) of **at most 10 000 characters** (`MAX_TEXT_LENGTH`,
counted across inserts and deletes; the client renders at most that many of whatever a document
holds — fv4 H3); `points` a `Y.Array` (or array) of
finite numbers, **at most 300 000** (`MAX_POINTS`), counted across appends; unknown fields only
plain JSON values, never nested types. **Forbidden keys**: `__proto__`, `constructor`,
`prototype` are never a shape id, a field name, an asset id, a meta key, or a key inside a JSON
value (a decoder assigns `o[key] = v`, so such a key gives the value an attacker-chosen
prototype); map keys are 1–256 chars. `assets` values are **base64 data URLs of a raster image**,
`data:image/(png|jpeg|gif|webp);base64,…`, and nothing else (`ASSET_DATA_URL`; the client
renders nothing else either and re-encodes other pasted formats as PNG — fv4 M2: an asset
`/oauth2/sign_out` logged every viewer out); `meta` values plain JSON (no nested types). The client reader also needs both terminals on lines/arrows, uses the map key as
the shape id, reads only the known shape fields into a null-prototype object, falls back to the
default for a style value outside its allow-list, and renders each shape in its own try/catch
(one bad shape never aborts a render pass).

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
| network error / timeout / malformed JSON | — | deny (`core_error`) — **fail closed**, retryable: `1013` `busy` on the WebSocket (§4) |

Body: `{allowed, reason, user:{id,name,anonymous}, artifact:{key,expires,ttl}}`.

- `user.id` (1–256 chars) and `user.name` (1–128) are required for identified visitors; the
  identity the server sends in IDENTITY and writes into awareness comes **only** from this
  answer.
- `user.anonymous: true` (the gate sends `id: null`, `name: "anonymous"`) is accepted only
  for keys inside `ANON_ALLOWED_PREFIXES` (default `pub/`); anything else is denied with
  reason `anon_outside_pub`. The server composes the anonymous identity itself (§4:
  `anon:<visitor id>` bound to its signed cookie, label `Anónimo NNNN` server-assigned,
  `?anon=` only a hint for the number).
- `artifact.ttl` is an **integer number of days** (or null); valid values (0–999) are copied
  onto the canvas object as an S3 tag `ttl=<n>` (design §6.3). `artifact.expires` is an ISO
  8601 datetime (ACL `expires`, else lastModified + ttl) — a past value means expired even
  when `allowed: true`, so canvas data never outlives the artifact. It is read only on an
  `allowed: true` answer: the core tells `expired`/`object-missing` (and the expiry) only
  to a visitor who would otherwise be allowed, and the canvas never derives `410` for a
  denied one either, so a stranger always gets the plain `403`/`4403` (no existence leak).
- `reason` is informational for the decision; the server only classifies it for expiry:
  expired → `expired`; gone → `object-missing` (gate: allowed-but-HEAD-404). Both
  configurable via `EXPIRED_REASONS` / `GONE_REASONS`.

## 8. Persistence

Two S3/MinIO objects per artifact (default prefix `_plugins/canvas`), both with the artifact's
`ttl` tag:

```
<CANVAS_PREFIX>/<artifact key>.ydoc          content document
<CANVAS_PREFIX>/<artifact key>.ydoc.ledger   ledger document
```

(Not `<key>.ledger.ydoc`: that is also the content object of an artifact named `<key>.ledger`.
Content objects always end in `.ydoc`, ledgers in `.ledger`, so the families never collide.)
The room loads both on first join into its worker (§12; `Y.applyUpdate`, origin `'load'` —
never stamped, never re-broadcast; the ledger first; every connection that arrives during the
load waits for it, and a failed load leaves no room behind), saves debounced (`SAVE_DEBOUNCE_MS`)
and flushes on last leave and on shutdown; each save writes the ledger, then the content. Saves
are serialized. Every change since the last save that reached storage is also kept, in order, in
the room's write-ahead log on the main thread (the updates the documents emitted: what was
broadcast); a save truncates it once both objects are written. A save that fails is retried by
itself (`SAVE_DEBOUNCE_MS` x 2^failures, at most 30 s; a change meanwhile still saves after the
debounce). While the saves fail the log is bounded: past `WAL_MAX_DOCS` (4) x `MAX_DOC_BYTES`
the room refuses every write `1013` `busy` (nothing is applied: the clients keep their edits and
send them again once they reconnected) until a save reaches storage; what the log holds beyond
the room's own size counts in the memory budget (§11); and a room whose changes are not in
storage is not evicted when its last connection leaves (before, it was, and the edits since its
last save were lost: fv4 L2), it is once a save succeeds.
Credentials are scoped by the core to `_plugins/canvas/` (Get/Put/Delete/List on the prefix
only).

**Migration.** A content object stored before the split holds `attribution`/`users`/`history`
itself. On load, their live entries are copied into the ledger (entries the ledger already has
win) and deleted from the content document, and both objects are saved back (metric
`canvas_legacy_migrations_total`). Deleting rather than rebuilding keeps every content struct id
stable for tabs that were open across the upgrade.

## 9. Expiry and orphan sweep

When authz (connect, re-check, or HTTP gate) says expired/gone, the server refuses or drops
the room (NOTICE + `4410`/`4404`) and **deletes both canvas objects** (content and ledger). A
periodic sweep (`SWEEP_INTERVAL_SECONDS`, default 3600) lists the prefix, asks the gate once per
artifact found (from a content or a ledger object), and deletes both objects of every artifact
that is gone or expired.

## 10. Enforcement summary (the server enforces; defaults)

- **Path validation** before anything else: reject traversal, control chars, encoded
  traversal, absolute paths, and the reserved namespaces `_gate/`, `_plugins/`, `_/`,
  dotfiles (`.acl.json`). Optional allowlist `ARTIFACT_PREFIXES`.
- **Two documents** (§5): client updates reach only the content document, applied with the
  connection as transaction origin; `attribution`/`users`/`history`/`writers` live in the ledger
  document, written by the stamper only. A client message on the ledger channel, or a content
  update the guard refuses, closes `4403` and is **not** applied (`checkClientUpdate`, throw
  treated as forbidden); the apply itself never leaves pending state (`applyGuarded`). Text
  holds characters only: a formatting or embed item in a shape's `text` → `4403` (fv9 D: the
  client never formats, and formatting items made Yjs copy the attribute map per character).
- **Isolation** (§12): the documents, the guard and the apply of every room run in a worker
  thread of the room's own, with a heap limit; the main thread waits for each answer with a
  watchdog (`WORKER_MESSAGE_TIMEOUT_MS` 1 000 + `WORKER_TIMEOUT_NS_PER_BYTE` 1 000 per byte of
  the message, the apply up to twice its estimate on top). A message that makes its room's
  worker miss the watchdog, run out of heap or crash closes its sender `4413` (notice
  `too-large`) with a **strike**, and so does an update the guard refuses for the work it would
  cost (cuts, merges, deletes, placement over the caps, client blocks: `4413`), except one that
  only deletes: an honest bulk delete of thousands of shapes another session wrote can be one, so
  it is refused `4413` with notice `too-costly` and no strike (the guard that refused it cost only
  its own time, charged to the sender; the editor deletes big selections `DELETE_BATCH` (1 000)
  shapes per update: 414 ms estimated at most for a room past the size cap,
  `server/test/fv9/delete-batch.ts`); `WORKER_STRIKES` (3) within `WORKER_STRIKE_WINDOW_MS` (10 min)
  refuse the principal's joins and writes for `WORKER_STRIKE_COOLDOWN_MS` (10 min) → `1013`;
  anonymous visitors also per client IP (when `CLIENT_IP_HOPS` says where it is) and all
  together after `WORKER_ANON_POOL_STRIKES` (10). The room is rebuilt in a fresh worker and
  nobody else is closed. One client message is processed at a time over all rooms
  (`WORKER_APPLY_CONCURRENCY` 1, the memory formula reserves one).
- **Messages in flight** (§12): a client message (sync step 1, step 2, update) counts from its
  receipt until its room's worker processed it. A connection, and a principal over all its
  connections, with two messages of the largest size in flight (1 MiB at least: 8 MiB, anonymous
  2 MiB) is no longer read until they are processed (TCP backpressure); a message bigger than
  `CPU_SHED_MIN_BYTES` (16 KiB) that would take everything in flight past
  `WORKER_INFLIGHT_BYTES` (64 MiB) → `1013` `busy` (metric `canvas_ws_rejected_total{reason="inflight"}`);
  a smaller one (an honest edit) is taken, and its connection is not read while it has more in
  flight and the total is over the cap.
- **Awareness hardening** (§5.4): the `user` field is overwritten with the verified
  identity; states for clientIds already owned by another connection are dropped; every state
  is reduced to the presence schema.
- **Limits** (anonymous gets the stricter set): messages `120/s` burst 240 (anon 30/60) →
  `4429`; message size 4 MiB (anon 1 MiB) → `4413`; room size 5 MiB (anon 1.25 MiB), **content
  plus ledger** → `4413` (all of them lowered at start to what the memory budget holds, see
  "Loaded rooms" below; the ledger an update will add is counted ahead, `ledgerBound` §11),
  where every **cut** an update makes in an item counts `SPLIT_COST_BYTES` (32) on top of its
  size: an insert whose origin or right origin names a clock inside an item, a struct the room
  has re-sent with such an origin (Yjs resolves it before it skips the struct), a delete range
  that starts or ends inside a live item, in the room's items or the update's own (fv5 L-2:
  deleting every other character grew a room 8x with "deletes only"; fv8 P1: inserting a point
  between every two points of two strokes, 3.97 MB, was stored at 7.5 MiB against an estimate of
  4.28; an update that only removes whole items always passes); an update with more than
  `MAX_SPLITS_PER_MESSAGE` (5 000) cuts, or more than `MAX_CLIENTS_PER_UPDATE` (256) client
  blocks, or whose cuts, placement, merges and deletes Yjs would need more than `MAX_APPLY_MS`
  (1 000 ms; 50 before fv9) for by the server's estimate → `4413` for that connection (fv8 P2:
  Yjs copies an item for every cut, and scans every item between a new item's origin and its
  right origin: the 3.97 MB update held the event loop 53-65 s, 2 000 forged items with far right
  origins 20 s; fv9 A-C: it merges structs that continue each other by concatenating their
  contents and splices the client's struct array per run merged — 20 000 one-number items ran
  the server out of heap, 100 000 pairs took 5.4 s, a delete-only update of 80 000 ranges 8.6 s;
  fv9 E: 20 000 client blocks made the guard itself quadratic; the guard counts all of it, §11);
  the apply of an update is charged to the CPU
  budgets below **before** it runs, by its estimate, and one they cannot cover → `1013` `busy`
  (an estimate under 1 ms is charged after, as any message); room connections 50 (anon rooms 10)
  → `1013`; connections per logged-in user 8 and per anonymous visitor 2, **over all rooms** →
  `1013`; joins per user 30/min burst 20, per anonymous visitor cookie 10/min burst 6, per room
  for anonymous joins **without** a visitor cookie 60/min burst 30 (a refusal sets the cookie,
  within the mint rate, so the retry of an honest browser has a bucket of its own), per client
  IP for anonymous joins 30/min burst 20 when `CLIENT_IP_HOPS` says where the IP comes from →
  `1013`; **new anonymous visitors** (visitor cookies, each a principal with budgets of its own)
  minted at most 120/min burst 60 by the wrapper page and as many by cookieless joins, and
  10/min burst 10 per client IP (fv6 M-A: one client minted 1 000 visitors with HEAD requests)
  → the page without a cookie, the join `1013`; sync answers after the first 1 MiB/s burst
  4 MiB (anon 256 KiB/s, 1 MiB) → `4429`; CPU per principal 250 ms/s burst 5 s (anon 60 ms/s,
  1 s) → `4429`, and its new joins `1013` while in debt; CPU of the whole server 600 ms/s burst
  6 s (all anonymous connections 150 ms/s, 1.5 s) → messages over 16 KiB, and joins that would
  load or encode a room, `1013`; awareness one state per connection, 50 per room → dropped.
  **Outgoing data** (fv5 H-1): a peer's buffer over 8 MiB beyond its join payload → dropped on
  the next send, or by a timer after `WS_SLOW_CONSUMER_MS` (10 s); the join payload must drain
  at `WS_JOIN_MIN_BYTES_PER_SEC` (32 KiB/s, 30 s floor); a peer that answers no WebSocket ping
  for two `WS_PING_INTERVAL_MS` (30 s) rounds and drains nothing → dropped; everything held for
  all peers together (join frames counted once per room snapshot) over
  `WS_OUTGOING_BUDGET_BYTES` (256 MiB) → peers that stopped reading (`WS_STALL_MS`, 3 s without
  draining 32 KiB/s while holding more than 256 KiB) are dropped first, then principals holding
  more than an eighth of the budget, then the biggest holders; a join is refused `1013` only
  when it does not fit once the stalled peers are gone (fv6 L-A: paused sockets held the budget
  and honest joins were refused), or when its principal already holds more than an eighth. A
  join of a principal that holds nothing may go 25% over the budget (a peer that just stopped
  reading is known as stalled only after `WS_STALL_MS`); the sweep, every second, brings the
  total back under it.
  **Loaded rooms** (fv6 H-1, fv7 F1, §11): every loaded room's estimated cost is charged to the
  principal whose join loaded it, and what each accepted update adds to the room to the principal
  that sent it, in full (never split with the others connected: readers pay nothing); what a
  principal wrote stays charged to it while the room stays loaded, also after it left, while
  its load charge moves to the principals still connected, as far as their shares hold it (fv8
  U2); each save replaces the estimates of the updates since the previous one by what the room
  measures. A join that would
  load a room past **85%** of the room memory budget (derived from the V8 heap limit,
  `ROOM_MEMORY_BUDGET_BYTES`), and an update that would grow the loaded rooms past **80%** of it,
  → `1013` (`busy`): the 5% between them is always left for loads; rooms with no connection are
  evicted first. A load or a growing update that would charge its principal past a **third** of
  the budget (`ROOM_MEMORY_PRINCIPAL_SHARE`; an anonymous visitor a quarter of that, 1/12), or
  all anonymous visitors together past a **third** (`ROOM_MEMORY_ANON_SHARE`) → `1013`; a stored
  room whose cost alone passes the joiner's whole share loads, charged that share (fv8 P1), and
  only one whose cost passes 85% of the whole budget → `4413` `too-large`. At most 4 rooms
  load at once. Joins to rooms already loaded are never refused for memory. Every penalty is per
  connection or per principal: an update that would grow the room past the sender's cap is
  refused and only that connection is closed; the room stays open for everyone else. An update
  that only removes whole items always passes, and counts what it really deleted. Attribution
  entries of shapes deleted more than `ATTRIBUTION_RETENTION_DAYS` (30) ago are pruned from the
  ledger.
- **Origin** (§4): WebSocket upgrades only from `ALLOWED_ORIGINS`, else `4403`. The HTTP routes
  are `GET`/`HEAD` only (no state-changing HTTP route exists).

## 11. Known model constraints

- Text and point caps hold for the merged result. Two tabs that grow the same text
  concurrently (each under 10 000 characters locally) can merge past the cap: the update that
  would pass it is refused (`shapes-schema`, `4403`). The editor never lets one tab exceed the
  cap (maxLength, truncated paste), so this needs two people typing thousands of characters
  into one note at the same moment.
- Yjs' undo/redo can write a list item whose origins contradict each other ("after X and
  before X", or a right origin before the left one); documents then place it differently
  depending on how their own items are merged — the room, reloaded from storage, diverged from
  the tabs (found by the fv5 honest-edit fuzzer). The canvas client rewrites the origins of
  every item of its undo/redo transactions to the place the item took before the update is
  encoded (`fixSelfOrigins`, client/src/model/doc.ts). Another Yjs client is not protected.
  Yjs' undo/redo can also throw (`TypeError ... reading 'client'` in `getItemCleanStart`) when
  it redoes an item a concurrent edit split or removed (fv6 L-B, ~1 in 30 000 random concurrent
  operations): `CanvasDoc.undo/redo` catch it, the step is lost, the documents stay consistent
  (the throwing transaction still commits what it did, with the origin rewrite).
- Memory (fv6 H-1, fv7 F1/F2, fv9): a loaded room costs `ROOM_COST_FACTOR` (44) x its encoded
  size (content + ledger) plus `ROOM_BASE_COST_BYTES` (16 MiB: its worker thread, §12, measured
  15.7 MiB in the image; 32 KiB before fv9), an estimate measured on Node 22 with the join frames encoded,
  rooms built through the real guard and stamper (`server/test/fv7/ratio.ts`): a key overwritten
  alternately by two client ids 37.7x (39.5x with a new pair of ids every 250 writes), geo shapes
  whose fields alternate ids 25.1x, one client id per shape 24.8x, geo shapes with a text label
  21.6x, create/delete 10.1x, strokes 4.2x — the worst plus 10%. Guarding and applying one
  message needs up to 51-53x its size of heap (`server/test/fv7/guardcost.ts`):
  `MESSAGE_COST_FACTOR` 60. The server keeps the estimate of the loaded rooms under a budget
  derived from the heap the process may use (`HEAP_LIMIT_MB`, else V8's `heap_size_limit`, − 192
  MiB − `WS_OUTGOING_BUDGET_BYTES` − 60 x `MAX_MESSAGE_BYTES`, at least 64 MiB;
  `ROOM_MEMORY_BUDGET_BYTES` overrides it; fv9: not `--max-old-space-size`, which overrides every
  room worker's heap limit, §12) (1 088 MiB with the chart's 1776 under its 2304Mi limit, logged at start and
  exported as `canvas_room_memory_budget_bytes`; the shares as `canvas_room_memory_share_bytes`,
  what the principals are charged for as `canvas_room_memory_charged_bytes`).
  **Accounting.** Each room's cost is charged: at load, to the principal whose join loaded it;
  then every accepted update, to the principal that sent it, by what it added to the room's
  estimate (content, and the ledger the stamper wrote for it), in full. What a principal wrote
  stays charged to it while the room is loaded, whoever keeps it loaded — a writer that leaves
  keeps paying for its growth until the room is evicted — and is never moved to the principals
  that only read. The **load** charge is different (fv8 U2): when the last connection of the
  principal paying it leaves while others keep the room open, it moves to the principals still
  connected, split evenly, each at most what its share still holds (an anonymous visitor's also
  within the anonymous share); what nobody can take stays where it was and moves at a later
  leave. Before, a user who opened a big room and left it to colleagues kept paying for it and
  could not open a second one (`1013` until the room was evicted). A principal that sits in a
  room someone else loaded therefore takes over that room's load cost when the loader leaves;
  it frees it by leaving (the room is then evicted, or handed on). Every save measures the
  room: the principals that wrote since the previous save
  share what the room really changed by since then, in proportion to the estimates of their own
  updates (an over-estimate, or a delete, is given back to them; nobody else's charge moves).
  So the charges of a room always add up to its cost, and the loaded rooms cost what the
  principals are charged together.
  **Bounds.** Loads stop at 85% of the budget (after evicting rooms nobody is connected to),
  growth at 80%, both with `1013` `busy`. A room's write-ahead log counts too where it holds more
  than the room's own size (saves failing: §8), and a room whose changes are not in storage is
  not counted as evictable. A principal may be charged at most
  `ROOM_MEMORY_PRINCIPAL_SHARE` (a third of the budget; an anonymous visitor a quarter of that),
  all anonymous visitors together `ROOM_MEMORY_ANON_SHARE` (a third; the two shares together may
  not pass 80%). For a room an anonymous visitor loads, the anonymous pool pays the room's
  **full** cost, also when the visitor itself is charged one visitor share at most (fv9 F: three
  cookieless visitors who each opened a 4.94 MiB `pub/` room were charged 72.67 MiB each, 218 MiB
  of the anonymous third, while the rooms took 651 MiB of the 872 MiB budget, and a signed-in
  user could grow nothing): a room whose cost alone passes the anonymous third never loads for an
  anonymous visitor (`4413`), one that does not fit beside what the pool holds waits (`1013`).
  One user plus every anonymous visitor are therefore charged at most two thirds of the budget
  (what a user is charged is at most a third, and the anonymous visitors' rooms cost the pool in
  full): the loaded rooms of everybody else always have the rest to load into, and growth
  never takes the last 5% loads need. Before (fv7 F1) a writer was charged its growth divided by
  the principals present, nothing re-charged it when they left, and growth could take the budget
  to 100% while loads stopped at 90%: one user who grew rooms while others sat in them held the
  whole budget and every new room was refused for everybody.
  **Caps.** A room at `MAX_DOC_BYTES` must fit one share with a 25% margin (44 x 1.25 x cap +
  16 MiB ≤ a third of the budget), an anonymous room at `ANON_MAX_DOC_BYTES` an anonymous
  visitor's share: when the memory is too small for them, the server lowers the caps to what
  fits at start, the message caps to the room caps (and to the message size the budget reserves),
  the image caps to 70% of the message caps, and logs a `memory sizing:` warning for each; it
  also warns when the budget is smaller than one full room. The defaults fit the chart's 2304 MiB
  (a share of 363 MiB holds a full 5 MiB room, 236 MiB with its worker; the anonymous visitor's
  91 MiB a full 1.25 MiB anonymous room); at 1 GiB the caps go down to ~1.4 MiB.
  A stored room whose cost alone passes the joiner's share (stored under a larger cap, or before
  fv8 counted every cut) loads, its loader charged one share at most, and the server logs a
  warning (`stored room costs more than a share`): the rest of its cost is charged to nobody, the
  size cap refuses it any growth, and deletes shrink it. Before (fv8 P1) it was refused `4413`
  to everyone, for good: one update the server itself accepted made a shared room unloadable for
  its owner. Only a room whose cost passes 85% of the whole budget (stored by a deployment with
  more memory) is refused `4413` `too-large`. A `pub/` room written by signed-in users past
  ~1.4 MiB costs more than an anonymous visitor's share: an anonymous visitor who loads it holds
  its whole share while it is loaded, and the anonymous pool the room's whole cost.
  **Known limits.** The shares are per principal: several signed-in accounts acting together
  hold a third each. Writers of the same room within one save period share its measured growth
  by their estimates, so a writer whose updates are over-estimated less than a co-writer's pays a
  little of the co-writer's part (never more than its own estimates; fv8 P4, Low: a deleter's
  credit for a big delete goes to the co-writers of that period in proportion). A principal that
  wrote a room keeps paying for its growth while others keep it loaded. The estimate is between saves an
  upper bound (every accepted update counts in full until the next save measures the room
  again). A growing update is checked with the ledger the stamper will write for it counted
  ahead: per shape it writes or deletes one attribution entry and one history line (at most 300
  lines per update), bounded by the shape ids, the writer's id and the longest user id of the
  room (`ledgerBound`, measured by `server/test/fv7/ledger.ts`: a move of 3 000 shapes by another
  user is ~45 KB of update and ~290 KB of ledger; fv6 counted the ledger as 0.3-1.6 x the content,
  so such an update was under-counted and one big image in a new room over-counted). An update
  that only deletes is never refused; what its ledger adds (the attribution and history of the
  shapes it deleted) is charged to the deleter once applied and can take it past its share, and
  the loaded rooms past the thresholds, until the next save measures the room (fv8 P3, Low: a
  delete-only update overshoots its principal's charge by ~12% at most, until that save).
  **Cuts and placement** (fv8 P1/P2). Yjs cuts an item wherever an update names a clock inside
  it (an origin, a right origin, a delete range's ends), copying the item's content (the whole
  points list of a stroke) and moving the client's structs after it; and it places every new
  item by scanning what lies between its origin and its right origin (a map value with no origin
  first walks back the history of its key). The guard counts every cut once per boundary
  (`UpdateCheck.splits`) and bounds their work (`splitWork`: a fixed part per cut, the content
  copied, the structs moved), and bounds the placement scans (`scanWork`: the room items between
  each new item's anchors, plus the update's own items anchored there unless the item only
  continues a run); both are turned into time with costs measured on x86-64
  (`SPLIT_WORK_NS`, `SCAN_WORK_NS`, `APPLY_NS_PER_BYTE` in config.ts, from
  `server/test/fv8/split-cpu-cal.ts`, `split-growth.ts`, `scan-probe.ts`: up to 4.5 ns per element
  copied, 9 us per cut, 190 ns per item scanned, 65 ns per byte integrated). An update over
  `MAX_SPLITS_PER_MESSAGE` or `MAX_APPLY_MS` is refused before anything is resolved (the 3.97 MB
  update is refused in ~175 ms of guard, most of it decoding); the largest one accepted applies
  within its estimate, at most ~1 s, in its room's worker (§12).
  **Merges and deletes** (fv9 A-C). Once an update is in, Yjs merges the structs of one client
  that continue each other (same content class, the right one's origin the left one's last id,
  the same right origin): list contents are concatenated right to left (a run of k items copies
  its tail k times), and every run merged splices the client's struct array (moving the structs
  after it). The guard simulates it: the update's own new structs (and the room's last struct
  of their client), and, per delete range, the room's structs the delete leaves next to each
  other (only ranges that delete something: a full-state step 2 repeats every delete of the
  room and merges nothing). Each merge counts `MERGE_BASE_WORK`, two units per element copied,
  one per `MERGE_MOVE_DIVISOR` structs moved (the merges right of it already removed), and
  every live struct a delete removes `DELETE_WORK` (Yjs marks it deleted, drops its content and
  tries to merge it), measured on x86 (`server/test/fv9/merge-cal.ts`): 3.3-4.8 ns per unit for
  bulk deletes, 3.1-3.2 for runs. An honest encoder never sends structs that continue each other
  (its own Yjs merged them before it encoded them); an honest delete of thousands of shapes that
  one tab created in one session really costs Yjs 0.4-0.8 s (one splice per shape) and is counted
  so: one estimated over `MAX_APPLY_MS` is refused `4413`.
  **The dependency check** (fv9 E) is a worklist: a client block whose next struct lacks a
  dependency waits on that one clock and is woken when it integrates, O(n log n) in the structs
  (it made one pass over every block per struct integrated: 20 000 x 20 000 took 27 s); an update
  of more than `MAX_CLIENTS_PER_UPDATE` blocks is refused before it. What one cut adds to the stored room was measured for every kind
  (`split-growth.ts`): 6-9 bytes with short ids, 22 with 5-byte client ids and clocks; it counts
  32 (`SPLIT_COST_BYTES`), and the guard fuzzer checks on every accepted update that the content
  grew by at most its size plus 32 per cut. The guard itself stays O(update), runs in the room's
  worker under its watchdog and is charged after the message (a 4 MiB message of new shapes costs
  it ~0.9 s on x86, before fv8 too).

- A client that relays someone else's structs (e.g. a tab reconnecting after a server CRASH that
  lost unsaved edits of other people) delivers them in its own step 2: the stamper attributes
  them to the relaying connection, and the relayed client ids get bound to it, so the original
  author's tab is refused `foreign-client` when it reconnects. After a graceful restart nothing
  is lost (the server flushes on shutdown). The ledger is never forged either way: it only ever
  records verified identities. The ways verifications found to crash or freeze the server (fv6
  Q4, loading rooms until the pod was OOM-killed; fv9 A, one 183 KB anonymous message that ran
  the heap out; fv9 D, one 0.72 MB anonymous message that held the event loop 64 s) are refused
  by the memory budget and the guard above, and any path nobody has found yet costs one room's
  worker, which is replaced (§12), never the process: checked on the full system under the
  chart's memory limit (no restart). A crash from outside (a node failure, a kill) still loses up
  to `SAVE_DEBOUNCE_MS` of edits and can relay them as above.
- An id with clocks from a stored document that predates the persisted `writers` bindings is
  bound to its first writer after the upgrade.

## 12. Room isolation (fv9)

Nine verifications found single messages for which Yjs integration (or the guard) is
super-linear: cuts, placement scans, merges of runs and pairs, merges a delete enables,
formatting cleanup, the guard's own dependency check. Each is counted and refused now (§10,
§11), but enumerating Yjs internals cannot prove there is no other. So the damage of any path is
bounded by isolation:

- **One worker thread per loaded room** (`server/src/room-worker.ts`, `RoomCore` in
  `room-core.ts`). It holds the room's two documents and runs everything that decodes or applies
  client bytes: the guard, the apply, the stamper, the encodings for joins, step-1 answers and
  saves. The main thread (`room.ts`, `ws.ts`) does HTTP and WebSocket, authorization, the budgets
  and limits, routing and broadcast; it never decodes or applies a client update. Buffers go to
  and from the worker as transferables. One worker per room (not a pool): a fault costs exactly
  the room whose messages caused it — no other room's messages wait behind it, no other room is
  rebuilt — and its heap limit follows that room. The price: 15.7 MiB and ~70-90 ms per loaded
  room (measured, `server/test/fv9/worker-cost.mjs`), counted in every room's cost (§11), so the
  budget bounds the number of loaded rooms (~57 empty ones with the chart's defaults).
- **Heap limit** (`resourceLimits`): the old generation of a room's worker is one user share (a
  room at the size cap fits it), or the stored room's cost when that is more, plus
  `MESSAGE_COST_FACTOR` x `MAX_MESSAGE_BYTES` (one message being guarded and applied); young
  generation 16 MiB. Whatever a message makes Yjs allocate past that ends the worker
  (`ERR_WORKER_OUT_OF_MEMORY`), never the process. The process must not run with
  `--max-old-space-size`: that V8 flag applies to every thread and overrides each worker's limit
  (measured: a worker limited to 47 MiB ran out of memory at 1 728 MiB under
  `--max-old-space-size=1728`); the heap the budget is derived from is `HEAP_LIMIT_MB`, and the
  server refuses to start when the flag is set (`NODE_OPTIONS` or the command line; it only
  warned before). One client message is processed at a time
  over all rooms (`WORKER_APPLY_CONCURRENCY`; a message holds its slot for its guard and apply),
  so at most one worker is past its room's size at a time: the process holds the loaded rooms
  (≤ 85% of the budget) plus one worker's headroom plus the main thread plus the messages in
  flight (chart `values.yaml`, "Memory"; the chart refuses to render a memory limit that cannot
  hold that for its `heapLimitMb`). Workers get an empty environment (`env: {}`): nothing in them
  reads it, and they do not need the process's secrets.
- **Messages in flight.** A client message waits for its room's queue and the apply slot before
  a worker processes it. On the single-threaded server it was guarded and applied in the
  handler, so the process did not read the socket meanwhile and TCP backpressure bounded what a
  client could make it hold; once messages queued, nothing did (one writer at link speed could
  make it hold hundreds of MiB of Node buffers, outside every V8 heap, and the pod was
  OOM-killed). So every sync step 1, step 2 and update counts from its receipt until it was
  processed (or dropped): a connection, and a principal over all its connections, with
  `max(2 x MAX_MESSAGE_BYTES, 1 MiB)` in flight is no longer read (`ws.pause()`) until that falls
  under (metric `canvas_ws_paused_total{why="connection"|"principal"}`); a message bigger than
  `CPU_SHED_MIN_BYTES` that would take the total past `WORKER_INFLIGHT_BYTES` (64 MiB) is refused
  `1013` `busy` (`canvas_ws_rejected_total{reason="inflight"}`), which is what bounds many
  principals together; a smaller one is taken (an honest edit is never refused for it) and its
  connection, if it has more in flight, is not read until the total is under the cap
  (`why="server"`). What is held is `canvas_ws_inflight_bytes`. Beyond the cap, the bound is one
  message per connection being read when it was paused (the `ws` receiver's frame, at most its
  `maxPayload`, as on any connection).
- **Watchdog.** Every request to a worker has a hard timeout. A client message (guard and
  apply together, one deadline): `WORKER_MESSAGE_TIMEOUT_MS` (1 000; an honest update missed 250
  under CPU contention, and a fresh worker's first message runs unoptimised code) +
  `WORKER_TIMEOUT_NS_PER_BYTE` (1 000) per byte of the message, its apply up to `WORKER_MESSAGE_TIMEOUT_MS` + twice the
  guard's estimate (an upper bound of every path Yjs is known to take); a step 1 the same plus
  `WORKER_OP_NS_PER_BYTE` per byte of the room; an operation on the whole room (load, join
  encodings, saves, a recovery's load and replay) `WORKER_OP_TIMEOUT_MS` (10 s) +
  `WORKER_OP_NS_PER_BYTE` (2 000) per byte of the room. A worker that misses it is terminated
  (V8 interrupts a busy loop).
- **Fault.** On a timeout, an out-of-heap, a crash or an error answer: the message's sender is
  closed `4413` (`too-large`) and struck (§10); the worker is terminated; the room is rebuilt in a
  fresh worker from its **saved objects** (read again from storage once the puts of a save in
  flight are done) plus its **write-ahead log** — every change the documents emitted since that
  save, content and ledger, in order, replayed with an origin the stamper ignores (the ledger is
  replayed, not stamped again) — and never the offending message (it emitted nothing the main
  thread kept: changes are taken in only with a worker's answer). The rebuilt room is the same
  document as the one it replaces: the same content and state vector, its join frames stay valid;
  the ledger's encoding is byte for byte the same, the content's can differ where Yjs merged
  structs in another order under concurrent edits (8 of 168 rebuilds in the review's PoC, each
  the same document; `server/test/fv9.test.ts` checks bytes without concurrent edits, and
  `canvas_worker_recoveries_total{outcome="differs"}` compares state vectors). Then every
  connected client is sent a sync step 1, and its resync budget (the step 1s the server may send
  it for updates that do not integrate, 20) is filled again: the rebuild asked, not the client.
  An honest tab answers with whatever the room lacks (nothing, normally; its edits that queued
  behind the fault are processed after the rebuild). Messages of the room queue meanwhile (the
  room's jobs run one at a time, in arrival order). If the rebuild fails too, every connection
  of the room is closed `1013` (they reconnect and resync) and the room is dropped; its log is
  lost with it (the clients still hold those edits; see §11 on relayed structs).
- **Budgets.** The worker time of a message is charged to its principal's and the server's CPU
  budgets (pre-charged by the estimate, §10); a watchdog fault charges the whole timeout.
- **What it does not cover.** A load is an operation on the whole room: a stored room that a
  worker cannot load within its limits (none is known) fails its joins with `1013`, and keeps
  failing them. A message holds the one apply slot for up to its timeout: other rooms' updates
  wait behind it (the main thread does not), bounded by the CPU budgets and the strikes.

