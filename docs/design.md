# Shared live canvas on artifacts — design

- Date: 2026-11-09
- Owner: the project owner
- Repos (GitHub, public, Apache-2.0, copyright Daniel Ibáñez):
  - `pocharlies-org/artifacts` — the artifacts system (gate + publisher + MCP + plugin contract), extracted and generalised
    from earlier private prototypes.
  - `pocharlies-org/artifacts-canvas` — this canvas, as the first plugin of `artifacts`.
- Status: approved to start by the owner on 2026-11-09.
- Approved UI mockup: `docs/mockups/2026-11-09-lienzo-set-completo.html` in `artifacts-canvas`. The owner approved it as is.
- Wherever this document says "the gate" or "`gate/gate.py`", read: the gate of `pocharlies-org/artifacts`.
  §5 summarises the constraints of the reference deployment.

## 1. Intent and why

The owner wants a tldraw-style drawing canvas (https://tldraw.dev) **on top of every artifact** served by
the artifacts host. The canvas is one system with two uses, which the owner sees as the same thing.

1. **Annotation at any time, with attribution.** People draw on an artifact and the canvas keeps who drew what.
2. **Live use in meetings and presentations.** Someone presents an artifact and the others annotate on it while it
   is shown.

The owner decided the following:

- **Real-time multiplayer, Miro-style.** Strokes appear live on every screen, like a collaborative whiteboard.
- **One shared canvas per artifact.** Everyone sees every annotation, live and later. There are no per-person or
  per-meeting layers: one live shared canvas.
- **Who may draw: anyone who can see the artifact.** People with an Entra login draw under their real name.
  Visitors of anonymous `pub/` artifacts draw too, as anonymous users.
- **The full tldraw toolset from day one.** No reduced first release: every tool is there for the first meeting.
- **The mockup is approved as is**, including the parts the designer proposed: the authors panel with filter and
  history, *Presentar* / *Seguir a*, and export.
- **Drawings live as long as the artifact and die with it.** When the artifact expires (ILM `ttl` tag, the 90-day
  catch-all, or `.acl.json` `expires`), its canvas is gone too.

### Clone the functionality, not the code

The tldraw SDK license needs a visible "Made with tldraw" watermark unless a commercial license is bought. The canvas
is a **re-implementation of tldraw's functionality**, not a copy of its code. Reverse-engineering tools can be used to study how
tldraw behaves (tools, shortcuts, snapping, arrow binding, styles). No tldraw source, assets or fonts go into this
repo. Open-source libraries under permissive licences (MIT/Apache/BSD, e.g. `perfect-freehand`, Yjs) are allowed.
Check every licence before you add the dependency.

## 2. Goals

### G1. The canvas UI (as in the approved mockup)

**Tools** in a bottom toolbar, each with its tldraw shortcut:

| Tool | Shortcut | Notes |
|---|---|---|
| Select | V | Click, marquee, shift-add; move, resize, rotate |
| Hand / pan | H | Space-drag pans from any tool |
| Freehand pen | D | Pressure-like smoothing (perfect-freehand style) |
| Highlighter | ⇧D | Translucent marker under the other strokes |
| Eraser | E | Erases whole shapes it touches |
| Arrow | A | Binds to shapes; when a shape moves, its arrow follows |
| Line | L | |
| Text | T | |
| Sticky note | N | Coloured note with editable text |
| Rectangle | R | |
| Ellipse | O | |
| More shapes | — | Triangle, diamond, star, cloud, check, cross, and the rest of tldraw's geo set |
| Frame | F | Named area that groups content |
| Image | — | Paste or drop a screenshot or image |
| Laser pointer | K | Fading trail. Visible to everyone, never stored |

**Style panel**, applies to the selection or to the next shape: colour (12 swatches), fill (none / semi / solid /
pattern), stroke (solid / dashed / dotted / sketchy), size (S / M / L / XL), font (hand / sans / serif / mono),
arrowheads, opacity, bring to front / send to back, group / ungroup, lock / unlock.

**Canvas controls**: undo / redo (⌘Z / ⇧⌘Z), zoom in / out, zoom percentage, zoom to fit, minimap.

**Undo is per user.** It only reverts my own changes, never someone else's. This is the CRDT undo-manager default.

### G2. Live collaboration

- Strokes appear on every connected screen while they are drawn, not only when the stroke ends.
- Every participant has a **live cursor** labelled with their name, or with the anonymous pseudonym.
- Presence avatars sit top right.
- **Presentar.** The presenter's viewport (scroll and zoom) becomes the one the others follow.
- **Seguir a <persona>.** I follow one participant's viewport until I pan or zoom myself.
- Two people who edit the same shape at the same moment converge to the same result without losing either stroke.
  This is the reason for a CRDT.

### G3. Attribution

- Each shape stores `createdBy` (UPN or anonymous pseudonym), `createdAt`, `updatedBy` and `updatedAt`.
- On hover, the shape shows "*<shape type> · dibujado por <name> · <time> · editado por <name> <time>*".
- A small coloured name tag next to a shape shows who drew it. The colour is stable per person.
- **Authors panel (left)**: lists everyone who drew, with their shape count and an eye toggle that hides or shows
  that person's shapes. The toggle is local to my view.
- **History**: a timeline of changes ("10:17 Marta añadió una nota", "10:16 Ana movió un rectángulo de Iván").
- Anyone who can draw may also move, edit and delete anyone's shapes, as in tldraw and Miro. Attribution records who
  did it.

### G4. Identity

- **Entra users**: the real display name and UPN, from the same login the artifact already uses.
- **Anonymous (`pub/` without login)**: a pseudonym "Anónimo NNNN" kept in the visitor's browser, so two anonymous
  people in the same meeting are not mixed up. The pseudonym is **the designer's call**; the owner did not reject it.
- **Attribution must not be forgeable.** An Entra user's name always comes from the server-verified identity, never
  from the client. An anonymous client must not be able to claim a real UPN.

### G5. Overlay, artifact untouched

- The canvas is a layer above the artifact. Nothing is drawn into the artifact file, and already published artifacts
  work without being republished.
- Strokes are anchored to the artifact's content: when the artifact scrolls, the drawings move with it.
- A toggle hides or shows all annotations ("Anotaciones: visibles ▾").

### G6. Export

- Export the artifact plus its annotations to **PNG** and **PDF**, from the current view or the whole artifact.
  This is the designer's proposal and was approved with the mockup.

### G7. Persistence

- The canvas survives reloads and reconnections. A person who opens the artifact next week sees everything drawn
  before.
- The canvas is deleted when its artifact expires. It never outlives the artifact.

## 3. Non-goals

- Not a standalone whiteboard product. There are no canvases without an artifact underneath.
- No per-meeting or per-person layers or versions (rejected by the owner).
- No edits to the artifact's own content.
- No new permission model. **Who sees a canvas = who sees the artifact**, decided by the existing gate rules.
- No canvas on the old storage host. Only the artifacts host.
- No audio, video or chat.

## 4. Anti-goals (a failure even if everything "works")

- **A permission leak.** The canvas or its storage must never show anything about an artifact (content, existence,
  drawings, who drew) to someone the gate would deny.
- **Weaker artifact isolation.** Today every artifact is served with `Content-Security-Policy: sandbox
  allow-scripts`, which gives it an opaque origin: no cookies, no storage, no same-origin fetch. That must stay true.
  Artifact HTML must never run in an origin that holds the Entra session cookie or can reach the canvas API with the
  user's identity.
- **Forged attribution.** One user must not be able to draw as another.
- **"Made with tldraw" or copied tldraw code.**
- **Toy behaviour.** Strokes that lag visibly, that vanish on reconnect, or a canvas that drifts off the artifact
  when you scroll.
- **Breaking what exists today.** Plain artifact links, `pub/` anonymous reads, request-access, the
  `scripts/smoke-artifacts.sh` pin and the gate test suites must keep working.

## 5. Constraints (from the reference deployment)

The first deployment of `artifacts` is a private one; its values live outside this repository. The constraints
that shape the canvas are:

- **Artifacts are sandboxed.** The artifacts host stamps `Content-Security-Policy: sandbox allow-scripts` on every
  artifact response. An artifact page cannot hold cookies, storage or same-origin calls, so the canvas cannot run
  inside the artifact's own document. It needs its own page.
- **The gate** is one small, stdlib-only, auditable process with a public listener (request-access) and an internal
  forwardAuth listener. It keeps its state in the bucket under its own prefix with a least-privilege S3 user. It has
  no WebSocket support and should stay small.
- **Identity** comes from an OIDC proxy in front of the host (host-only session cookie, UPN in
  `preferred_username`, group ids in the `groups` claim). The gate authenticates by calling the proxy with the
  visitor's cookie and never trusts client-supplied `X-Auth-Request-*` headers.
- **Authorization** is the gate's `decide()` (owner / users / groups / expires / `pub/` without ACL). The canvas must
  reuse this exact logic, not a copy that can drift.
- **`pub/` is anonymous** while the host is private-network only. `anonymousPubEnabled` must turn false before any
  public hostname or tunnel. **Anonymous drawing must follow the same flag.**
- **Expiry**: lifecycle `ttl=1|7|14|30` tags, a 90-day catch-all for untagged objects, and the ACL `expires` field.
- **Runtime**: Kubernetes with Traefik v3 IngressRoutes, digest-pinned images, namespaced RBAC. Object storage
  accepts ingress only from the proxy, SSO and storage namespaces.
- **Secrets** never go in git.
- **Tests and smokes** stay green and are extended (unit, e2e and the artifacts smoke scripts).

## 6. How: decided so far

The owner decided the product items in §1–2. The items below are the **designer's calls**. The owner accepted them
as a direction, but a builder may change one with a stated reason.

### 6.1 A wrapper page per artifact (designer's call)

- A new page, for example `https://the artifacts host/_canvas/<artifact path>`, serves the canvas app.
- The artifact is shown inside it, in a sandboxed iframe (opaque origin, `allow-scripts` only, as today), and the
  canvas is a layer above.
- The plain artifact URL keeps working with no canvas. The wrapper is how people open an artifact to draw on it.
- **The builder decides how links reach the wrapper**: a button on artifacts, wrapper links from
  `publish-run-artifact`, or a redirect.

### 6.2 Realtime: a new canvas service with a CRDT (designer's call)

- A new small service, `artifact-canvas`, next to the gate. It holds the WebSocket rooms, one room per
  artifact.
- Sync uses a CRDT. **Yjs** is the reference choice: its `y-websocket` protocol, awareness for cursors, presence,
  laser and follow, and its UndoManager for per-user undo. A comparable MIT/BSD CRDT is acceptable.
- The service is a separate process so the gate stays stdlib-only. The service's language is the builder's call.
  The authorization decision must be the gate's: either the service asks the gate (a new internal endpoint on the
  8081-style listener, never public) or it imports the same `decide()`. Never a re-implementation.
