/**
 * Presenting and following, as a pure state machine over the awareness peers (no DOM, no
 * network: the editor feeds it the peers it sees and publishes what it decides).
 *
 * A session (one tab: one awareness client id) either presents, or follows one target, or does
 * neither.
 *
 *   - A presenting session never follows anyone, so it can never end up following itself.
 *   - Every other session follows the presenter on its own, the presenter's other sessions
 *     included (the same person in another tab or on another device): presenting is followed by
 *     session, not by person.
 *   - A follower that stops following a presenter (a button, or by panning or zooming itself) is
 *     left alone until that presenter stops presenting; it can follow it again by hand.
 *   - When the presenter stops presenting or disconnects (its awareness state goes away), its
 *     followers are released.
 *   - Following a person by hand ("Seguir a ...") copies the viewport of that person's presenting
 *     session when it has one, else of its first session; it ends when the person leaves.
 *
 * Two sessions that present at once are allowed: neither follows the other, and the followers
 * keep the one they follow, or take the one with the lowest client id.
 */

export interface FollowPeer {
  /** Awareness client id: one per tab or device. */
  clientId: number;
  userId: string;
  presenting: boolean;
}

export interface FollowTarget {
  userId: string;
  /** The session followed (a presenter); null: any session of `userId` (a manual follow). */
  clientId: number | null;
  reason: 'manual' | 'presenter';
}

export interface FollowState {
  /** This session presents. */
  presenting: boolean;
  target: FollowTarget | null;
  /** The presenter session this tab stopped following: not followed again while it presents. */
  dismissed: number | null;
}

export const INITIAL_FOLLOW: FollowState = { presenting: false, target: null, dismissed: null };

/** Peers other than this session (a peer list never holds the session itself; this makes sure). */
function others(peers: readonly FollowPeer[], self: number): FollowPeer[] {
  return peers.filter((p) => p.clientId !== self);
}

/**
 * The presenting session a follower takes: the one it already follows while that one still
 * presents, else the one with the lowest client id (the same choice in every tab). Never `self`.
 */
export function currentPresenter(peers: readonly FollowPeer[], self: number, s: FollowState = INITIAL_FOLLOW): FollowPeer | null {
  const presenting = others(peers, self).filter((p) => p.presenting);
  if (!presenting.length) return null;
  const kept = s.target?.reason === 'presenter' ? presenting.find((p) => p.clientId === s.target!.clientId) : undefined;
  if (kept) return kept;
  return presenting.reduce((a, b) => (b.clientId < a.clientId ? b : a));
}

/** The peers changed (awareness): follow, release or keep. */
export function onPeers(s: FollowState, peers: readonly FollowPeer[], self: number): FollowState {
  const list = others(peers, self);
  let { target, dismissed } = s;
  // a dismissed presenter that no longer presents (or left) may be followed again later
  if (dismissed !== null && !list.some((p) => p.clientId === dismissed && p.presenting)) dismissed = null;
  if (s.presenting) return target || dismissed !== s.dismissed ? { presenting: true, target: null, dismissed } : s;
  const presenter = currentPresenter(list, self, s);
  if (target?.reason === 'presenter' && target.clientId !== presenter?.clientId) target = null;
  if (target?.reason === 'manual' && !list.some((p) => p.userId === target!.userId)) target = null;
  if (!target && presenter && presenter.clientId !== dismissed) {
    target = { userId: presenter.userId, clientId: presenter.clientId, reason: 'presenter' };
  }
  if (target === s.target && dismissed === s.dismissed) return s;
  return { presenting: false, target, dismissed };
}

/** This session starts presenting: it follows nobody. */
export function startPresenting(s: FollowState): FollowState {
  return { presenting: true, target: null, dismissed: s.dismissed };
}

/** This session stops presenting: it follows another presenter, if one is presenting. */
export function stopPresenting(s: FollowState, peers: readonly FollowPeer[], self: number): FollowState {
  return onPeers({ presenting: false, target: null, dismissed: s.dismissed }, peers, self);
}

/** Follow a person by hand. A presenting session does not follow. */
export function followUser(s: FollowState, userId: string, peers: readonly FollowPeer[], self: number): FollowState {
  if (s.presenting) return s;
  const list = others(peers, self);
  // that person presents: follow its presenting session (the same thing the auto-follow does)
  const pres = list.filter((p) => p.userId === userId && p.presenting).sort((a, b) => a.clientId - b.clientId)[0];
  if (pres) return { presenting: false, target: { userId, clientId: pres.clientId, reason: 'presenter' }, dismissed: null };
  if (!list.some((p) => p.userId === userId)) return s;
  return { presenting: false, target: { userId, clientId: null, reason: 'manual' }, dismissed: s.dismissed };
}

/** Follow the current presenter again (after "Dejar de seguir"). */
export function followPresenter(s: FollowState, peers: readonly FollowPeer[], self: number): FollowState {
  if (s.presenting) return s;
  const p = currentPresenter(peers, self, { ...s, target: null });
  if (!p) return s;
  return { presenting: false, target: { userId: p.userId, clientId: p.clientId, reason: 'presenter' }, dismissed: null };
}

/** Stop following (the button, or the user moved the camera). A presenter left is not re-followed. */
export function stopFollowing(s: FollowState): FollowState {
  if (!s.target) return s;
  const dismissed = s.target.reason === 'presenter' ? s.target.clientId : s.dismissed;
  return { presenting: s.presenting, target: null, dismissed };
}

/** The session whose viewport a follower copies, or null. */
export function targetPeer(s: FollowState, peers: readonly FollowPeer[], self: number): FollowPeer | null {
  const t = s.target;
  if (!t || s.presenting) return null;
  const list = others(peers, self);
  if (t.clientId !== null) return list.find((p) => p.clientId === t.clientId) ?? null;
  const mine = list.filter((p) => p.userId === t.userId);
  return mine.find((p) => p.presenting) ?? mine[0] ?? null;
}
