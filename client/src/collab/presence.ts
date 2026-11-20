import type { Awareness } from 'y-protocols/awareness';
import { equalityDeep } from 'lib0/function';
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

/**
 * Merge `patch` into this tab's presence. A patch that changes nothing is not set: every
 * setLocalState goes on the wire (y-protocols raises the clock even for an equal state), and a
 * follower used to republish its unchanged viewport on every awareness update of the presenter.
 * Returns whether the state changed. y-protocols renews an unchanged state by itself (every 15 s).
 */
export function setPresence(aw: Awareness, patch: Partial<PresenceState>): boolean {
  const cur = aw.getLocalState() as Record<string, unknown> | null;
  if (cur && Object.entries(patch).every(([k, v]) => k in cur && equalityDeep(cur[k], v))) return false;
  aw.setLocalState({ ...(cur ?? {}), ...patch });
  return true;
}

/**
 * The status of a session whose canvas is hidden: it views the artifact and annotates nothing.
 * Its presence has the user (forced by the server), this status, and nothing else (no cursor,
 * viewport, laser, presentation or following). A key of the `cursor.<word>` form the presence
 * schema already accepts (shared/src/awareness.ts), so no server change was needed.
 */
export const VIEWING_STATUS = 'cursor.viewing';

/**
 * What a session with the canvas hidden publishes of a presence patch: the viewing status and no
 * following, always; a cursor, viewport or laser in the patch goes out as null, and presenting as
 * false. With the user (forced by the server) that is the whole of a hidden tab's presence
 * (docs/protocol.md §2). Editor.publishPresence passes every patch through here while hidden.
 */
export function hiddenPresence(patch: Partial<PresenceState>): Partial<PresenceState> {
  const out: Partial<PresenceState> = { ...patch, status: VIEWING_STATUS, following: null };
  for (const k of ['cursor', 'viewport', 'laser'] as const) if (k in out) out[k] = null;
  if ('presenting' in out) out.presenting = false;
  return out;
}

/** A person in the room, other than this user, and whether any of their sessions annotates. */
export interface AudienceMember {
  user: PresenceUser;
  annotating: boolean;
}

/** Who else is here (docs/protocol.md §6, "Viewing and annotating"). */
export interface Audience {
  /** Other people with the artifact open, in any session: annotating ones included. */
  viewing: number;
  /** Of those, the people with the canvas shown in at least one session. */
  annotating: number;
  /** Annotating first, then by name. */
  members: AudienceMember[];
}

/** Does this session annotate (its canvas shown)? A hidden one publishes no viewport and VIEWING_STATUS. */
export function sessionAnnotates(state: PresenceState): boolean {
  return !!state.viewport && state.status !== VIEWING_STATUS;
}

/**
 * Count people, not sessions: several tabs or devices of one user count once, and a user is
 * annotating when any of their sessions is. This user (`meId`, all of their sessions) is never
 * counted. Before the identity is known (`meId` null) only this session is left out (peers()).
 */
export function audienceOf(list: readonly Peer[], meId: string | null): Audience {
  const byUser = new Map<string, AudienceMember>();
  for (const p of list) {
    const u = p.state.user;
    if (!u || u.id === meId) continue;
    const m = byUser.get(u.id);
    const annotating = sessionAnnotates(p.state);
    if (m) m.annotating ||= annotating;
    else byUser.set(u.id, { user: u, annotating });
  }
  const members = [...byUser.values()].sort((a, b) => Number(b.annotating) - Number(a.annotating) || a.user.name.localeCompare(b.user.name));
  return { viewing: members.length, annotating: members.filter((m) => m.annotating).length, members };
}
