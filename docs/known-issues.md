# Known issues

Findings of the eighth independent verification (fv8) that are not fixed yet. None of them
crashes the server, loses data or makes a room unloadable. Each entry below is meant to become
one GitHub issue.

- [ ] **P3 — A delete-only update overshoots its principal's charge until the next save (Low).**
  An update that only deletes is never refused and is charged once applied by what its ledger
  adds (the attribution and history of the shapes it deleted); the verifier measured up to +12%
  of the deleter's charge, given back by the next save (at most `SAVE_DEBOUNCE_MS` later). It
  can take a principal a little past its share, and the loaded rooms past the thresholds, for
  that long (protocol §11).
  Suggested fix: count the ledger of a delete ahead like a growing update's (`ledgerBound`) and
  refuse it with 1013 only when the principal is already at its share.

- [ ] **P4 — A delete's credit at the save goes to the co-writers of that save period (Low).**
  The save shares what the room really changed by among the principals that wrote since the
  previous save, in proportion to their estimates: when one of them deletes a big image and
  another one drew in the same period, part of the deleter's credit goes to the drawer (the
  verifier: a deleter kept 87 MiB charged for a deleted 2 MiB image). Bounded by the deleter's
  own estimates and corrected as soon as the room is evicted; nobody is charged for what others
  wrote beyond that period.
  Suggested fix: settle per update (each update's own measured change, from Yjs' encoding of the
  transaction) instead of per save period.

- [ ] **The load charge moves to whoever keeps a room open (Low, design of the U2 fix).** When
  the principal paying a room's load cost leaves while others keep the room open, the cost moves
  to them, within their shares (protocol §11). A signed-in co-viewer who keeps reading a big room
  after its loader left therefore holds part of its share for it, and may be refused `1013` when
  opening another big room until it leaves that one. What a principal wrote is never moved.
  Suggested fix: none planned; charging nobody would let loaders fill the budget through sitters
  (fv7 F1).

- [ ] **The fv6 server suite outgrows the default Node heap in its vitest fork (Low, tests only).**
  `server/test/fv6.test.ts` loads rooms up to its 64-256 MiB test budgets and, in its last test
  (q5), holds paused sockets' outgoing buffers, all inside one vitest fork (`pool: 'forks'`,
  files sequential). On x86 with Node 22, whose default heap limit is 4 GiB whatever the RAM,
  the fork reaches it during q5 (~4.5 GB RSS, `FATAL ERROR: Reached heap limit ... JavaScript heap
  out of memory`, vitest reports `Worker exited unexpectedly` and `npm test` fails although 222
  of 223 tests passed); the same happens at the fv7 head (5a1ab8c), so fv8 did not cause it. An
  M-series Mac (Node 26, ~3.9 GB RSS) and GitHub's runners pass. Workaround:
  `NODE_OPTIONS=--max-old-space-size=8192 npm test` (the forks inherit it).
  Suggested fix: split the file per finding (each file gets a fresh fork), release the rooms and
  test clients of each test, and lower q5's outgoing budget.

The fv8 findings P1, P2, U1 and U2 are fixed:

- [x] **P1 — Inserts that cut live items were not counted: one update made a room unloadable
  for everyone (High, introduced by the fv7 branch).** The guard counted cuts only for delete
  ranges and the server estimated an update's growth as its size plus 24 B per such cut. One
  3.97 MB update inserting a point between every two points of two 100 000-point strokes was
  estimated at 4.28 MiB (under the 5 MiB cap) and stored at 7.5 MiB; a stored room whose cost
  passed a share was refused `4413` to every principal, for good, also after a restart (the
  verifier's PoCs `p1-split-4413`, `p1b-anon-split-4413`: a public canvas for every anonymous
  visitor). Now (protocol §10, §11): the guard counts every cut once per boundary — an origin or
  right origin inside an item, of new structs and of structs the room has (Yjs resolves those
  too), delete ranges, in the room's items and the update's own — at `SPLIT_COST_BYTES` 32 (worst
  measured 22 B, `server/test/fv8/split-growth.ts`; the guard fuzzer now checks every accepted
  update against it); an update may make `MAX_SPLITS_PER_MESSAGE` (5 000) cuts, over that `4413`
  for the sender only; and a stored room whose cost passes the joiner's share loads, charged one
  share, with a warning (only a room past 85% of the whole budget is refused `4413`).
- [x] **P2 — One update held the event loop for a minute (High, before fv7 too).** Yjs copies an
  item's content on every cut, and the CPU budget was charged only after a message: the update
  above held the server 53-65 s (x86). Fixing it found a second way with no cut at all: 2 000
  forged items whose right origin is far from their origin (14 KB) made Yjs scan a 50 000-item
  list for each, ~20 s (`server/test/fv8/scan-probe.ts`). Now the guard bounds both — the work of
  the cuts (`splitWork`) and of the placement scans (`scanWork`), turned into time with costs
  measured on x86 (`split-cpu-cal.ts`) — and refuses an update over `MAX_APPLY_MS` (50 ms) before
  resolving anything (the 3.97 MB update is refused in ~175 ms of guard, most of it decoding);
  and the apply is charged to the principal's and the server's CPU budgets **before** it runs, by
  its estimate: one they cannot cover is refused `1013` `busy`. Live, honest edits in another
  room keep p95 < 100 ms during either attack and nobody else is dropped.
