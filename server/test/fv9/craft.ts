/**
 * Builders of the ninth verification's (fv9) crafted updates, from its PoCs (server/test/fv9/*.ts
 * probes): each takes the room's current list or text (as a Y.Doc that holds the same items) and
 * writes the raw update. Used by the regression suite (server/test/fv9.test.ts) and the full-system
 * spec (e2e-system/adversarial-fv9.spec.ts).
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';

type Id = { client: number; clock: number };

/** The last clock of a list or text (the item an append continues). */
export function lastId(t: Y.AbstractType<unknown>): Id {
  let it = t._start!;
  while (it.right) it = it.right;
  return { client: it.id.client, clock: it.id.clock + it.length - 1 };
}

/**
 * fv9 A: ONE update of `k` single-number items appended to `points`, each continuing the previous
 * one (an honest encoder sends them as one struct): Yjs merges them right to left, copying the
 * growing array every time (K^2/2 elements: 20 000 of them ran the server out of heap).
 */
export function mergeRun(points: Y.Array<number>, client: number, k: number): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, k);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, 0);
  let origin = lastId(points);
  for (let i = 0; i < k; i++) {
    encoding.writeUint8(e, 8 | 0x80); // ContentAny, origin, no right origin (end of the list)
    encoding.writeVarUint(e, origin.client);
    encoding.writeVarUint(e, origin.clock);
    encoding.writeVarUint(e, 1);
    encoding.writeAny(e, i % 50);
    origin = { client, clock: i };
  }
  encoding.writeVarUint(e, 0);
  return encoding.toUint8Array(e);
}

/**
 * fv9 B: ONE update of `pairs` pairs of single-number items alternating between two lists: each
 * pair merges, never with its neighbours in the client's struct array, so every merge splices it
 * (100 000 pairs: 5.4 s).
 */
export function mergePairs(a: Y.Array<number>, b: Y.Array<number>, client: number, pairs: number): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, 2 * pairs);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, 0);
  const tail = [lastId(a), lastId(b)];
  let clock = 0;
  for (let k = 0; k < pairs; k++) {
    const s = k % 2;
    for (let j = 0; j < 2; j++) {
      encoding.writeUint8(e, 8 | 0x80);
      encoding.writeVarUint(e, tail[s].client);
      encoding.writeVarUint(e, tail[s].clock);
      encoding.writeVarUint(e, 1);
      encoding.writeAny(e, (k + j) % 50);
      tail[s] = { client, clock: clock++ };
    }
  }
  encoding.writeVarUint(e, 0);
  return encoding.toUint8Array(e);
}

/**
 * fv9 C, build: `n` items appended to `points` from clock `from`, every odd one deleted in the same
 * update (live and deleted alternate: they never merge). Returns the update and the next origin.
 */
export function alternating(origin: Id, client: number, from: number, n: number): { update: Uint8Array; origin: Id } {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, n);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, from);
  let clock = from;
  for (let i = 0; i < n; i++) {
    encoding.writeUint8(e, 8 | 0x80);
    encoding.writeVarUint(e, origin.client);
    encoding.writeVarUint(e, origin.clock);
    encoding.writeVarUint(e, 1);
    encoding.writeAny(e, i % 50);
    origin = { client, clock: clock++ };
  }
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, Math.floor(n / 2));
  for (let i = 1; i < n; i += 2) {
    encoding.writeVarUint(e, from + i);
    encoding.writeVarUint(e, 1);
  }
  return { update: encoding.toUint8Array(e), origin };
}

/**
 * fv9 C, attack: a delete-only update of `k` ranges, each one live item between two deleted ones
 * (every other live item around the middle of `total` alternating clocks): each range makes Yjs
 * merge three structs and splice the client's struct array (8.6 s for 80 000).
 */
export function deleteRanges(client: number, total: number, k: number): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, k);
  for (let i = 0; i < k; i++) {
    encoding.writeVarUint(e, 4 * (Math.floor(total / 8) - Math.floor(k / 2) + i) + 2);
    encoding.writeVarUint(e, 1);
  }
  return encoding.toUint8Array(e);
}

/**
 * fv9 D: ONE update into a note's text of `f` formatting items (ContentFormat, distinct keys)
 * then `s` one-character items: Yjs' formatting cleanup copies the attribute map per character
 * (60 000 + 9 000 in 0.72 MB, under the anonymous message cap: 60 s).
 */
export function formatting(text: Y.Text, client: number, f: number, s: number): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, f + s);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, 0);
  let origin = lastId(text);
  let clock = 0;
  for (let i = 0; i < f; i++) {
    encoding.writeUint8(e, 6 | 0x80); // ContentFormat with origin
    encoding.writeVarUint(e, origin.client);
    encoding.writeVarUint(e, origin.clock);
    encoding.writeVarString(e, i.toString(36));
    encoding.writeVarString(e, '1');
    origin = { client, clock: clock++ };
  }
  for (let i = 0; i < s; i++) {
    encoding.writeUint8(e, 4 | 0x80); // ContentString with origin
    encoding.writeVarUint(e, origin.client);
    encoding.writeVarUint(e, origin.clock);
    encoding.writeVarString(e, 'x');
    origin = { client, clock: clock++ };
  }
  encoding.writeVarUint(e, 0);
  return encoding.toUint8Array(e);
}

/**
 * fv9 E: ONE update of `n` single-number items over `c` client blocks (ids from `firstClient`),
 * chained backwards: each item's origin is the previous item of the chain, held by the block
 * BEFORE it, so a check that advances one struct per pass over every block takes n x c steps
 * (20 000 x 20 000: 27 s of the guard alone).
 */
export function chain(points: Y.Array<number>, firstClient: number, n: number, c: number): Uint8Array {
  const last = lastId(points);
  const blockOf = (j: number) => c - 1 - (j % c);
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, c);
  for (let b = 0; b < c; b++) {
    const js: number[] = [];
    for (let j = c - 1 - b; j < n; j += c) js.push(j);
    encoding.writeVarUint(e, js.length);
    encoding.writeVarUint(e, firstClient + b);
    encoding.writeVarUint(e, 0);
    for (const j of js) {
      const origin = j === 0 ? last : { client: firstClient + blockOf(j - 1), clock: Math.floor((j - 1) / c) };
      encoding.writeUint8(e, 8 | 0x80);
      encoding.writeVarUint(e, origin.client);
      encoding.writeVarUint(e, origin.clock);
      encoding.writeVarUint(e, 1);
      encoding.writeAny(e, j % 50);
    }
  }
  encoding.writeVarUint(e, 0);
  return encoding.toUint8Array(e);
}

/** A sync update message (MSG_SYNC, update) carrying `u`. */
export function syncMsg(u: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 2);
  encoding.writeVarUint8Array(e, u);
  return encoding.toUint8Array(e);
}
