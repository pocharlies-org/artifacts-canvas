/**
 * Differential fuzzer of the content-document guard with a LEDGER oracle (adapted from the
 * third verifier's fuzz-guard.mjs to the two-document room, plus a mutation generator that
 * tampers with real client edits).
 *
 * The room is a content document + ledger document with the stamper attached, seeded by two
 * honest users. Every iteration crafts a random raw Yjs update from the attacker — random
 * clients (its own, an honest user's, the content doc's, the ledger stamper's), clocks
 * (next, gaps, overlaps, 2^40), structs (Item, GC, Skip, zero-length), contents (every Yjs
 * content type, empty ones included), origins and parents pointing at content AND ledger
 * ids (the attacker sees the ledger), parent roots including every ledger root name, and
 * random delete sets (zero-length ranges included) — and runs the server path of ws.ts:
 * guard, then applyGuarded on a copy of the room, with the attacker as transaction origin.
 *
 * Oracle, for every update the guard accepts:
 *   - the ledger holds only the stamper's own structs (no client struct ever enters it);
 *   - every pre-existing attribution entry keeps createdBy/createdAt, every other user's
 *     `users` entry is unchanged, the history keeps every earlier line, and every new line
 *     and attribution change is by the attacker (what the stamper derives from its edit);
 *   - the apply neither throws nor leaves pending state, the content still encodes, no root
 *     outside shapes/assets/meta changed, and no shape/asset/meta value became invalid.
 * Any violation is a finding (printed with the update hex). Exit code 1 if there is one.
 *
 *   npx tsx server/test/fuzz/guard-fuzz.ts [iterations=1000000] [seed=1]
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { applyGuarded, attachStamper, checkClientUpdate, shapeValueProblem } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent, materializeLedger } from '@pocharlies/artifacts-canvas-shared/ledger';
import { assetValueOk, metaValueOk } from '@pocharlies/artifacts-canvas-shared/model';

const CLIENT_ROOTS = ['shapes', 'assets', 'meta'];
const LEDGER_ROOTS = ['attribution', 'users', 'history', 'writers'];
const ATTACKER = { id: 'anon:mallory', info: { name: 'Anónimo 6666', anonymous: true } };
const HONEST: Record<string, { id: string; info: { name: string; anonymous: boolean } }> = {
  u1: { id: 'user:1', info: { name: 'One', anonymous: false } },
  u2: { id: 'user:2', info: { name: 'Two', anonymous: false } },
};

export interface FuzzResult {
  iterations: number;
  seed: number;
  accepted: number;
  /** mutations the Yjs encoder itself refused (no update to send) */
  unencodable: number;
  rejected: Record<string, number>;
  /** accepted updates after which the stamper wrote the ledger (all by the attacker) */
  ledgerStamped: number;
  /** accepted updates that changed nothing in the ledger */
  ledgerUntouched: number;
  findings: Record<string, number>;
  examples: Record<string, { i: number; problems: string[]; hex: string }>;
  ms: number;
}

interface Room {
  content: Y.Doc;
  ledger: Y.Doc;
}

export function seededRoom(clock: { t: number }): Room {
  const content = materializeContent(new Y.Doc());
  const ledger = materializeLedger(new Y.Doc());
  attachStamper(content, ledger, {
    userOf: (o) => (o === 'mallory' ? ATTACKER : HONEST[o as string] ?? null),
    historyLimit: 1_000_000,
    now: () => (clock.t += 20_000),
  });
  const users = [101, 102].map((cid) => {
    const d = new Y.Doc();
    d.clientID = cid;
    return d;
  });
  const sync = (d: Y.Doc, who: string) => {
    Y.applyUpdate(content, Y.encodeStateAsUpdate(d, Y.encodeStateVector(content)), who);
    Y.applyUpdate(d, Y.encodeStateAsUpdate(content, Y.encodeStateVector(d)));
  };
  for (let i = 0; i < 8; i++) {
    const d = users[i % 2];
    const who = i % 2 ? 'u2' : 'u1';
    const sh = d.getMap<Y.Map<unknown>>('shapes');
    d.transact(() => {
      const m = new Y.Map<unknown>();
      sh.set('s' + i, m);
      m.set('type', i % 3 === 0 ? 'text' : i % 3 === 1 ? 'draw' : 'geo');
      m.set('x', i);
      m.set('y', i);
      if (i % 3 === 0) {
        const tx = new Y.Text();
        m.set('text', tx);
        tx.insert(0, 'hello' + i);
      }
      if (i % 3 === 1) {
        const p = new Y.Array<number>();
        m.set('points', p);
        p.push([1, 2, 0.5, 3, 4, 0.5]);
      }
    });
    sync(d, who);
    d.transact(() => sh.get('s' + i)!.set('x', i + 100));
    sync(d, who);
    if (i % 4 === 3) {
      d.transact(() => sh.delete('s' + (i - 1)));
      sync(d, who);
    }
  }
  users[0].transact(() => {
    users[0].getMap('assets').set('a1', 'data:x');
    users[0].getMap('meta').set('pageWidth', 1200);
  });
  sync(users[0], 'u1');
  return { content, ledger };
}

