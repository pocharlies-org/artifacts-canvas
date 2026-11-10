import type { Awareness } from 'y-protocols/awareness';
import { cleanPresenceState } from '@pocharlies/artifacts-canvas-shared/awareness';
import { personColor } from '../model/colors';
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
    // schema-checked copy (the server checks too; a development relay or an older server may
    // not): a malformed or oversized state never reaches the renderer (fv4 M3)
    const s = cleanPresenceState(state) as PresenceState | null;
    if (!s || !s.user) continue;
    if (!s.user.color) s.user.color = personColor(s.user.id, s.user.anonymous);
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
