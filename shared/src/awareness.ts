import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { Identity } from './model.js';

/** The `user` object the server forces into every awareness state (protocol §5.4). */
export function awarenessUser(id: Identity): Record<string, unknown> {
  const u: Record<string, unknown> = { id: id.id, name: id.name, anonymous: id.anonymous };
  if (id.color) u.color = id.color;
  return u;
}

/** Most laser points a state may carry (the client publishes the last 60). */
export const MAX_LASER_POINTS = 60;
/** Longest awareness state accepted, as JSON (anything bigger is dropped unread). */
export const MAX_AWARENESS_STATE_BYTES = 16 * 1024;
const MAX_ID = 512;
const MAX_NAME = 256;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/**
 * The presence schema (protocol §5.4): a copy of `state` with only the fields the client
 * uses, each with the right type and bounds; a field that does not fit is dropped (null for
 * the nullable ones). The server applies it to every awareness state before relaying it
 * (fv4 M3: `{laser:{pts:null}, status:5}` broke every other viewer, a 60 000-point laser
 * froze them); the client applies it again to whatever it receives. `user` is kept only when
 * it is well formed (the server overwrites it with the verified identity anyway).
 */
export function cleanPresenceState(state: unknown): Record<string, unknown> | null {
  if (!isObj(state)) return null;
  const out: Record<string, unknown> = {};
  const u = state.user;
  if (isObj(u) && str(u.id, MAX_ID) && str(u.name, MAX_NAME) && typeof u.anonymous === 'boolean') {
    const user: Record<string, unknown> = { id: u.id, name: u.name, anonymous: u.anonymous };
    if (typeof u.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(u.color)) user.color = u.color;
    out.user = user;
  }
  if ('cursor' in state) {
    const c = state.cursor;
    out.cursor = isObj(c) && num(c.x) && num(c.y) ? { x: c.x, y: c.y } : null;
  }
  if ('status' in state) {
    const st = state.status;
    out.status = typeof st === 'string' && /^cursor\.[A-Za-z]{1,32}$/.test(st) ? st : null;
  }
  if ('laser' in state) {
    const l = state.laser;
    out.laser =
      isObj(l) && num(l.now) && Array.isArray(l.pts) && l.pts.length <= MAX_LASER_POINTS &&
      l.pts.every((p) => Array.isArray(p) && p.length === 3 && num(p[0]) && num(p[1]) && num(p[2]))
        ? { pts: (l.pts as number[][]).map((p) => [p[0], p[1], p[2]]), now: l.now }
        : null;
  }
  if ('viewport' in state) {
    const v = state.viewport;
    out.viewport = isObj(v) && num(v.x) && num(v.y) && num(v.w) && num(v.h) ? { x: v.x, y: v.y, w: v.w, h: v.h } : null;
  }
  if ('presenting' in state) out.presenting = state.presenting === true;
  if ('following' in state) out.following = str(state.following, MAX_ID) ? state.following : null;
  return out;
}

interface UpdateEntry {
  clientId: number;
  clock: number;
  state: Record<string, unknown> | null;
}

/**
 * Sanitize an awareness update from a connection before it touches the room
 * (protocol §5.4 — the same hardening the production server and the development room
 * apply, so neither can be spoofed by another connection):
 *   1. drop states for awareness clientIds this connection has not claimed and that
 *      already belong to another connection (a client may only move its own state),
 *   2. drop states for clientIds `mayClaim` refuses (the server: a Yjs client id the ledger
 *      binds to another principal — awareness alone never takes over an id with clocks),
 *   3. keep only the presence schema of every state (cleanPresenceState: typed, bounded
 *      fields; oversized states are dropped) and overwrite its `user` field with the
 *      connection's verified identity — live cursors and labels cannot lie.
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
  mayClaim?: (clientId: number) => boolean,
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
        if (json.length > MAX_AWARENESS_STATE_BYTES) continue; // oversized state: drop unread
        const parsed: unknown = JSON.parse(json);
        if (parsed === null) state = null;
        else {
          // schema-checked copy: only the presence fields, typed and bounded
          const clean = cleanPresenceState(parsed);
          if (!clean) continue; // not an object: drop
          state = clean;
        }
      }
      entries.push({ clientId, clock, state });
    }
  } catch {
    return null; // malformed update: drop entirely
  }

  const roomStates = roomAwareness.getStates();
  const kept = entries.filter(
    (e) => (claimedClientIds.has(e.clientId) || !roomStates.has(e.clientId)) && (!mayClaim || mayClaim(e.clientId)),
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