/** Full copy of a room (content + ledger + stamper), to apply one candidate update to. */
export function copyRoom(src: Room, clock: { t: number }): Room {
  const content = materializeContent(new Y.Doc());
  const ledger = materializeLedger(new Y.Doc()); // a fresh stamper id, like a new server process
  Y.applyUpdate(content, Y.encodeStateAsUpdate(src.content), 'load');
  Y.applyUpdate(ledger, Y.encodeStateAsUpdate(src.ledger), 'load');
  attachStamper(content, ledger, {
    userOf: (o) => (o === 'mallory' ? ATTACKER : null),
    historyLimit: 1_000_000,
    now: () => (clock.t += 20_000),
  });
  return { content, ledger };
}

interface LedgerView {
  attribution: Record<string, { createdBy: string; createdAt: number; updatedBy: string; updatedAt: number }>;
  users: Record<string, unknown>;
  history: { by: string }[];
  writers: Record<string, unknown>;
  hex: string;
}
const viewOf = (l: Y.Doc): LedgerView => ({
  attribution: l.getMap('attribution').toJSON() as LedgerView['attribution'],
  users: l.getMap('users').toJSON(),
  history: l.getArray('history').toJSON() as { by: string }[],
  writers: l.getMap('writers').toJSON(),
  hex: Buffer.from(Y.encodeStateAsUpdate(l)).toString('hex'),
});

function ledgerProblems(before: LedgerView & { clients: Set<number> }, after: Room): string[] {
  const out: string[] = [];
  const l = after.ledger;
  // only server stamper ids: the ones the ledger had, and this server's own
  for (const c of l.store.clients.keys()) if (c !== l.clientID && !before.clients.has(c)) out.push(`ledger-foreign-struct:${c}`);
  const now = viewOf(l);
  for (const [id, a] of Object.entries(before.attribution)) {
    const b = now.attribution[id];
    if (!b) out.push(`ledger-attribution-erased:${id}`);
    else {
      if (b.createdBy !== a.createdBy || b.createdAt !== a.createdAt) out.push(`ledger-author-changed:${id}`);
      if ((b.updatedBy !== a.updatedBy || b.updatedAt !== a.updatedAt) && b.updatedBy !== ATTACKER.id) out.push(`ledger-update-misattributed:${id}`);
    }
  }
  for (const [id, b] of Object.entries(now.attribution)) {
    if (!before.attribution[id] && b.createdBy !== ATTACKER.id) out.push(`ledger-new-entry-misattributed:${id}`);
  }
  for (const [id, u] of Object.entries(before.users)) {
    if (JSON.stringify(now.users[id]) !== JSON.stringify(u)) out.push(`ledger-user-changed:${id}`);
  }
  for (const id of Object.keys(now.users)) if (!(id in before.users) && id !== ATTACKER.id) out.push(`ledger-user-added:${id}`);
  for (let i = 0; i < before.history.length; i++) {
    if (JSON.stringify(now.history[i]) !== JSON.stringify(before.history[i])) {
      out.push('ledger-history-rewritten');
      break;
    }
  }
  for (const e of now.history.slice(before.history.length)) {
    if (e.by !== ATTACKER.id) {
      out.push('ledger-history-misattributed');
      break;
    }
  }
  if (JSON.stringify(now.writers) !== JSON.stringify(before.writers)) out.push('ledger-writers-changed');
  return out;
}

