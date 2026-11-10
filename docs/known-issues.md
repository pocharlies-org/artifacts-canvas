# Known issues

Findings of the fourth independent verification (fv4) that are not fixed yet. The High ones
(H1 sync step-1 amplification, H2 O(room) guard slow path, H3 cubic text wrap) and M2, M3, M4,
L6 (core) and L7 are fixed; their regressions live in `server/test/fv4.test.ts`,
`client/tests/fv4.test.ts` and `e2e-system/adversarial-fv4.spec.ts`. Each entry below is
meant to become one GitHub issue.

- [ ] **M1 — Crash relay re-attributes unsaved edits (Medium).** After a crash with nothing
  flushed, the first tab to reconnect delivers other people's unsaved structs in its own
  step 2: the ledger credits it with `createdBy` of the victim's shape, `writers[victim id]` is
  bound to it, and the victim's next edit is closed `4403` (no auto-reconnect). Bounded by
  `SAVE_DEBOUNCE_MS` (2 s by default) and by needing a crash; with H1 fixed an attacker can no
  longer cause the crash at will (protocol §11). PoC: `poc7-crash-relay.ts`.
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
