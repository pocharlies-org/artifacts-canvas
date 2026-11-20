/**
 * Who else is here (collab/presence.ts audienceOf): people, not sessions, never this user.
 * Viewing = any session with the artifact open; annotating = at least one session with the canvas
 * shown (a viewport, and not VIEWING_STATUS). Through peers() too, so the states pass the same
 * schema check the server applies (shared cleanPresenceState).
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { VIEWING_STATUS, audienceOf, hiddenPresence, peers, sessionAnnotates, setPresence, type Peer, type PresenceState } from '../src/collab/presence';
import { cleanPresenceState } from '@pocharlies/artifacts-canvas-shared/awareness';

const user = (id: string, name = id) => ({ id, name, color: '#123456', anonymous: id.startsWith('anon:') });
const VP = { x: 0, y: 0, w: 100, h: 100 };
const shown = (id: string, extra: Partial<PresenceState> = {}): PresenceState => ({ user: user(id), viewport: VP, cursor: null, status: null, ...extra });
const hidden = (id: string): PresenceState => ({ user: user(id), status: VIEWING_STATUS });
let next = 10;
const peer = (state: PresenceState): Peer => ({ clientId: next++, state });

describe('audienceOf', () => {
  it('counts people, not tabs: three tabs of one person are one viewer', () => {
    const a = audienceOf([peer(hidden('bea')), peer(hidden('bea')), peer(hidden('bea'))], 'ana');
    expect(a).toMatchObject({ viewing: 1, annotating: 0 });
    expect(a.members.map((m) => m.user.id)).toEqual(['bea']);
  });

  it('a person annotates when any of their sessions has the canvas shown, whatever the order', () => {
    expect(audienceOf([peer(hidden('bea')), peer(shown('bea'))], 'ana')).toMatchObject({ viewing: 1, annotating: 1 });
    expect(audienceOf([peer(shown('bea')), peer(hidden('bea'))], 'ana')).toMatchObject({ viewing: 1, annotating: 1 });
  });

  it('this user is never counted, in any of their sessions; everyone else is', () => {
    const list = [peer(shown('ana')), peer(hidden('ana')), peer(shown('bea')), peer(hidden('carl')), peer(hidden('dora'))];
    const a = audienceOf(list, 'ana');
    expect(a).toMatchObject({ viewing: 3, annotating: 1 });
    expect(a.members.map((m) => [m.user.id, m.annotating])).toEqual([['bea', true], ['carl', false], ['dora', false]]);
    // seen from Bea: Ana's two sessions are one annotating person
    expect(audienceOf(list, 'bea')).toMatchObject({ viewing: 3, annotating: 1 });
  });

  it('before the identity is known nobody is left out but this session (peers() already drops it)', () => {
    expect(audienceOf([peer(shown('ana')), peer(hidden('bea'))], null)).toMatchObject({ viewing: 2, annotating: 1 });
  });

  it('alone: nobody viewing, nobody annotating', () => {
    expect(audienceOf([], 'ana')).toEqual({ viewing: 0, annotating: 0, members: [] });
    expect(audienceOf([peer(hidden('ana'))], 'ana')).toEqual({ viewing: 0, annotating: 0, members: [] });
  });

  it('a session annotates with a viewport and without the viewing status; a hidden tab of an older bundle (no status, no viewport) only views', () => {
    expect(sessionAnnotates(shown('x'))).toBe(true);
    expect(sessionAnnotates(hidden('x'))).toBe(false);
    expect(sessionAnnotates({ user: user('x'), viewport: null, status: null })).toBe(false);
    expect(sessionAnnotates({ user: user('x'), viewport: VP, status: VIEWING_STATUS })).toBe(false);
    // a state with no user (not identified yet) counts for nobody
    expect(audienceOf([{ clientId: 1, state: { viewport: VP } }], 'ana')).toMatchObject({ viewing: 0 });
  });

  it('two anonymous visitors are two people; the same visitor in two tabs is one', () => {
    expect(audienceOf([peer(hidden('anon:aaa')), peer(hidden('anon:bbb')), peer(hidden('anon:aaa'))], 'ana')).toMatchObject({ viewing: 2, annotating: 0 });
  });
});

describe('through awareness and the presence schema', () => {
  it('a hidden tab\'s state (user + viewing status) passes the schema and counts as viewing', () => {
    expect(cleanPresenceState(hidden('bea'))).toMatchObject({ status: VIEWING_STATUS });
    const room = new awarenessProtocol.Awareness(new Y.Doc());
    const tabs = [hidden('bea'), shown('carl'), hidden('carl'), hidden('ana')].map((st) => {
      const aw = new awarenessProtocol.Awareness(new Y.Doc());
      aw.setLocalState(st);
      awarenessProtocol.applyAwarenessUpdate(room, awarenessProtocol.encodeAwarenessUpdate(aw, [aw.clientID]), 'test');
      return aw;
    });
    room.setLocalState(shown('ana'));
    const a = audienceOf(peers(room), 'ana');
    expect(a).toMatchObject({ viewing: 2, annotating: 1 });
    expect(a.members.map((m) => [m.user.id, m.annotating])).toEqual([['carl', true], ['bea', false]]);
    for (const aw of [...tabs, room]) aw.destroy();
  });
});

describe('hiddenPresence: what a tab with the canvas hidden publishes (Editor.publishPresence while hidden)', () => {
  /** A shown tab's patch with every field set: presenting with the laser, following someone, a cursor and a viewport. */
  const everything = (): PresenceState => ({
    user: user('bea'), cursor: { x: 10, y: 20 }, status: 'cursor.laser', laser: { pts: [[10, 20, 1000]], now: 1000 },
    viewport: VP, presenting: true, following: 'ana',
  });
  const VIEWING = { user: user('bea'), cursor: null, viewport: null, laser: null, following: null, presenting: false, status: VIEWING_STATUS };

  it('a patch with every field set goes out as the viewing state: cursor, viewport, laser and following null, presenting false', () => {
    const patch = everything();
    const out = hiddenPresence(patch);
    expect(out.cursor).toBeNull();
    expect(out.viewport).toBeNull();
    expect(out.laser).toBeNull();
    expect(out.following).toBeNull();
    expect(out.presenting).toBe(false);
    expect(out.status).toBe(VIEWING_STATUS);
    expect(out).toEqual(VIEWING);
    // the caller's patch is left as it was
    expect(patch).toEqual(everything());
  });

  it('every single field, alone, is forced too; the status and following always are, and nothing else is added', () => {
    expect(hiddenPresence({})).toEqual({ status: VIEWING_STATUS, following: null });
    expect(hiddenPresence({ cursor: { x: 1, y: 2 } })).toEqual({ cursor: null, status: VIEWING_STATUS, following: null });
    expect(hiddenPresence({ viewport: VP })).toEqual({ viewport: null, status: VIEWING_STATUS, following: null });
    expect(hiddenPresence({ laser: { pts: [[1, 2, 3]], now: 3 } })).toEqual({ laser: null, status: VIEWING_STATUS, following: null });
    expect(hiddenPresence({ presenting: true })).toEqual({ presenting: false, status: VIEWING_STATUS, following: null });
    expect(hiddenPresence({ following: 'ana' })).toEqual({ status: VIEWING_STATUS, following: null });
    expect(hiddenPresence({ status: 'cursor.typingNote' })).toEqual({ status: VIEWING_STATUS, following: null });
  });

  it('a shown tab that hides: its awareness state becomes the viewing state, passes the schema and only views', () => {
    const aw = new awarenessProtocol.Awareness(new Y.Doc());
    setPresence(aw, everything());
    // the editor's hide, then whatever it is asked to publish while hidden
    setPresence(aw, hiddenPresence({ cursor: null, viewport: null, laser: null, presenting: false }));
    expect(aw.getLocalState()).toEqual(VIEWING);
    expect(setPresence(aw, hiddenPresence(everything()))).toBe(false); // unchanged: nothing goes on the wire
    expect(aw.getLocalState()).toEqual(VIEWING);
    expect(cleanPresenceState(aw.getLocalState())).toMatchObject({ status: VIEWING_STATUS });
    expect(sessionAnnotates(aw.getLocalState() as PresenceState)).toBe(false);
    aw.destroy();
  });
});