function contentProblems(before: Room, after: Room): string[] {
  const out: string[] = [];
  const snap = (d: Y.Doc) => {
    const r: Record<string, string> = {};
    for (const [name, t] of d.share) if (!CLIENT_ROOTS.includes(name)) r[name] = JSON.stringify(t.toJSON());
    return r;
  };
  const sb = snap(before.content);
  const sa = snap(after.content);
  for (const k of Object.keys(sa)) {
    const empty = sa[k] === '{}' || sa[k] === '[]' || sa[k] === '""';
    if (sa[k] !== (sb[k] ?? (empty ? sa[k] : undefined))) out.push('content-root-changed:' + k);
  }
  const shapes = (d: Y.Doc) => d.getMap('shapes');
  for (const k of shapes(after.content).keys()) {
    if (shapeValueProblem(shapes(after.content), k) && !shapeValueProblem(shapes(before.content), k)) out.push('shape-invalid:' + k);
  }
  for (const [k, v] of after.content.getMap('assets').entries()) if (!assetValueOk(v)) out.push('asset-invalid:' + k);
  for (const [k, v] of after.content.getMap('meta').entries()) if (v instanceof Y.AbstractType || !metaValueOk(v)) out.push('meta-invalid:' + k);
  try {
    Y.encodeStateAsUpdate(after.content);
  } catch (e) {
    out.push('content-encode-throws:' + String(e).slice(0, 40));
  }
  return out;
}

