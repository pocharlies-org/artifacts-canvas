# artifacts-canvas — client ⇄ server protocol

Status: v1, 2026-11-09. Written by the client. The service in `server/` implements the server side.
The reference implementation of every server duty below is the development room server
[`client/dev/yroom.ts`](../client/dev/yroom.ts), tested by
[`client/tests/devroom.test.ts`](../client/tests/devroom.test.ts). When this document and that code disagree,
fix one of them in the same change.

Words: **MUST** / **MUST NOT** are requirements; everything else is advice.

## 1. Routes

All routes live on the artifacts host under the plugin prefix `/_canvas/` (core plugin contract, design §8).
The segment `_/` is reserved for the canvas itself, so an artifact key can never collide with it.

| Route | Served by | What |
|---|---|---|
| `GET /_canvas/<artifact key>` | service | The wrapper page: `client/dist/index.html`, optionally with an inline config (§2). |
| `GET /_canvas/_/assets/*`, `GET /_canvas/_/reporter.js`, `GET /_canvas/_/vendor/html-to-image.js` | service | The static bundle from `client/dist/` (build with `npm run build`; base path `/_canvas/_/`, override with `CANVAS_BASE`). Immutable, cacheable. |
| `GET /_canvas/_/frame/<artifact key>` | service | The artifact HTML with the reporter injected (§3). |
| `WS  /_canvas/_/ws/<artifact key>` | service | The room of that artifact (§4). |

Every route that reveals anything about an artifact (wrapper, frame, ws) MUST first get `allowed: true` from the
core's `POST /_gate/plugin/authz` for that key and the visitor's cookie, and MUST answer exactly like the gate would
for a denied artifact otherwise (no existence leak). Static assets carry no artifact data and need no authz.

Recommended headers on the wrapper page: `Content-Security-Policy: default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self';
frame-ancestors 'self'; base-uri 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
(`connect-src 'self'` covers `wss:` to the same host in current browsers.)

## 2. Wrapper configuration

The client derives everything from the URL: on `/_canvas/runs/x/report.html` the artifact key is
`runs/x/report.html`, the frame is `/_canvas/_/frame/runs/x/report.html` and the socket is
`wss://<host>/_canvas/_/ws/runs/x/report.html`. The service MAY override any field with an inline element in the
wrapper HTML (JSON, HTML-escaped):

```html
<script type="application/json" id="artifacts-canvas-config">
{"artifactPath":"runs/x/report.html","title":"Nightly report","pageWidth":980,"lang":"es","maxImageBytes":2097152}
</script>
```

Fields: `artifactPath`, `room`, `frameUrl`, `wsUrl`, `vendorUrl`, `shareUrl`, `pageWidth`, `title`, `lang`
(`es` default, `en`), `maxImageBytes`, `dev` (never `true` in production: it enables a local identity and the
`?as=` / `?room=` / `?artifact=` query parameters).

## 3. Frame: the artifact, isolated

The client renders `frameUrl` in `<iframe sandbox="allow-scripts">` — never `allow-same-origin` — so the artifact
runs in an opaque origin: no cookies, no storage, no same-origin access to the wrapper. The frame response MUST also
carry `Content-Security-Policy: sandbox allow-scripts` (defence in depth; the same header the host already stamps on
artifacts) and `Cache-Control: no-store`.

**Reporter injection.** The service MUST insert `client/dist/reporter.js` (or `client/public/reporter.js`; same
file) as an inline `<script>` right after the opening `<head>` tag (fallback: after `<!doctype>`, else at the very
start), escaping `</script` as `<\/script`. Reference: `injectReporter()` in `client/dev/plugin.ts`. Non-HTML
artifacts (PNG, PDF, text) are out of scope for v1; the service may wrap them in a minimal HTML page.

**Why** (design §7 "scroll and size"): the iframe is laid out at a fixed page width (`pageWidth`, stored in the
document so every participant gets the same layout) and sized to the artifact's full content height. It never
scrolls; the canvas camera pans and zooms the iframe and the drawings together, so world coordinates are artifact
CSS pixels and annotations stay on the element they were drawn on. Wheel and touch go to the canvas; the artifact
is view-only inside the wrapper (the plain artifact link still works for interacting with it).

**postMessage.** Only the following, validated on both sides (`event.source` is checked; payloads are clamped):

| Direction | Message |
|---|---|
| frame → wrapper | `{source:'artifacts-canvas-reporter', type:'size', w, h}` content size, on load and on every resize |
| frame → wrapper | `{source:'artifacts-canvas-reporter', type:'title', title}` |
| frame → wrapper | `{source:'artifacts-canvas-reporter', type:'scroll', x, y}` the artifact tried to scroll (anchor link): the wrapper pans there |
| wrapper → frame | `{source:'artifacts-canvas', type:'snapshot', id, rect:{x,y,w,h}, scale, lib}` export request; `lib` is the `vendorUrl` |
| frame → wrapper | `{source:'artifacts-canvas-reporter', type:'snapshot', id, dataUrl}` a `data:image/png` of `rect`, or `null` |

The snapshot uses `html-to-image` (SVG `foreignObject`, no extra iframe, so it works in the sandbox). Images the
artifact loads from other origins cannot be captured from an opaque origin and appear blank in exports.

