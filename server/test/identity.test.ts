import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import { composeIdentity, sanitizeAwarenessUpdate } from '../src/identity.js';
import { AnonIssuer, assignNum } from '../src/anon.js';
import type { AuthzResult } from '../src/types.js';

const identified: AuthzResult = {
  allowed: true,
  reason: 'ok',
  identity: { id: 'ana@corp', name: 'Ana', anonymous: false, attribution: 'server' },
};
const anonymous: AuthzResult = { allowed: true, reason: 'ok' };

describe('composeIdentity', () => {
  it('uses the core identity for logged-in users and ignores ?anon=', () => {
    expect(composeIdentity(identified, '1234')).toMatchObject({ id: 'ana@corp', anonymous: false });
  });

  it('uses the server-assigned pseudonym for the label and the visitor id for attribution', () => {
    expect(composeIdentity(anonymous, '4321', 'Vv0123456789abcd')).toMatchObject({
      id: 'anon:Vv0123456789abcd',
      name: 'Anónimo 4321',
      anonymous: true,
      attribution: 'server',
    });
  });
});

describe('anonymous pseudonyms are server-assigned (anon.ts)', () => {
  it('signed cookie round-trips; tampering, other keys and malformed values are rejected', () => {
    const a = new AnonIssuer('secret-a');
    const v = a.visitor('', '4242');
    expect(v).toMatchObject({ num: '4242', fresh: true });
    const cookie = a.setCookie(v.nonce, v.num, true).split(';')[0];
    expect(a.setCookie(v.nonce, v.num, true)).toContain('; Secure');
    expect(a.parse(`other=1; ${cookie}`)).toEqual({ nonce: v.nonce, num: '4242' });
    expect(a.visitor(cookie, '1111')).toMatchObject({ nonce: v.nonce, num: '4242', fresh: false });
    expect(a.parse(cookie.replace('.4242.', '.4243.'))).toBeNull();
    expect(new AnonIssuer('secret-b').parse(cookie)).toBeNull();
    expect(a.parse('canvas_anon=garbage')).toBeNull();
    // invalid hints fall back to a random number
    for (const hint of ['99999; DROP', 'test@example.com', '0042', null]) {
      expect(a.visitor('', hint).num).toMatch(/^[1-9]\d{3}$/);
    }
  });

  it('assignNum keeps a free or own number and replaces one held by another visitor', () => {
    const held = new Map([['1234', 'visitor-a']]);
    expect(assignNum('1234', 'visitor-a', held)).toBe('1234');
    expect(assignNum('5555', 'visitor-b', held)).toBe('5555');
    const other = assignNum('1234', 'visitor-b', held);
    expect(other).toMatch(/^\d{4}$/);
    expect(other).not.toBe('1234');
  });
});

function encodeAwareness(clientId: number, state: unknown, clock = 1): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1);
  encoding.writeVarUint(e, clientId);
  encoding.writeVarUint(e, clock);
  encoding.writeVarString(e, JSON.stringify(state));
  return encoding.toUint8Array(e);
}

describe('sanitizeAwarenessUpdate', () => {
  const identity = { id: 'ana@corp', name: 'Ana', anonymous: false, attribution: 'server' as const };

  it('overwrites the user field with the verified identity', () => {
    const doc = new Y.Doc();
    const room = new awarenessProtocol.Awareness(doc);
    room.setLocalState(null);
    const out = sanitizeAwarenessUpdate(
      encodeAwareness(7, { cursor: { x: 1 }, user: { id: 'evil', name: 'Evil' } }, 1),
      new Set([7]),
      room,
      identity,
    );
    expect(out).not.toBeNull();
    awarenessProtocol.applyAwarenessUpdate(room, out!, null);
    expect(room.getStates().get(7)).toMatchObject({
      cursor: { x: 1 },
      user: { id: 'ana@corp', name: 'Ana', anonymous: false },
    });
  });

  it('drops states for clientIds owned by another connection', () => {
    const doc = new Y.Doc();
    const room = new awarenessProtocol.Awareness(doc);
    const other = new Y.Doc();
    void other;
    room.setLocalState(null);
    // room already knows clientId 5 (another conn)
    awarenessProtocol.applyAwarenessUpdate(room, encodeAwareness(5, { cursor: { x: 9 } }, 1), null);
    // a malicious conn claiming only clientId 7 tries to move clientId 5
    const out = sanitizeAwarenessUpdate(encodeAwareness(5, { cursor: { x: 0 } }, 2), new Set([7]), room, identity);
    expect(out).toBeNull();
    expect(room.getStates().get(5)).toMatchObject({ cursor: { x: 9 } });
  });

  it('keeps brand-new clientIds (first state of this connection)', () => {
    const doc = new Y.Doc();
    const room = new awarenessProtocol.Awareness(doc);
    room.setLocalState(null);
    const out = sanitizeAwarenessUpdate(encodeAwareness(11, { cursor: { x: 2 } }, 1), new Set(), room, identity);
    expect(out).not.toBeNull();
    awarenessProtocol.applyAwarenessUpdate(room, out!, null);
    expect(room.getStates().get(11)?.user).toMatchObject({ id: 'ana@corp' });
  });

  it('drops malformed updates', () => {
    const doc = new Y.Doc();
    const room = new awarenessProtocol.Awareness(doc);
    expect(sanitizeAwarenessUpdate(new Uint8Array([255, 0, 127]), new Set([1]), room, identity)).toBeNull();
  });
});
