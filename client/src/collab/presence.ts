import type { Awareness } from 'y-protocols/awareness';
import type { Box } from '../geometry/vec';

/** Laser points: [x, y, t] with t in ms on the sender's clock. Never stored in the document. */
export type LaserPoint = [number, number, number];

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  anonymous: boolean;
}

export interface PresenceState {
  user?: PresenceUser;
  cursor?: { x: number; y: number } | null;
  /** i18n key of what the person is doing, e.g. 'cursor.typingNote'. */
  status?: string | null;
  laser?: { pts: LaserPoint[]; now: number } | null;
  /** The world rectangle this person sees. */
  viewport?: Box | null;
  presenting?: boolean;
  following?: string | null;
}

export interface Peer {
  clientId: number;
  state: PresenceState;
}

/** Other participants (not this tab), one entry per awareness client. */
export function peers(aw: Awareness): Peer[] {
  const out: Peer[] = [];
  for (const [clientId, state] of aw.getStates()) {
    if (clientId === aw.clientID) continue;
    const s = state as PresenceState;
    if (!s || !s.user) continue;
    out.push({ clientId, state: s });
  }
  return out;
}

/** Unique people (by user id) among the peers, plus me. */
export function people(aw: Awareness): PresenceUser[] {
  const seen = new Map<string, PresenceUser>();
  const mine = (aw.getLocalState() as PresenceState | null)?.user;
  if (mine) seen.set(mine.id, mine);
  for (const p of peers(aw)) if (p.state.user && !seen.has(p.state.user.id)) seen.set(p.state.user.id, p.state.user);
  return Array.from(seen.values());
}

export function setPresence(aw: Awareness, patch: Partial<PresenceState>) {
  const cur = (aw.getLocalState() as PresenceState | null) ?? {};
  aw.setLocalState({ ...cur, ...patch });
}
