# Known issues

Findings of the seventh independent verification (fv7) that are not fixed yet. They were
published as known issues on purpose: none of them crashes the server or loses data, and
F1 is the one to fix first. Each entry below is meant to become one GitHub issue.

- [ ] **F1 — Room memory budget charging lets one user hold the whole budget (High,
  availability).** Three pieces of the accounting do not add up. Growth of a room is charged to
  the writer as `extra / room.principals.size` (`server/src/rooms.ts:241`), `held()` divides a
  room's cost by the number of principals in it (`rooms.ts:161-163`), and nothing re-charges the
  writer when the others detach (`server/src/room.ts:297`): the cost of a room grown while
  others sat in it falls back on nobody. Growth is allowed up to 100 % of the budget
  (`rooms.ts:240`) while loads stop at 90 % (`LOAD_FRACTION`, `rooms.ts:183`), so growth can
  eat the margin that loads need. And the `share()` floor, `cost(1.25 × maxDocBytes)`
  (600 MiB), is more than half of the 920 MiB budget of the 2 GiB default, and the whole
  budget at 1 GiB, so the per-principal share is not a real fraction there.
  Scenario: one user opens several rooms while others are in them and grows them (the charge
  is split among the people present), the others leave, and that user now keeps loaded most of
  the budget while being charged a fraction of it. Every new room load, for everybody, is then
  refused with 1013 busy until some of those rooms are evicted. No crash, no data loss.
  Suggested fix: charge growth in full to the writer and keep that charge after the others
  leave (re-charge on detach, or account per room and attribute it to the principal that grew
  it); keep growth below the load threshold (`LOAD_FRACTION`) so loads always have room; make
  the per-principal share a real fraction of the budget with a clamped per-room cap instead of
  a floor of one maximal room; log a warning at start when the budget is smaller than one full
  room.

- [ ] **F2 — The cost factors underestimate some shapes (Medium).** `ROOM_COST_FACTOR` and
  `MESSAGE_COST_FACTOR` (both 24, `server/src/config.ts:399` and `:405`) turn encoded bytes
  into resident bytes. Some shapes measure above that: up to 39.5× for a room and about 50×
  for one message, so the budget can admit more rooms than the heap holds for those shapes.
  No out-of-memory was reached at the 2 GiB default, but the margin is thinner than the
  documentation says.
  Suggested fix: raise the factors to about 40 (room) and 50 (message), or count Yjs structs
  (items) instead of bytes, which is what the memory follows.

- [ ] **F3 — The global anonymous-mint bucket can be starved by many IPs (Low/Medium).**
  `AnonMint.mint` (`server/src/anon.ts:64-71`) takes a token from the global bucket of the
  route and from the bucket of the IP. A caller spreading attempts over many IPs (a /64 of
  IPv6 addresses is one per address) empties the global bucket, and honest visitors without a
  cookie are then refused with 1013 on that route. Tokens are also spent by attempts that fail
  afterwards.
  Suggested fix: bucket IPv6 addresses per /64 instead of per address, and do not spend a
  global token on an attempt that fails (take it only once the principal is minted).

- [ ] **F4 — Stalled peers are dropped only under outgoing-budget pressure (Low).** A socket
  that stops reading is dropped only when the outgoing budget is under pressure. Until then it
  keeps its queued frames and its connection slot, and they stay bounded by the outgoing
  budgets, so memory is not unbounded.
  Suggested fix: also drop a peer whose send queue has not drained for a fixed time
  (for example 30 s), under pressure or not.

- [ ] **F5 — The per-IP mint limit of 10 per minute hits users behind a NAT (Low).** A class
  or an office of 40 people with no cookie yet shares one IP: the first 10 get their cookie,
  the rest retry on 1013 and need about 3 minutes in all.
  Suggested fix: raise `ANON_IP_MINT_RATE_PER_MIN` and `ANON_IP_MINT_BURST` (or give an IP a
  larger burst than its steady rate) and leave the global bucket as the real bound, or mint the
  cookie on the wrapper page, once per browser, instead of on every WebSocket join.

- [ ] **F6 — A transient core authorization failure closes honest users with 4403 (Low).**
  `recheck` (`server/src/ws.ts:1001`) treats every `allowed: false` as a revocation, and the
  authz client fails closed, so a timeout or a 5xx of the core (`core_error`, `malformed`) is
  also `allowed: false`. The user gets the `revoked` notice and 4403, which the client does
  not reconnect from, although nothing was revoked.
  Suggested fix: when the reason is `core_error` or `malformed`, do not close for revocation:
  keep the connection and check again on the next tick, or close with 1013 so the client
  reconnects.

The findings of the sixth independent verification (fv6) are fixed: H-1 (no bound on the rooms
loaded at once: one ACL member opening and filling rooms OOM-killed the pod in a loop; now a
loaded-room memory budget derived from the V8 heap limit, a per-principal share, idle rooms
evicted first, and a room left loaded by a socket that closed during the load), M-A (unlimited
minting of anonymous principals with HEAD requests, and a full re-encode of the room for every
join after a version bump; now a mint rate per IP and per route, joins refused while their
principal is in CPU debt, encodes shared as snapshot + tail and charged server-wide), L-A (paused
sockets held the outgoing budget and honest joins were refused; now stalled peers are dropped
first), L-B (Yjs undo/redo threw to the UI) and L-C (the room's sync step 1 encoded the whole
room). Their regressions live in `server/test/fv6.test.ts` (with the verifier's attackers in
`server/test/fv6/`), `client/tests/fv6.test.ts` and `e2e-system/adversarial-fv6.spec.ts`.

