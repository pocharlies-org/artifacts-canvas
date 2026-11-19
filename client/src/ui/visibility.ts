import type { Editor } from '../editor/editor';
import { encodePath } from '../config';
import { t } from '../i18n';
import { h } from './dom';
import { decideVisibility, readLastUser, readPref, writeLastUser, writePref, type Visibility } from './canvas-pref';

/**
 * Canvas shown or hidden (ui/canvas-pref.ts decides which at load). Hidden, the artifact looks
 * like the original page; a small pill opens the canvas ("✏️ Canvas · 3": the annotations in the
 * room), says who is annotating, and links to the original (`?raw=1`, which the core serves
 * without the canvas). Shown, the full editor, with "Ocultar canvas" in the top bar. The body
 * carries `canvas-hidden` while hidden.
 */
export interface VisibilityControl {
  /** Show or hide; `remember`: the user's choice (the toggle), kept for their next visits. */
  set(visible: boolean, remember: boolean): void;
  readonly initial: Visibility;
}

/** The plain artifact URL with `?raw=1`, or null when this page cannot know it. */
export function originalUrl(ed: Editor): string | null {
  const fromServer = ed.cfg.artifactUrl;
  let path: string | null = null;
  if (typeof fromServer === 'string' && fromServer.startsWith('/') && !fromServer.startsWith('//')) path = fromServer;
  else if (ed.links.artifactBase) path = ed.links.artifactBase + encodePath(ed.cfg.artifactPath);
  else if (ed.cfg.dev) path = ed.cfg.frameUrl;
  return path ? `${path}?raw=1` : null;
}

export function buildVisibility(ed: Editor, root: HTMLElement, storage: Storage | null, query: URLSearchParams): VisibilityControl {
  const initial = decideVisibility(query, readPref(storage, readLastUser(storage)));
  /** The visibility was chosen in this visit (a query parameter or the toggle): the identity does not change it. */
  let settled = initial.forced;
  /** A toggle made before the server said who the user is: remembered once it does. */
  let pendingChoice: boolean | null = null;

  const set = (visible: boolean, remember: boolean) => {
    if (remember) {
      settled = true;
      if (ed.me) writePref(storage, ed.me.id, visible);
      else pendingChoice = visible;
    }
    ed.setCanvasVisible(visible);
  };

  const count = h('span', { class: 'quiet-count', 'data-testid': 'canvas-count' });
  const pill = h('button', { class: 'quiet-pill', 'data-testid': 'canvas-show', title: t('canvas.show'), 'aria-label': t('canvas.show') },
    '✏️ ', h('span', { class: 'quiet-name' }, t('canvas.pill')), count);
  pill.addEventListener('click', () => set(true, true));
  const people = h('span', { class: 'quiet-people', 'data-testid': 'canvas-people', hidden: true });
  const href = originalUrl(ed);
  const original = href ? h('a', { class: 'quiet-link', 'data-testid': 'canvas-original', href, rel: 'noreferrer' }, t('canvas.original')) : null;
  const bar = h('div', { class: 'quiet-bar', 'data-testid': 'canvas-quiet', role: 'toolbar' }, pill, people, original);
  root.append(bar);

  const syncCount = () => {
    const n = ed.annotationCount();
    count.textContent = n ? ` · ${n}` : '';
  };
  const syncPeople = () => {
    const n = ed.othersDrawing();
    people.hidden = n === 0;
    people.textContent = n === 1 ? t('canvas.people.one') : t('canvas.people.many', { n });
  };
  const syncBody = () => document.body.classList.toggle('canvas-hidden', ed.hidden);

  ed.on('doc', syncCount);
  ed.on('history', syncCount);
  ed.on('presence', syncPeople);
  ed.on('canvas', syncBody);
  // the user is known: their own stored choice applies (unless this visit already decided)
  let knownUser: string | null = null;
  const onIdentity = () => {
    const id = ed.me?.id;
    if (!id || id === knownUser) return;
    knownUser = id;
    writeLastUser(storage, id);
    if (pendingChoice !== null) {
      writePref(storage, id, pendingChoice);
      pendingChoice = null;
    }
    if (settled) return;
    ed.setCanvasVisible(readPref(storage, id) === '1');
  };
  ed.on('identity', onIdentity);
  syncCount();
  syncPeople();
  if (!initial.visible) ed.setCanvasVisible(false);
  if (ed.me) onIdentity();
  syncBody();
  return { set, initial };
}
