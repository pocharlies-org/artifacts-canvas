import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import { composeIdentity, sanitizeAwarenessUpdate } from '../src/identity.js';
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

  it('uses a valid ?anon= pseudonym for anonymous visitors', () => {
    expect(composeIdentity(anonymous, '4321')).toMatchObject({
      id: 'anon:4321',
      name: 'Anónimo 4321',
      anonymous: true,
      attribution: 'server',
    });
  });

  it('rejects malformed pseudonyms with a random one', () => {
    const id = composeIdentity(anonymous, '99999; DROP');
    expect(id.id).toMatch(/^anon:\d{4}$/);
    expect(composeIdentity(anonymous, null).id).toMatch(/^anon:\d{4}$/);
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