The findings of the fifth independent verification (fv5) are fixed: H-1 (slow readers held
the server's memory), M-1 (offline paste/undo/paste refused), M-2 (a keystroke while
reconnecting refused as pending), M-3 (the editor let more than 10 000 characters through),
M-4 (unsorted / duplicated delete ranges), M-5 (CPU budget per connection only), M-6 (one
cookieless client locked anonymous visitors out with a terminal 4429), M-7 (unbounded awareness
states), L-1 (text-length bypass with a repeated delete range) and L-2 (delete-only updates
past the size cap). Their regressions live in `server/test/fv5.test.ts` (with the honest-edit
fuzzer `server/test/fuzz/honest-fuzz.ts`), `client/e2e-server/fv5.spec.ts` and
`e2e-system/adversarial-fv5.spec.ts`. Fixing H-1 also found that every evicted room stayed in
memory (its awareness interval was never cleared), and the honest-edit fuzzer found that Yjs'
redo writes contradictory origins that made a reloaded room diverge from the tabs (the client
now rewrites them: `client/tests/fv5.test.ts`); both fixed.

Findings of the fourth independent verification (fv4) that are not fixed yet. The High ones
(H1 sync step-1 amplification, H2 O(room) guard slow path, H3 cubic text wrap) and M2, M3, M4,
L6 (core) and L7 are fixed; their regressions live in `server/test/fv4.test.ts`,
`client/tests/fv4.test.ts` and `e2e-system/adversarial-fv4.spec.ts`. Each entry below is
meant to become one GitHub issue.

- [ ] **M1 — Crash relay re-attributes unsaved edits (Medium).** After a crash with nothing
  flushed, the first tab to reconnect delivers other people's unsaved structs in its own
  step 2: the ledger credits it with `createdBy` of the victim's shape, `writers[victim id]` is
  bound to it, and the victim's next edit is closed `4403` (no auto-reconnect). Bounded by
  `SAVE_DEBOUNCE_MS` (2 s by default) and by needing a crash. fv6 found a way to cause one at
  will (Q4: open and fill rooms until the pod is OOM-killed); with the loaded-room memory budget
  that is refused (shown on the full system under the chart's 2 GiB limit, no restart) and no
  other way is known: the crash has to come from outside (a node failure, a kill) (protocol
  §11). PoC: `poc7-crash-relay.ts`.
  Suggested fix: save the ledger more often than the content, or write ahead the `writers`
  bindings; on reload, refuse relayed structs for client ids the relaying principal never
  bound instead of binding them to it.

- [ ] **L1 — Writer-id takeover while the victim is disconnected (Low).** `Room.mayWrite`
  (`server/src/room.ts`) only blocks an unbound client id while another principal's live
  connection announces it in awareness. Eve wrote with Bob's announced client id before Bob's
  first edit while Bob was offline; Bob's offline shape was then dropped silently (his
  connection stayed open, the room has no `B1`). PoC: `poc6-ledger-semantics.ts` (6b).
  Suggested fix: bind an announced id to its principal (in the ledger) when the awareness
  claim arrives, not on the first write; or refuse new client ids from a principal that
  announced none.

- [ ] **L2 — A failed save at last leave still evicts the room (Low).** `RoomManager.leave`
  (`server/src/rooms.ts`) drops the room after `flush()` even when the save failed: the unsaved
  edits are lost and then relayed by the next tab as in M1.
  Suggested fix: keep the room (and retry the save with backoff) while it is dirty after a
  failed flush; evict only once a save succeeded or after a bounded number of retries, with a
  metric and an error log.

- [ ] **L3 — Draw strokes are expensive to render (Low).** The largest stroke the server accepts
  (`MAX_POINTS` = 300 000 numbers, a ~600 KB update) renders to 44.5 MB of SVG. Bounded by the
  size cap, so not superlinear. PoC: `poc5-points-render.ts`.
  Suggested fix: simplify long strokes before rendering (e.g. Ramer-Douglas-Peucker to the
  screen resolution) and lower `MAX_POINTS` to what a real gesture produces.

- [ ] **L4 — Delete and re-create of a shape id keeps the original `createdBy` (Low, design).**
  `stampTransaction` (`shared/src/stamper.ts`) treats a re-inserted id as an undo of the delete
  and keeps the first author. The ledger ends in the same state as editing the shape in place,
  and the history records it honestly (`delete`/`create` by the second user, `owner` = the
  first). PoC: `poc6-ledger-semantics.ts` (6a).
  Suggested fix: only keep `createdBy` when the re-inserted map is the undo of the delete
  (same content item restored by the UndoManager); otherwise start a new attribution.

- [ ] **L5 — History keeps only the last 300 entries (Low).** `historyLimit` (default 300 in
  `shared/src/stamper.ts`): a writer can scroll the record of who deleted what out of the
  window by making 300 small changes. Attribution entries survive.
  Suggested fix: cap history by age and per author instead of a global count (or keep delete
  lines longer than the rest), and persist trimmed lines to an append-only object if the
  audit trail matters.
