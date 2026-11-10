import * as Y from 'yjs';
import { CONTENT_ROOTS, LEDGER_ROOTS, ROOT } from './model.js';
import type { Attribution, HistoryEntry, UserInfo } from './model.js';
import { STAMP_ORIGIN } from './stamper.js';

/**
 * The two documents of a room (docs/protocol.md §5-§6):
 *   content  shapes, assets, meta — the only document clients write (guarded);
 *   ledger   attribution, users, history, writers — written by the server's stamper only.
 * Materialising the roots before any update is applied matters: yjs 13.6 registers a root
 * first referenced by an incoming update as a placeholder AbstractType, and a later
 * `getMap(name)` returns a different object than the one in `transaction.changed`.
 */
export function materializeContent(doc: Y.Doc): Y.Doc {
  doc.getMap(ROOT.shapes);
  doc.getMap(ROOT.assets);
  doc.getMap(ROOT.meta);
  return doc;
}

export function materializeLedger(doc: Y.Doc): Y.Doc {
  doc.getMap(ROOT.attribution);
  doc.getMap(ROOT.users);
  doc.getArray(ROOT.history);
  doc.getMap(ROOT.writers);
  return doc;
}

/** Root names of `doc` that are neither content nor ledger roots. */
export function strayRoots(doc: Y.Doc): string[] {
  return [...doc.share.keys()].filter((n) => !CONTENT_ROOTS.includes(n));
}

/**
 * Migration of a document stored before the split (one Y.Doc held content AND ledger):
 * copy the live entries of `attribution`, `users` and `history` into `ledger` (entries the
 * ledger already has win: it is authoritative once it exists), then delete them from
 * `content`, so the content document a client receives carries no ledger data. Deleting
 * (not rebuilding) keeps every content struct id stable for tabs that were open across the
 * upgrade. Returns true when anything changed (the caller saves both documents).
 */
export function migrateLegacyRoots(content: Y.Doc, ledger: Y.Doc, origin: unknown = 'migrate'): boolean {
  const present = (name: string) => content.share.has(name);
  if (!LEDGER_ROOTS.some(present)) return false;
  const la = ledger.getMap<Attribution>(ROOT.attribution);
  const lu = ledger.getMap<UserInfo>(ROOT.users);
  const lh = ledger.getArray<HistoryEntry>(ROOT.history);
  const lw = ledger.getMap<string>(ROOT.writers);
  const ca = present(ROOT.attribution) ? content.getMap<unknown>(ROOT.attribution) : null;
  const cu = present(ROOT.users) ? content.getMap<unknown>(ROOT.users) : null;
  const ch = present(ROOT.history) ? content.getArray<unknown>(ROOT.history) : null;
  const cw = present(ROOT.writers) ? content.getMap<unknown>(ROOT.writers) : null;
  const live = (ca?.size ?? 0) + (cu?.size ?? 0) + (ch?.length ?? 0) + (cw?.size ?? 0);
  if (live === 0) return false;
  ledger.transact(() => {
    const plain = (v: unknown) => (v && typeof v === 'object' && !(v instanceof Y.AbstractType) ? JSON.parse(JSON.stringify(v)) : null);
    if (ca) for (const [k, v] of ca.entries()) if (!la.has(k) && plain(v)) la.set(k, plain(v) as Attribution);
    if (cu) for (const [k, v] of cu.entries()) if (!lu.has(k) && plain(v)) lu.set(k, plain(v) as UserInfo);
    if (ch && lh.length === 0) lh.push(ch.toArray().map(plain).filter(Boolean) as HistoryEntry[]);
    if (cw) for (const [k, v] of cw.entries()) if (!lw.has(k) && typeof v === 'string') lw.set(k, v);
  }, STAMP_ORIGIN);
  content.transact(() => {
    for (const m of [ca, cu, cw]) if (m) for (const k of [...m.keys()]) m.delete(k);
    if (ch && ch.length) ch.delete(0, ch.length);
  }, origin);
  return true;
}

/** Principal bound to Yjs client id `client` in the ledger (undefined = none yet). */
export function writerOf(ledger: Y.Doc, client: number): string | undefined {
  const v = ledger.getMap<string>(ROOT.writers).get(String(client));
  return typeof v === 'string' ? v : undefined;
}

/** Bind client ids to `principal` in the ledger (first binding wins; persisted with it). */
export function bindWriters(ledger: Y.Doc, clients: number[], principal: string): void {
  const w = ledger.getMap<string>(ROOT.writers);
  const fresh = clients.filter((c) => !w.has(String(c)));
  if (!fresh.length) return;
  ledger.transact(() => {
    for (const c of fresh) w.set(String(c), principal);
  }, STAMP_ORIGIN);
}
