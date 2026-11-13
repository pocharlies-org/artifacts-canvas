/**
 * fv8 helpers: raw updates that cut room items, built directly with lib0 (building them through
 * a Y.Doc makes the client cut its own copy too: as slow as the server, minutes for 200 000).
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';

/** The live item that holds element `index` of a Y.Array (or Y.Text) in `doc`. */
export function itemAt(type: Y.AbstractType<unknown>, index: number): Y.Item {
  let n = type._start;
  let i = index;
  while (n) {
    if (!n.deleted && n.countable) {
      if (i < n.length) return n;
      i -= n.length;
    }
    n = n.right;
  }
  throw new Error('index out of range');
}

/**
 * One update of new single-number items of client `client` (clocks from `clock`): for every
 * target, `count` items, the i-th inserted between clocks `at + i` and `at + i + 1` of the item
 * `into` (origin and right origin inside it): each one cuts `into`, like an insert between every
 * two points of a stroke.
 */
export function insertsBetween(targets: { into: Y.Item; count: number; at?: number }[], client: number, clock: number, content: 'any' | 'string' = 'any'): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, targets.reduce((a, t) => a + t.count, 0));
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, clock);
  for (const { into, count, at = 0 } of targets) {
    if (at + count >= into.length) throw new Error('item too short');
    const { client: c, clock: k } = into.id;
    for (let i = 0; i < count; i++) {
      encoding.writeUint8(e, (content === 'any' ? 8 : 4) | 0x80 | 0x40); // ContentAny / ContentString, origin, right origin
      encoding.writeVarUint(e, c);
      encoding.writeVarUint(e, k + at + i);
      encoding.writeVarUint(e, c);
      encoding.writeVarUint(e, k + at + i + 1);
      if (content === 'any') {
        encoding.writeVarUint(e, 1);
        encoding.writeAny(e, 7);
      } else encoding.writeVarString(e, 'x');
    }
  }
  encoding.writeVarUint(e, 0);
  return encoding.toUint8Array(e);
}

/**
 * One update of `count` structs the room HAS (client `client`, clocks `clock`.., one element each),
 * re-sent with origins inside the item `into`: Yjs cuts `into` to resolve them, then skips them.
 */
export function knownCuts(into: Y.Item, client: number, clock: number, count: number): Uint8Array {
  if (count >= into.length) throw new Error('item too short');
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, count);
  encoding.writeVarUint(e, client);
  encoding.writeVarUint(e, clock);
  for (let i = 0; i < count; i++) {
    encoding.writeUint8(e, 8 | 0x80);
    encoding.writeVarUint(e, into.id.client);
    encoding.writeVarUint(e, into.id.clock + i);
    encoding.writeVarUint(e, 1);
    encoding.writeAny(e, 9);
  }
  encoding.writeVarUint(e, 0);
  return encoding.toUint8Array(e);
}

/** A sync update message (y-protocols: messageYjsUpdate) carrying `update`. */
export function syncUpdate(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, 2);
  encoding.writeVarUint8Array(e, update);
  return encoding.toUint8Array(e);
}
