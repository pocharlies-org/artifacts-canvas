import { describe, expect, it } from 'vitest';
import {
  INITIAL_FOLLOW, currentPresenter, followPresenter, followUser, onPeers, startPresenting, stopFollowing, stopPresenting,
  targetPeer, type FollowPeer, type FollowState,
} from '../src/collab/follow';

/**
 * A room of sessions, each with its own follow state, fed the awareness peers the way the
 * editor feeds them (every other session, never itself).
 */
class Room {
  sessions = new Map<number, { userId: string; s: FollowState }>();

  join(clientId: number, userId: string) {
    this.sessions.set(clientId, { userId, s: INITIAL_FOLLOW });
    this.settle();
  }

  leave(clientId: number) {
    this.sessions.delete(clientId);
    this.settle();
  }

  peersOf(self: number): FollowPeer[] {
    return [...this.sessions].filter(([id]) => id !== self).map(([clientId, x]) => ({ clientId, userId: x.userId, presenting: x.s.presenting }));
  }

  set(clientId: number, f: (s: FollowState, peers: FollowPeer[]) => FollowState) {
    const x = this.sessions.get(clientId)!;
    x.s = f(x.s, this.peersOf(clientId));
    this.settle();
  }

  /** Every session sees the awareness change; repeat until nothing changes (it must settle). */
  settle() {
    for (let round = 0; round < 10; round++) {
      let changed = false;
      for (const [id, x] of this.sessions) {
        const next = onPeers(x.s, this.peersOf(id), id);
        if (next !== x.s) {
          x.s = next;
          changed = true;
        }
      }
      if (!changed) return;
    }
    throw new Error('the follow states do not settle');
  }

  /** The session whose viewport `clientId` copies, or null. */
  follows(clientId: number): number | null {
    return targetPeer(this.sessions.get(clientId)!.s, this.peersOf(clientId), clientId)?.clientId ?? null;
  }

  state(clientId: number) {
    return this.sessions.get(clientId)!.s;
  }

  /** No session follows itself, and following never goes round in a circle. */
  assertNoLoops() {
    for (const id of this.sessions.keys()) {
      const seen = new Set<number>([id]);
      for (let cur = this.follows(id); cur !== null; cur = this.follows(cur)) {
        expect(seen.has(cur), `follow loop through ${cur}`).toBe(false);
        seen.add(cur);
      }
    }
  }
}

