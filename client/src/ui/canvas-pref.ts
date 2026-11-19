/**
 * Is the canvas shown or hidden when a page opens? (docs/protocol.md §2 "Visibility")
 *
 *   1. `?present=1`: shown, in presentation mode.
 *   2. `?canvas=1` shown, `?canvas=0` hidden. A query parameter decides this visit only; it is
 *      not remembered.
 *   3. The person's last choice (the toggle), kept in localStorage per user, not per artifact.
 *   4. A first visit: hidden. The artifact looks like the original page, with a small pill to
 *      open the canvas.
 *
 * The user is known only once the server says who it is, so the page opens with the choice of
 * the last user of this browser, and the editor checks again when the identity arrives.
 */

export const PREF_PREFIX = 'artifacts-canvas:canvas:';
export const LAST_USER_KEY = 'artifacts-canvas:last-user';
const MAX_USER_KEY = 512;

export interface Visibility {
  visible: boolean;
  /** A query parameter decided it (the stored choice does not apply to this visit). */
  forced: boolean;
  /** `?present=1`: open in presentation mode. */
  present: boolean;
}

/** What the URL says, if it says anything. */
export function queryVisibility(q: URLSearchParams): Visibility | null {
  if (q.get('present') === '1') return { visible: true, forced: true, present: true };
  const c = q.get('canvas');
  if (c === '1') return { visible: true, forced: true, present: false };
  if (c === '0') return { visible: false, forced: true, present: false };
  return null;
}

/** The visibility for this visit, from the URL and the stored choice ('1' shown, '0' hidden, null none). */
export function decideVisibility(q: URLSearchParams, stored: string | null): Visibility {
  const fromQuery = queryVisibility(q);
  if (fromQuery) return fromQuery;
  return { visible: stored === '1', forced: false, present: false };
}

function key(userId: string): string | null {
  if (!userId || userId.length > MAX_USER_KEY) return null;
  return PREF_PREFIX + userId;
}

/** The stored choice of `userId`: '1', '0' or null. Never throws (storage may be blocked). */
export function readPref(storage: Storage | null, userId: string | null): string | null {
  if (!storage || !userId) return null;
  const k = key(userId);
  if (!k) return null;
  try {
    const v = storage.getItem(k);
    return v === '1' || v === '0' ? v : null;
  } catch {
    return null;
  }
}

/** Remember `userId`'s choice (the toggle only, never a query parameter). */
export function writePref(storage: Storage | null, userId: string | null, visible: boolean): void {
  const k = userId ? key(userId) : null;
  if (!storage || !k) return;
  try {
    storage.setItem(k, visible ? '1' : '0');
    storage.setItem(LAST_USER_KEY, userId!);
  } catch {
    /* storage full or blocked: the choice is not remembered */
  }
}

export function readLastUser(storage: Storage | null): string | null {
  try {
    return storage?.getItem(LAST_USER_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeLastUser(storage: Storage | null, userId: string): void {
  try {
    storage?.setItem(LAST_USER_KEY, userId);
  } catch {
    /* ignore */
  }
}
