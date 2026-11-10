import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Identity } from './model.js';

/**
 * Wire protocol additions on top of the y-websocket protocol (see docs/protocol.md).
 *   0 sync, 1 awareness, 2 auth, 3 query-awareness   (standard y-websocket / y-protocols)
 *   100 IDENTITY   server -> client, JSON Identity. MUST be the first message on the socket.
 *   101 NOTICE     server -> client, JSON {kind, message?}
 */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_AUTH = 2;
export const MSG_QUERY_AWARENESS = 3;
export const MSG_IDENTITY = 100;
export const MSG_NOTICE = 101;

export type NoticeKind = 'revoked' | 'expired' | 'readonly' | 'rate-limited' | 'too-large' | 'shutdown';

export interface Notice {
  kind: NoticeKind;
  message?: string;
}

/** Close codes (RFC 6455 private range; 44xx = do not reconnect, as y-websocket does). */
export const CLOSE = {
  unauthenticated: 4401,
  forbidden: 4403,
  notFound: 4404,
  expired: 4410,
  tooLarge: 4413,
  rateLimited: 4429,
  serverRestart: 4503,
} as const;

export function encodeIdentity(id: Identity): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_IDENTITY);
  encoding.writeVarString(e, JSON.stringify(id));
  return encoding.toUint8Array(e);
}

export function encodeNotice(n: Notice): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_NOTICE);
  encoding.writeVarString(e, JSON.stringify(n));
  return encoding.toUint8Array(e);
}

/** Parse and validate an IDENTITY payload. Returns null when malformed. */
export function parseIdentity(json: string): Identity | null {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 256) return null;
  if (typeof r.name !== 'string' || !r.name || r.name.length > 128) return null;
  if (typeof r.anonymous !== 'boolean') return null;
  const color = typeof r.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : undefined;
  const attribution = r.attribution === 'client' ? 'client' : 'server';
  return { id: r.id, name: r.name, anonymous: r.anonymous, color, attribution, readOnly: r.readOnly === true };
}

export function readJsonString(decoder: decoding.Decoder): string {
  return decoding.readVarString(decoder);
}