describe('presenter / follow state machine', () => {
  it('the others follow the presenter; stopping releases them', () => {
    const r = new Room();
    r.join(1, 'ana');
    r.join(2, 'marta');
    r.join(3, 'luis');
    r.set(1, startPresenting);
    expect(r.state(1).presenting).toBe(true);
    expect(r.follows(1)).toBeNull();
    expect(r.follows(2)).toBe(1);
    expect(r.follows(3)).toBe(1);
    expect(r.state(2).target).toEqual({ userId: 'ana', clientId: 1, reason: 'presenter' });
    r.assertNoLoops();
    r.set(1, (s, p) => stopPresenting(s, p, 1));
    expect(r.follows(2)).toBeNull();
    expect(r.follows(3)).toBeNull();
    expect(r.state(2).target).toBeNull();
  });

  it('the presenter disconnecting releases every follower', () => {
    const r = new Room();
    r.join(1, 'ana');
    r.join(2, 'marta');
    r.set(1, startPresenting);
    expect(r.follows(2)).toBe(1);
    r.leave(1);
    expect(r.state(2)).toEqual({ presenting: false, target: null, dismissed: null });
    // a new presenter later is followed again
    r.join(4, 'luis');
    r.set(4, startPresenting);
    expect(r.follows(2)).toBe(4);
  });

  it("the presenter's other sessions (same person) follow it; the presenting session never follows itself", () => {
    const r = new Room();
    r.join(10, 'ana'); // laptop
    r.join(11, 'ana'); // second tab
    r.join(12, 'ana'); // phone
    r.set(10, startPresenting);
    expect(r.follows(10)).toBeNull();
    expect(r.state(10).target).toBeNull();
    expect(r.follows(11)).toBe(10);
    expect(r.follows(12)).toBe(10);
    r.assertNoLoops();
    // the session itself is never a presenter candidate for itself
    expect(currentPresenter([{ clientId: 10, userId: 'ana', presenting: true }], 10)).toBeNull();
    expect(onPeers(INITIAL_FOLLOW, [{ clientId: 10, userId: 'ana', presenting: true }], 10)).toBe(INITIAL_FOLLOW);
    r.leave(10);
    expect(r.follows(11)).toBeNull();
    expect(r.follows(12)).toBeNull();
  });

  it('a follower that stops following stays put until that presenter stops, and can follow again', () => {
    const r = new Room();
    r.join(1, 'ana');
    r.join(2, 'marta');
    r.set(1, startPresenting);
    r.set(2, stopFollowing);
    expect(r.follows(2)).toBeNull();
    expect(r.state(2).dismissed).toBe(1);
    // more awareness traffic does not pull it back
    r.join(3, 'luis');
    expect(r.follows(2)).toBeNull();
    expect(r.follows(3)).toBe(1);
    // "Seguir" again
    r.set(2, (s, p) => followPresenter(s, p, 2));
    expect(r.follows(2)).toBe(1);
    r.set(2, stopFollowing);
    // the presenter stops and presents again: followed again on its own
    r.set(1, (s, p) => stopPresenting(s, p, 1));
    expect(r.state(2).dismissed).toBeNull();
    r.set(1, startPresenting);
    expect(r.follows(2)).toBe(1);
  });

  it('a presenting session never follows, even by hand, and taking over a presentation leaves no loop', () => {
    const r = new Room();
    r.join(1, 'ana');
    r.join(2, 'ana');
    r.set(1, startPresenting);
    expect(r.follows(2)).toBe(1);
    // the second tab presents as well: it stops following; neither follows the other
    r.set(2, startPresenting);
    expect(r.follows(1)).toBeNull();
    expect(r.follows(2)).toBeNull();
    r.set(2, (s, p) => followUser(s, 'ana', p, 2));
    expect(r.follows(2)).toBeNull();
    r.assertNoLoops();
    // the first one stops: it follows the one that still presents, and that one follows nobody
    r.set(1, (s, p) => stopPresenting(s, p, 1));
    expect(r.follows(1)).toBe(2);
    expect(r.follows(2)).toBeNull();
    r.assertNoLoops();
  });

  it('two presenters at once: every follower takes the same one and keeps it', () => {
    const r = new Room();
    r.join(5, 'ana');
    r.join(3, 'luis');
    r.join(7, 'marta');
    r.set(5, startPresenting);
    expect(r.follows(7)).toBe(5);
    r.set(3, startPresenting);
    expect(r.follows(7)).toBe(5); // kept, although 3 is lower
    r.join(8, 'eva');
    expect(r.follows(8)).toBe(3); // a newcomer takes the lowest client id
    r.set(5, (s, p) => stopPresenting(s, p, 5));
    expect(r.follows(7)).toBe(3);
    expect(r.follows(5)).toBe(3);
    r.assertNoLoops();
  });

  it('following a person by hand, and that person leaving', () => {
    const r = new Room();
    r.join(1, 'ana');
    r.join(2, 'ana');
    r.join(3, 'marta');
    r.set(3, (s, p) => followUser(s, 'ana', p, 3));
    expect(r.state(3).target).toEqual({ userId: 'ana', clientId: null, reason: 'manual' });
    expect(r.follows(3)).toBe(1);
    // ana presents from her second tab: a hand follow keeps following ana, now her presenting tab
    r.set(2, startPresenting);
    expect(r.follows(3)).toBe(2);
    r.set(2, (s, p) => stopPresenting(s, p, 2));
    r.leave(1);
    expect(r.follows(3)).toBe(2);
    r.leave(2);
    expect(r.state(3).target).toBeNull();
    // following someone who is not there does nothing
    expect(followUser(INITIAL_FOLLOW, 'nobody', [], 3)).toBe(INITIAL_FOLLOW);
  });

  it('a hand follow of a presenting person follows the presenting session', () => {
    const peers: FollowPeer[] = [
      { clientId: 4, userId: 'ana', presenting: false },
      { clientId: 9, userId: 'ana', presenting: true },
    ];
    const s = followUser({ presenting: false, target: null, dismissed: 9 }, 'ana', peers, 1);
    expect(s).toEqual({ presenting: false, target: { userId: 'ana', clientId: 9, reason: 'presenter' }, dismissed: null });
  });

  it('a hand follow wins over a presenter that starts later; stopping it does not dismiss the presenter', () => {
    const r = new Room();
    r.join(1, 'ana');
    r.join(2, 'marta');
    r.join(3, 'luis');
    r.set(3, (s, p) => followUser(s, 'marta', p, 3));
    r.set(1, startPresenting);
    expect(r.follows(3)).toBe(2);
    expect(r.follows(2)).toBe(1);
    r.set(3, stopFollowing);
    // nothing dismissed: the presenter is picked up at the next awareness change
    expect(r.state(3).dismissed).toBeNull();
    expect(r.follows(3)).toBe(1);
    r.assertNoLoops();
  });

  it('starting to present drops what the session followed', () => {
    const peers: FollowPeer[] = [{ clientId: 2, userId: 'marta', presenting: true }];
    const following = onPeers(INITIAL_FOLLOW, peers, 1);
    expect(following.target?.clientId).toBe(2);
    const presenting = startPresenting(following);
    expect(presenting).toEqual({ presenting: true, target: null, dismissed: null });
    expect(targetPeer(presenting, peers, 1)).toBeNull();
    expect(onPeers(presenting, peers, 1)).toBe(presenting);
    expect(followPresenter(presenting, peers, 1)).toBe(presenting);
  });
});
