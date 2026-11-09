import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { AuthzResult, Identity } from './types.js';

/**
 * Identity composition (protocol §4). The identity is ONLY ever derived from the authz
 * answer; the client's `?anon=NNNN` pseudonym is accepted (validated `^\d{4}$`) for
 * anonymous pub/ visitors and ignored for logged-in ones.
 */
export function composeIdentity(authz: AuthzResult, anonParam: string | null): Identity {
  const authIdentity = authz.identity;
  if (authIdentity && !authIdentity.anonymous) {
    return authIdentity; // logged-in: the core's verified id/name, anon param ignored
  }
  const p = anonParam && /^\d{4}$/.test(anonParam) ? anonParam : String(1000 + Math.floor(Math.random() * 9000));
  return { id: `anon:${p}`, name: `Anónimo ${p}`, anonymous: true, attribution: 'server' };
}

/** The `user` object the server forces into every awareness state (protocol §5.4). */
export function awarenessUser(id: Identity): Record<string, unknown> {
  const u: Record<string, unknown> = { id: id.id, name: id.name, anonymous: id.anonymous };
  if (id.color) u.color = id.color;
  return u;
}

interface UpdateEntry {
  clientId: number;
  clock: number;
  state: Record<string, unknown> | null;
}

/**
 * Sanitize an awareness update from a connection before it touches the room:
 *   1. drop states for awareness clientIds this connection has not claimed and that
 *      already belong to another connection (a client may only move its own state),
 *   2. overwrite the `user` field of every kept state with the connection's verified
 *      identity — live cursors and labels cannot lie (protocol §5.4).
 *
 * Wire format (y-protocols/awareness): varUint count, then per client
 * varUint clientId, varUint clock, varString JSON state ("null" = removal).
 * Returns null when nothing survives.
 */
export function sanitizeAwarenessUpdate(
  update: Uint8Array,
  claimedClientIds: ReadonlySet<number>,
  roomAwareness: awarenessProtocol.Awareness,
  identity: Identity,
): Uint8Array | null {
  const dec = decoding.createDecoder(update);
  let count: number;
  const entries: UpdateEntry[] = [];
  try {
    count = decoding.readVarUint(dec);
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      const json = decoding.readVarString(dec);
      let state: Record<string, unknown> | null;
      if (json === 'null') {
        state = null;
      } else {
        const parsed: unknown = JSON.parse(json);
        if (parsed === null) state = null;
        else if (typeof parsed === 'object') state = parsed as Record<string, unknown>;
        else continue; // malformed state: drop
      }
      entries.push({ clientId, clock, state });
    }
  } catch {
    return null; // malformed update: drop entirely
  }

  const roomStates = roomAwareness.getStates();
  const kept = entries.filter(
    (e) => claimedClientIds.has(e.clientId) || !roomStates.has(e.clientId),
  );
  if (kept.length === 0) return null;

  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, kept.length);
  const user = awarenessUser(identity);
  for (const e of kept) {
    encoding.writeVarUint(enc, e.clientId);
    encoding.writeVarUint(enc, e.clock);
    if (e.state === null) {
      encoding.writeVarString(enc, 'null');
    } else {
      // verified identity wins; everything else in the state (cursor, viewport, laser) is the client's
      encoding.writeVarString(enc, JSON.stringify({ ...e.state, user }));
    }
  }
  return encoding.toUint8Array(enc);
}