- [x] **U1 — Screenshots filled a room fast (Medium).** Pasted and dropped images were stored as
  they came (PNG): 11 Full HD screenshots filled a 5 MiB room, 4 an anonymous visitor's. The
  editor now stores them at most 1600 px on their longest side, as WebP at quality 0.75 (JPEG for
  an opaque image where the browser cannot encode WebP), keeping the PNG or the original file
  only when it is smaller (an animated GIF that fits stays as it is); the server still accepts
  only `data:image/(png|jpeg|gif|webp)`. The wrapper tells the editor the visitor's room cap, and
  the editor says the canvas is full (a toast, no update sent) before the server would refuse
  the image and close the connection.
- [x] **U2 — A loader kept paying after leaving (Medium).** The principal whose join loaded a
  room stayed charged for it while anyone kept it loaded: an honest user who opened a 5 MiB room
  and left it to colleagues could not open a 1.7 MiB one (`1013` until the first room was
  evicted; an anonymous visitor the same with 1 MiB and 0.7 MiB). Now the load charge of a
  principal that leaves moves to the principals still connected, split evenly, within their
  shares; what a principal wrote stays charged to it (fv7 F1 stays closed: the fv7 DOS and COVIEW
  regressions pass unchanged).

Their regressions live in `server/test/fv8.test.ts` (every kind of cut counted and its bytes
bounded, the verifier's P1/P1b at the chart's sizing, the size cap below the cut cap, an
oversized stored room loading, the placement attack, the CPU pre-charge, the caps, the U2
handover and its bounds, the wrapper's cap), `client/tests/fv8.test.ts`,
`server/test/fuzz/guard-fuzz.ts` (the size oracle) and `e2e-system/adversarial-fv8.spec.ts` (P1+P2
live with a canvas restart, the placement attack live, an oversized stored room in the browser,
screenshots pasted through the real editor, U2 live); the probes are in `server/test/fv8/`.

Findings of the seventh independent verification (fv7) that are not fixed yet. None of them
crashes the server or loses data. Each entry below is meant to become one GitHub issue.

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

The fv7 findings F1, F2 and F6 are fixed:

- [x] **F1 — Room memory budget charging let one user hold the whole budget (High,
  availability).** Growth was charged to the writer as `extra / room.principals.size`, `held()`
  divided each room's cost by the principals in it, nothing re-charged the writer when the others
  detached, growth was allowed to 100% of the budget while loads stopped at 90%, and the
  per-principal share had a floor of `cost(1.25 × MAX_DOC_BYTES)` (600 MiB of the 920 MiB budget,
  more than the whole budget at 1 GiB). Live (2 GiB): user1 held 856 MiB against a 600 MiB share
  and an 828 MiB load cap; user2 got 13 × 1013 opening a new artifact. Now (protocol §10, §11):
  every loaded room's cost is charged to the principal whose join loaded it and what each update
  adds to the principal that wrote it, in full, never divided; the charges stay while the room is
  loaded, also after their principal left, and each save replaces the estimates by what the room
  measures (only for the principals that wrote since the previous save); loads stop at 85% of
  the budget and growth at 80%; a principal may be charged a third of the budget, an anonymous
  visitor a twelfth, all anonymous visitors together a third, with no floor; the size caps are
  lowered at start to what a share holds, with a warning (also when the budget is smaller than
  one full room); a stored room bigger than the joiner's share was refused `4413` (fv8 P1: it
  now loads, charged one share; and a loader's charge moves to who keeps the room open, U2). Verifying the
  bound also found that an update that only repeated deletions the room had (a full-state step 2
  does) grew the size estimate by its size with no save to correct it: such updates now count
  what they really deleted; and that the ledger an update adds was counted as 0.3-1.6 x its
  content (a move of 3 000 shapes by another user adds ~6.5 x in attribution and history; one big
  image in a new room was counted at 2.6 x, more than a share): it is now bounded per shape the
  update touches (`ledgerBound`).
- [x] **F2 — The cost factors underestimated some shapes (Medium).** `ROOM_COST_FACTOR` 24 → 44
  (worst measured 39.5×, alternating overwrites with a new pair of client ids every 250 writes,
  plus 10%) and `MESSAGE_COST_FACTOR` 24 → 60 (51-53× measured for one 7.98 MiB update of
  alternating overwrites); measured by `server/test/fv7/ratio.ts` and `server/test/fv7/guardcost.ts`.
  To keep the chart's 2 GiB sizing, the default caps are now 5 MiB per room (anonymous 1.25 MiB),
  4 MiB per message (1 MiB) and 512 KiB per anonymous image.
- [x] **F6 — A transient core authorization failure closed honest users with 4403 (Low).** A
  `core_error` or `malformed` answer (timeout, network error, 5xx) during the periodic re-check
  now closes `1013` with NOTICE `busy` (the client reconnects and is checked again) instead of
  `4403` `revoked`, and a join while the core cannot answer is refused `1013` too (still fail
  closed: nothing is let in unverified).

Their regressions live in `server/test/fv7.test.ts` (the attack with and without other principals
sitting in the rooms, charges kept after a detach, the thresholds, the share and the clamped caps,
the startup warnings, the close codes) and `e2e-system/adversarial-fv7.spec.ts` (DOS with anonymous
sitters and COVIEW with signed-in co-viewers, on the full system under the chart's memory limit).

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