- Authorization is checked when the WebSocket connects and again **every few minutes or on ACL change**, so a
  revoked user or an expired artifact drops out of an open room.
- **Two trust domains per room (builder's decision after three verifications, 2026-11-10).** Clients write raw Yjs
  updates, so a single Y.Doc that held both the drawings and the server-stamped attribution forced the server's
  write guard to out-think every Yjs integration path; three independent verifications in a row bypassed it
  (items without a parent, parked pending structs, zero-length structs) to forge or erase attribution. Each room is
  therefore **two documents**:
  - the **content** document (`shapes`, `assets`, `meta`) — the only one a client writes. The server still guards it,
    but only for schema/size safety and pending-state hygiene;
  - the **ledger** document (`attribution`, `users`, `history`, `writers`) — written only by the server's stamper,
    which observes each content transaction (applied with the sending connection as origin) and attributes what it
    changed to that connection's verified identity. Clients receive the ledger read-only on its own message type;
    the server never applies a client byte to it and closes any client that sends one (protocol §4, §5).
  Attribution integrity no longer depends on the guard being complete: whatever a guard bug lets into the content
  document, it cannot name an author or touch an existing ledger entry.

### 6.3 Storage next to the artifact (designer's call)

- The canvas state is a binary file next to the artifact in the same bucket, under a prefix the gate never serves,
  for example `_canvas/<artifact key>.ydoc`, or `<dir>/.canvas/<file>` excluded like `.acl.json`. Built:
  `_plugins/canvas/<artifact key>.ydoc` (content) plus `_plugins/canvas/<artifact key>.ydoc.ledger` (ledger, §6.2),
  same `ttl` tag, both deleted together; a stored single-document canvas from before the split is migrated on load.
- Written by the canvas service with its own least-privilege MinIO user: Get/Put on that prefix only.
- **Expiry follows the artifact.** The canvas object copies the artifact's `ttl` tag. When the ACL has `expires`, or
  the artifact is gone (HEAD fails), the service refuses the room and deletes the canvas. A periodic sweep removes
  orphans.
- Images pasted onto the canvas are stored under the same canvas prefix with the same expiry, behind a size cap.

## 7. Left to the builder

- Front-end stack and build. Raw TS + Canvas/SVG or a small framework. The bundle is self-contained, served by the
  canvas service or from MinIO, and pinned.
- **How the overlay follows the artifact's scroll and size** when the artifact is in an opaque sandboxed iframe. One
  option: the canvas service reads the artifact HTML server-side, after the same authorization, and renders it via
  `srcdoc` into a sandboxed iframe, with a tiny injected script that only `postMessage`s content size and scroll.
  Another: size the iframe to the full content height so the wrapper scrolls. Any option is fine if the §4
  isolation anti-goal holds, verified by a test.
- Non-HTML artifacts (PNG, PDF, txt): whether and how they get a canvas. HTML is the must-have.
- The exact wire protocol, snapshot and compaction cadence, and room lifetime.
- Abuse limits for anonymous `pub/` drawing: room size, message rate, document size, image size.
- Export implementation (G6).
- Tests: unit, an e2e that drives two browsers (strokes visible on both, attribution correct, deny cases), and new
  smoke negatives (no canvas or storage access without the gate's allow, no anonymous drawing outside `pub/`).

## 8. Product split and the plugin contract (the owner, 2026-11-09: the canvas is an extra plugin of the artifacts)

`artifacts` (core) is a generic, self-hostable product with **no deployment specifics in git**: hostnames,
tenant/app/group ids, IPs, subscriptions, bucket names and Slack ids all come from config (Helm values / env), with
neutral examples (`artifacts.example.com`). Fresh git history; nothing is pushed until a secret/identifier scan is
clean. Each deployment keeps its values in a private repo (out of scope here).

The core exposes to plugins (designer's call; builders may refine with a stated reason):

1. **Authorization API** (internal listener only, never routed publicly): `POST /_gate/plugin/authz` with the
   visitor's forwarded cookie and the artifact path → `{allowed, reason, user: {id, name, anonymous}, artifact:
   {key, expires, ttl}}`. Uses the one and only `decide()`. Anonymous is allowed only for `pub/` keys and only while
   `anonymousPubEnabled` is true. Plugins call it on connect and periodically.
2. **Routes**: a plugin is declared in values (`plugins: [{name, pathPrefix: /_<name>/, service, port}]`); the chart
   renders its route on the artifacts host. The core never proxies plugin traffic itself.
3. **Storage**: each plugin gets the bucket prefix `_plugins/<name>/` and its own least-privilege S3 user
   (Get/Put/Delete on that prefix only). The core never serves `_plugins/`.
4. **Expiry**: the authz answer carries the artifact's expiry; plugins must delete their data when the artifact is
   gone or expired (plus their own sweep). The core's ILM catch-all also covers `_plugins/`.
5. **Discovery**: the publisher CLI and the MCP return, next to the artifact link, one link per enabled plugin
   (e.g. "open with canvas").

## 9. Process

Personal project in `pocharlies-org`: implementers per closed block — implementers per closed block,
an independent verifier, and a mandatory security pass (auth, anonymous writes, new surface, public repo scrub).
Agents merge their own PRs after review. Deploying it is a later, separate change; nothing live is touched in this phase.