## 4. WebSocket room

`WS /_canvas/_/ws/<artifact key>?anon=NNNN` — one room per artifact key. The client is the stock `y-websocket`
client (`WebsocketProvider`, BroadcastChannel disabled), so the room speaks the standard y-websocket protocol:
every message is `varUint type` + payload.

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

- Identity comes from the authz answer (`user: {id, name, anonymous}`), never from anything the client sends.
- `anon=NNNN` is the pseudonym the visitor keeps in `localStorage` (`artifacts-canvas:anon`, 4 digits). The server
  MAY use it for anonymous connections (`anon:NNNN`, after checking `^\d{4}$`) and MUST ignore it for logged-in ones.
  Anonymous connections are allowed only for `pub/` keys while `anonymousPubEnabled` is true.
- Close codes (RFC 6455 private range; the client does not reconnect on 44xx): `4401` unauthenticated,
  `4403` forbidden (authz denied, revoked, or a forbidden write, §5), `4404` artifact gone, `4410` expired,
  `4413` document/message too large, `4429` rate-limited. `4503` = restarting, client reconnects. Send a NOTICE
  before closing when there is something to tell the user.
- Re-check authz every few minutes and on ACL change; on a deny send NOTICE `revoked`/`expired` and close 4403/4410.
- Without an IDENTITY message the production client stays read-only (it shows the document but never writes).

## 5. Attribution: server-stamped, never client-written

Attribution must not be forgeable (design §4), so clients never write it. In production the server announces
`attribution: 'server'` and MUST:

1. **Apply each client update with the connection as transaction origin**
   (`Y.applyUpdate(roomDoc, update, conn)`).
2. **Stamp** after every such transaction: run `attachStamper(roomDoc, {userOf: origin => conn identity})` from
   [`client/src/model/stamper.ts`](../client/src/model/stamper.ts) (import it if the service is TypeScript, or port it;
   the algorithm is 120 lines). It writes, with origin `artifacts-canvas:stamper`:
   - `attribution[shapeId] = {createdBy, createdAt, updatedBy, updatedAt}` (ms epoch; `updatedAt` refreshed at most
     every 5 s per user; the entry is kept when the shape is deleted so an undo restores the original author),
   - `users[userId] = {name, anonymous, color?}` for the user who made the change,
   - `history.push({t, by, verb, shapeId, shapeType, geo?, highlight?, owner?})`, verbs
     `create | move | resize | rotate | edit | style | delete | order | group | lock`, rate-limited per
     (user, shape, verb) to one line per 10 s, the author's own creation gesture coalesced, capped at 300 entries.
   These stamper transactions are broadcast to every connection, including the sender.
3. **Reject client writes to `attribution`, `users` and `history`**: before applying an update, call
   `forbiddenRootWrite(roomDoc, update)` (same file). It decodes the update and returns the root name if any
   insertion or deletion touches those types. Then close the connection with `4403` and do not apply the update.
4. **Overwrite the awareness `user` field** of every awareness update from a connection with that connection's
   identity (`awarenessProtocol.modifyAwarenessUpdate`), so live cursors and labels cannot lie either.

`attribution: 'client'` exists only for development against a plain relay (e.g. `npx y-websocket`): the client then
runs the same stamper for its own transactions. Never announce it in production.

## 6. Document schema (Yjs)

| Root | Type | Written by | Content |
|---|---|---|---|
| `shapes` | `Y.Map<Y.Map>` | clients | one Y.Map per shape, key = shape id |
| `assets` | `Y.Map<string>` | clients | pasted images as data URLs, key = asset id (client caps at `maxImageBytes`, default 2 MiB, downscaled to ≤1600 px) |
| `meta` | `Y.Map` | clients | `pageWidth` (set once by the first client) |
| `attribution` | `Y.Map<Attribution>` | server | §5 |
| `users` | `Y.Map<UserInfo>` | server | §5 |
| `history` | `Y.Array<HistoryEntry>` | server | §5 |

Shape map fields (types in [`client/src/model/types.ts`](../client/src/model/types.ts)): `id`, `type`
(`draw | line | arrow | text | note | geo | frame | image`), `x, y, w, h, rotation` (radians), `index` (z order),
`groupId`, `locked`, style keys `color, fill, dash, size, font, arrowheads, opacity`, and per type:
`points: Y.Array<number>` (flat `x, y, pressure`, appended live while drawing), `highlight, ow, oh, done, pen`
(draw); `start, end: {x, y, bind?: {shapeId, nx, ny}}, bend` (line/arrow); `text: Y.Text` (text, note, geo label),
`fixedWidth` (text); `geo` (geo); `name` (frame); `assetId` (image).

The laser pointer, cursors, viewports, presenting and following live **only in awareness**, never in the document:

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

## 7. Limits the server should enforce (advice)

Per room: document size (e.g. 20 MiB; NOTICE `too-large` + close 4413), message size (e.g. 8 MiB, the dev server's
`maxPayload`), update rate per connection (e.g. 120 msg/s burst, NOTICE `rate-limited`), connections per room and per
anonymous visitor. Persist with a debounce (a few seconds) plus on room close; delete the stored document when the
authz answer says the artifact is gone or expired (design §6.3).
