# Known issues

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
  one full room); a stored room bigger than the joiner's share is refused `4413`. Verifying the
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