export function runFuzz(iterations: number, seed0 = 1): FuzzResult {
  // mulberry32 (the verifier's float LCG lost precision above 2^53 and cycled after a few
  // hundred draws, so most "iterations" repeated the same updates)
  let seed = seed0 >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const clock = { t: 1e12 };
  const room = seededRoom(clock);
  const S = room.content.clientID;
  const L = room.ledger.clientID;
  const ledgerBefore = { ...viewOf(room.ledger), clients: new Set(room.ledger.store.clients.keys()) };

  // every (client, clock) the room has in BOTH documents, plus a few just past the ends
  const ids: Y.ID[] = [];
  for (const doc of [room.content, room.ledger]) {
    for (const [client, structs] of doc.store.clients) {
      for (const st of structs) {
        ids.push(Y.createID(client, st.id.clock));
        if (st.length > 1) ids.push(Y.createID(client, st.id.clock + st.length - 1), Y.createID(client, st.id.clock + 1));
      }
      const end = Y.getState(doc.store, client);
      ids.push(Y.createID(client, end), Y.createID(client, end + 1));
    }
  }
  const shapeIds = [...room.content.getMap('shapes').keys(), 's2', 's6', 'new1', '__proto__', 'constructor'];
  const fieldKeys = ['type', 'x', 'text', 'points', 'color', 'font', 'fill', 'start', 'k', '__proto__', 'prototype', null, ...shapeIds];

  const randContent = (): Y.Item['content'] => {
    const r = rnd();
    if (r < 0.22) return new Y.ContentAny([pick([1, 'geo', 'text', 'zzz', null, true, { x: 1, y: 2 }, [1, 2], 1e10, 'rectangle', 'red', 'mono', '__proto__'])]);
    if (r < 0.32) return new Y.ContentAny([pick([1, 2]), pick([3, 'a'])]);
    if (r < 0.44) return new Y.ContentString(pick(['a', 'bc', 'xyz', '']));
    if (r < 0.56) return new Y.ContentDeleted(Math.floor(rnd() * 3)); // 0 = zero-length
    if (r < 0.74) return new Y.ContentType(pick([() => new Y.Map(), () => new Y.Text(), () => new Y.Array(), () => new Y.XmlText(), () => new Y.XmlElement('p')])());
    if (r < 0.8) return new Y.ContentFormat(pick(['bold', 'x']), pick([true, null, 'v']));
    if (r < 0.85) return new Y.ContentEmbed({ a: 1 });
    if (r < 0.9) return new Y.ContentJSON([pick([1, 'a', null])]);
    if (r < 0.95) return new Y.ContentBinary(new Uint8Array([1, 2]));
    return new Y.ContentAny([]);
  };

  const genUpdate = (): Uint8Array => {
    const writers: { client: number; start: number; structs: (Y.Item | Y.GC | Y.Skip)[] }[] = [];
    const nw = 1 + Math.floor(rnd() * 2);
    for (let w = 0; w < nw; w++) {
      const client = pick([777, 777, 778, 101, 102, rnd() < 0.05 ? S : rnd() < 0.5 ? L : 779]);
      const known = Y.getState(room.content.store, client);
      const c = rnd() < 0.85 ? known : pick([known + 1, Math.max(0, known - 1), 0, 2 ** 40]);
      writers.push({ client, start: c, structs: [] });
    }
    const freshIds: Y.ID[] = [];
    for (const w of writers) {
      const n = 1 + Math.floor(rnd() * 4);
      let c = w.start;
      for (let i = 0; i < n; i++) {
        const id = Y.createID(w.client, c);
        let st: Y.Item | Y.GC | Y.Skip;
        const kind = rnd();
        if (kind < 0.07) st = new Y.GC(id, Math.floor(rnd() * 3));
        else if (kind < 0.1) st = new Y.Skip(id, Math.floor(rnd() * 3));
        else {
          const refPool = () => (rnd() < 0.6 || !freshIds.length ? pick(ids) : pick(freshIds));
          const origin = rnd() < 0.55 ? refPool() : null;
          const rightOrigin = rnd() < 0.3 ? refPool() : null;
          let parent: string | Y.ID | null = null;
          let parentSub: string | null = null;
          if (!origin && !rightOrigin) {
            parent = rnd() < 0.5 ? pick([...CLIENT_ROOTS, ...CLIENT_ROOTS, ...LEDGER_ROOTS, 'zzz']) : refPool();
            if (rnd() < 0.7) parentSub = pick(fieldKeys);
          }
          st = new Y.Item(id, null, origin, null, rightOrigin, parent as never, parentSub, randContent());
        }
        w.structs.push(st);
        for (let k = 0; k < st.length; k++) freshIds.push(Y.createID(w.client, c + k));
        c += st.length;
      }
    }
    const enc = new Y.UpdateEncoderV1();
    const dup = rnd() < 0.05 && writers[0].structs.length > 1;
    encoding.writeVarUint(enc.restEncoder, writers.length + (dup ? 1 : 0));
    const writeBlock = (client: number, structs: (Y.Item | Y.GC | Y.Skip)[]) => {
      encoding.writeVarUint(enc.restEncoder, structs.length);
      enc.writeClient(client);
      encoding.writeVarUint(enc.restEncoder, structs[0].id.clock);
      for (const st of structs) st.write(enc, 0);
    };
    if (dup) {
      const [a, ...b] = writers[0].structs;
      writeBlock(writers[0].client, [a]);
      writeBlock(writers[0].client, b);
      for (const w of writers.slice(1)) writeBlock(w.client, w.structs);
    } else for (const w of writers) writeBlock(w.client, w.structs);
    const dsClients = rnd() < 0.5 ? 0 : 1 + Math.floor(rnd() * 2);
    encoding.writeVarUint(enc.restEncoder, dsClients);
    for (let i = 0; i < dsClients; i++) {
      const target = rnd() < 0.5 && freshIds.length ? pick(freshIds) : pick(ids);
      enc.resetDsCurVal();
      encoding.writeVarUint(enc.restEncoder, target.client);
      const nr = 1 + Math.floor(rnd() * 2);
      encoding.writeVarUint(enc.restEncoder, nr);
      let c = target.clock;
      for (let r = 0; r < nr; r++) {
        enc.writeDsClock(c);
        const len = Math.floor(rnd() * 4); // 0 = zero-length range
        enc.writeDsLen(len);
        c += len + Math.floor(rnd() * 3);
      }
    }
    return enc.toUint8Array();
  };

  // Mutation generator: a REAL edit of a copy of the room (what an honest client sends),
  // then its structs are tampered with — origins/parents moved onto content or LEDGER ids,
  // keys swapped for ledger roots or forbidden names, contents replaced, lengths zeroed —
  // and the delete set extended. Far more of these pass the structural checks, so the
  // accepted path (and the oracle) gets exercised much more than by random bytes alone.
  const roomState = Y.encodeStateAsUpdate(room.content);
  const STYLE = ['color', 'fill', 'dash', 'size', 'font', 'arrowheads'];
  const genMutated = (): Uint8Array => {
    const d = new Y.Doc();
    Y.applyUpdate(d, roomState);
    d.clientID = pick([777, 778, 779, 101, 102, rnd() < 0.05 ? S : L]);
    const sv = Y.encodeStateVector(d);
    const shapes = d.getMap<Y.Map<unknown>>('shapes');
    const live = [...shapes.keys()];
    const ops = 1 + Math.floor(rnd() * 3);
    for (let o = 0; o < ops; o++) {
      const r = rnd();
      const id = live.length ? pick(live) : 's0';
      const m = shapes.get(id);
      if (r < 0.2 || !m) {
        const n = new Y.Map<unknown>();
        shapes.set(pick(['n1', 'n2', id, '__proto__']), n);
        n.set('type', pick(['geo', 'note', 'draw', 'text', 'arrow', 'zzz']));
        if (rnd() < 0.5) n.set(pick(STYLE), pick(['red', 'zzz', 'mono', 'pattern', 'xl', '__proto__']));
      } else if (r < 0.4) m.set(pick(['x', 'y', 'w', 'type', 'geo', ...STYLE, 'future', '__proto__']), pick([1, -5, 'red', 'rect', 'rectangle', 'zzz', null, { a: 1 }]));
      else if (r < 0.5) m.delete(pick(['x', 'type', 'text', 'points']));
      else if (r < 0.6) shapes.delete(id);
      else if (r < 0.75) {
        const t = m.get('text');
        if (t instanceof Y.Text) t.insert(Math.floor(rnd() * (t.length + 1)), pick(['a', 'xyz']));
        else m.set('text', new Y.Text('t'));
      } else if (r < 0.9) {
        const pts = m.get('points');
        if (pts instanceof Y.Array) pts.push([1, 2, 0.5]);
        else m.set('points', Y.Array.from([1, 2, 3]));
      } else d.getMap(pick(['assets', 'meta'])).set(pick(['a1', 'pageWidth', 'k', 'constructor']), pick(['data:x', 1200, { n: 1 }, null]));
    }
    const decoded = Y.decodeUpdate(Y.encodeStateAsUpdate(d, sv));
    const structs = decoded.structs as (Y.Item | Y.GC)[];
    for (const st of structs) {
      if (!(st instanceof Y.Item) || rnd() > 0.35) continue;
      const which = rnd();
      if (which < 0.25) st.origin = pick(ids);
      else if (which < 0.4) st.rightOrigin = pick(ids);
      else if (which < 0.55) {
        st.origin = null;
        st.rightOrigin = null;
        st.parent = pick([...LEDGER_ROOTS, 'shapes', 'zzz']) as never;
        st.parentSub = pick(fieldKeys);
      } else if (which < 0.7) st.parent = pick(ids) as never;
      else if (which < 0.85) st.content = randContent();
      else st.parentSub = pick(fieldKeys);
      st.length = st.content.getLength();
    }
    if (!structs.length) return Y.encodeStateAsUpdate(d, sv);
    // re-encode: one block per client, the clocks re-laid contiguously from each start
    const by = new Map<number, (Y.Item | Y.GC)[]>();
    for (const st of structs) {
      if (!by.has(st.id.client)) by.set(st.id.client, []);
      by.get(st.id.client)!.push(st);
    }
    const enc = new Y.UpdateEncoderV1();
    encoding.writeVarUint(enc.restEncoder, by.size);
    for (const [client, arr] of by) {
      encoding.writeVarUint(enc.restEncoder, arr.length);
      enc.writeClient(client);
      let c = arr[0].id.clock;
      encoding.writeVarUint(enc.restEncoder, c);
      for (const st of arr) {
        st.id = Y.createID(client, c);
        c += st.length;
        st.write(enc, 0);
      }
    }
    const extra = rnd() < 0.3 ? [pick(ids)] : [];
    const dsList: [number, number, number][] = [];
    for (const [client, ranges] of decoded.ds.clients) for (const r of ranges) dsList.push([client, r.clock, r.len]);
    for (const t of extra) dsList.push([t.client, t.clock, Math.floor(rnd() * 3)]);
    const dsBy = new Map<number, [number, number][]>();
    for (const [c, k, len] of dsList) {
      if (!dsBy.has(c)) dsBy.set(c, []);
      dsBy.get(c)!.push([k, len]);
    }
    encoding.writeVarUint(enc.restEncoder, dsBy.size);
    for (const [c, rs] of dsBy) {
      enc.resetDsCurVal();
      encoding.writeVarUint(enc.restEncoder, c);
      encoding.writeVarUint(enc.restEncoder, rs.length);
      for (const [k, len] of rs) {
        enc.writeDsClock(k);
        enc.writeDsLen(len);
      }
    }
    return enc.toUint8Array();
  };

  const res: FuzzResult = { iterations, seed: seed0, accepted: 0, unencodable: 0, rejected: {}, ledgerStamped: 0, ledgerUntouched: 0, findings: {}, examples: {}, ms: 0 };
  const t0 = Date.now();
  const trace = !!process.env.FUZZ_TRACE;
  for (let i = 0; i < iterations; i++) {
    let u: Uint8Array;
    try {
      u = rnd() < 0.5 ? genUpdate() : genMutated();
    } catch {
      res.unencodable++;
      continue; // an impossible mutation (the encoder refused it): not an update
    }
    if (trace) process.stderr.write(`#${i} ${Buffer.from(u).toString('hex')}\n`);
    let verdict: string | null;
    try {
      verdict = checkClientUpdate(room.content, u, { serverClient: S, mayWriteClient: (c) => c !== L }).bad;
    } catch {
      verdict = 'guard-throw';
    }
    if (verdict) {
      res.rejected[verdict] = (res.rejected[verdict] ?? 0) + 1;
      continue;
    }
    res.accepted++;
    const scratch = copyRoom(room, clock);
    const out = applyGuarded(scratch.content, u, 'mallory');
    const problems: string[] = [];
    if (out.threw) problems.push('apply-throws:' + out.threw.slice(0, 50));
    if (out.droppedPending) problems.push('pending-after-apply');
    problems.push(...ledgerProblems(ledgerBefore, scratch), ...contentProblems(room, scratch));
    if (viewOf(scratch.ledger).hex === ledgerBefore.hex) res.ledgerUntouched++;
    else res.ledgerStamped++;
    for (const p of new Set(problems.map((x) => x.split(':')[0]))) {
      res.findings[p] = (res.findings[p] ?? 0) + 1;
      if (!res.examples[p]) res.examples[p] = { i, problems, hex: Buffer.from(u).toString('hex') };
    }
    scratch.content.destroy();
    scratch.ledger.destroy();
  }
  res.ms = Date.now() - t0;
  return res;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const n = Number(process.argv[2] ?? 1_000_000);
  const seed = Number(process.argv[3] ?? 1);
  const chunk = 100_000;
  const total: FuzzResult = { iterations: 0, seed, accepted: 0, unencodable: 0, rejected: {}, ledgerStamped: 0, ledgerUntouched: 0, findings: {}, examples: {}, ms: 0 };
  // chunks with derived seeds keep memory flat and print progress
  for (let done = 0, k = 0; done < n; done += chunk, k++) {
    const r = runFuzz(Math.min(chunk, n - done), seed * 1000 + k);
    total.iterations += r.iterations;
    total.accepted += r.accepted;
    total.unencodable += r.unencodable;
    total.ledgerStamped += r.ledgerStamped;
    total.ledgerUntouched += r.ledgerUntouched;
    total.ms += r.ms;
    for (const [k2, v] of Object.entries(r.rejected)) total.rejected[k2] = (total.rejected[k2] ?? 0) + v;
    for (const [k2, v] of Object.entries(r.findings)) total.findings[k2] = (total.findings[k2] ?? 0) + v;
    for (const [k2, v] of Object.entries(r.examples)) total.examples[k2] ??= v;
    console.error(`[fuzz] ${total.iterations}/${n} accepted=${total.accepted} findings=${JSON.stringify(total.findings)} ${Math.round(total.ms / 1000)}s`);
  }
  console.log(JSON.stringify(total, null, 1));
  process.exit(Object.keys(total.findings).length ? 1 : 0);
}
