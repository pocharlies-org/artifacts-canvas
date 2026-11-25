import type { Editor } from '../editor/editor';
import type { ToolId } from '../tools/tools';
import { t, type MessageKey } from '../i18n';
import { h } from './dom';

/**
 * Presentation mode, the UI side (the editor holds the state: Editor.setPresenting).
 *
 *   - "Presentar" (or `?present=1`) enters it: the page goes fullscreen (Fullscreen API) where
 *     the browser allows it, else it stays a maximised in-page view (an iPhone has no
 *     Fullscreen API); the editing chrome is hidden and a few floating controls stay (laser,
 *     pen, interact, undo, exit), with a "Presentando · Esc para salir" badge.
 *   - Fullscreen needs a user gesture, and the mode never asks for one. Without it (the deep
 *     link, a page opened from a link while presenting) the browser refuses, and the mode stays
 *     maximised in the page; the presenter's next gesture (a press on the board or the controls,
 *     a key other than Esc) then asks for fullscreen from inside its own handler, once, and still
 *     does its own job. Refused again, the page stays maximised, silently.
 *   - Esc, the exit button, or leaving fullscreen by any other way ends the mode.
 * `document.body.dataset.present` says how it shows: `fullscreen`, `fallback` (in-page) or
 * absent (not presenting); the tests read it.
 */

type Fs = { requestFullscreen?: (o?: FullscreenOptions) => Promise<void>; webkitRequestFullscreen?: () => void };
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };

function fullscreenElement(): Element | null {
  const d = document as FsDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function fullscreenEnabled(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenEnabled ?? d.webkitFullscreenEnabled);
}

function requestFullscreen(): Promise<void> {
  const el = document.documentElement as HTMLElement & Fs;
  try {
    if (el.requestFullscreen) return el.requestFullscreen({ navigationUI: 'hide' });
    if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen(); // older Safari: no promise; the change event tells
      return Promise.resolve();
    }
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.reject(new Error('no fullscreen'));
}

function exitFullscreen() {
  const d = document as FsDoc;
  if (!fullscreenElement()) return;
  if (d.exitFullscreen) void d.exitFullscreen().catch(() => undefined);
  else d.webkitExitFullscreen?.();
}

/**
 * The mode is on but not fullscreen (refused: no gesture, a policy): the presenter's next gesture
 * asks for it (buildPresentation's onGesture). One try; nothing shows meanwhile.
 */
let retryOnGesture = false;

/** Enter presentation mode; call it from a click (fullscreen needs the gesture) or the deep link. */
export function startPresentation(ed: Editor) {
  ed.setPresenting(true);
  tryFullscreen(ed);
}

function tryFullscreen(ed: Editor) {
  retryOnGesture = false;
  if (fullscreenElement() || !fullscreenEnabled()) return;
  void requestFullscreen().catch(() => {
    if (ed.presenting && !fullscreenElement()) retryOnGesture = true;
  });
}

/** Does this page have a user gesture now? A browser without the API may: it is tried. */
function hasActivation(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return ua ? ua.isActive : true;
}

/** Keys that alone are no gesture to ask with (a browser may not count them). */
const LONE_KEYS = new Set(['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'Dead', 'Unidentified']);

export function stopPresentation(ed: Editor) {
  ed.setPresenting(false);
}

/** Badge and floating controls; keeps body classes and the URL in step, and fullscreen on the next gesture. */
export function buildPresentation(ed: Editor, root: HTMLElement) {
  const badge = h('div', { class: 'present-badge', 'data-testid': 'present-badge', role: 'status' }, t('present.badge'));

  const tools: { id: ToolId; icon: string; tip: MessageKey }[] = [
    { id: 'laser', icon: '✦', tip: 'tool.laser' },
    { id: 'draw', icon: '✎', tip: 'tool.draw' },
    { id: 'interact', icon: '👆', tip: 'tool.interact' },
  ];
  const toolBtns = tools.map((x) => {
    const b = h('button', { class: 'tool', 'data-tip': t(x.tip), 'aria-label': t(x.tip), 'data-testid': `present-tool-${x.id}`, onclick: () => ed.setTool(x.id) }, x.icon);
    return { b, id: x.id };
  });
  const undo = h('button', { class: 'tool', 'data-tip': t('ctl.undo'), 'aria-label': t('ctl.undo'), 'data-testid': 'present-undo', onclick: () => ed.undo() }, '↶');
  const exit = h('button', { class: 'tool exit', 'data-tip': t('present.exit'), 'aria-label': t('present.exit'), 'data-testid': 'present-exit', onclick: () => stopPresentation(ed) }, '✕');
  const controls = h('div', { class: 'present-controls', role: 'toolbar', 'data-testid': 'present-controls' },
    ...toolBtns.map((x) => x.b), h('div', { class: 'sep' }), undo, exit);
  const ui = h('div', { class: 'present-ui' }, badge, controls);
  root.append(ui);

  const syncTools = () => {
    for (const { b, id } of toolBtns) {
      b.classList.toggle('on', ed.tool === id);
      b.setAttribute('aria-pressed', String(ed.tool === id));
    }
    undo.disabled = !ed.doc.canUndo();
  };

  let wasFullscreen = false;
  let lastOn = ed.presenting;
  const sync = () => {
    const on = ed.presenting;
    const fs = !!fullscreenElement();
    document.body.classList.toggle('present-mode', on);
    if (on) document.body.dataset.present = fs ? 'fullscreen' : 'fallback';
    else delete document.body.dataset.present;
    if (!on && fs && wasFullscreen) {
      // this exit is the mode's own (it ended first): its fullscreenchange comes later, maybe after
      // a new presentation started (Esc, then "Presentar" at once), and must not end that one
      wasFullscreen = false;
      exitFullscreen();
    }
    if (!on) retryOnGesture = false;
    // the URL says it too, on every change: a reload presents again, and after the mode ends it does not
    if (on !== lastOn) {
      lastOn = on;
      const url = new URL(location.href);
      if (on) url.searchParams.set('present', '1');
      else url.searchParams.delete('present');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
    syncTools();
  };
  const onFsChange = () => {
    const fs = !!fullscreenElement();
    if (fs) {
      wasFullscreen = true;
      retryOnGesture = false;
    } else if (wasFullscreen) {
      wasFullscreen = false;
      // Esc in fullscreen (the browser takes that key) or the browser's own exit: the mode ends
      if (ed.presenting) ed.setPresenting(false);
    } else if (ed.presenting) {
      // the mode's own exit finished after a new presentation started (it could not ask for
      // fullscreen while the exit was under way): it stays in the page, and the next gesture asks
      retryOnGesture = fullscreenEnabled();
    }
    sync();
  };
  // The next gesture after a refusal asks for fullscreen, from inside its handler (the browser
  // wants the gesture there). It only listens: the press or key still does its own job (a laser
  // point, a tool, a slide link). A press goes with a mouse, a release with a finger or a pen
  // (the events that carry the gesture). Esc and the exit button end the mode instead.
  const onGesture = (e: Event) => {
    if (!retryOnGesture || !ed.presenting || fullscreenElement()) return;
    if (e instanceof KeyboardEvent) {
      if (LONE_KEYS.has(e.key)) return;
    } else {
      if ((e.type === 'pointerdown') !== ((e as PointerEvent).pointerType === 'mouse')) return;
      if (e.target instanceof Node && exit.contains(e.target)) return;
    }
    if (!hasActivation()) return;
    retryOnGesture = false;
    void requestFullscreen().catch(() => undefined);
  };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('pointerup', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  ed.on('present', sync);
  ed.on('tool', syncTools);
  ed.on('history', syncTools);
  ed.doc.undoManager.on('stack-item-added', syncTools);
  ed.doc.undoManager.on('stack-item-popped', syncTools);
  sync();
}

/** `?present=1`: open in presentation mode once the page (and the artifact frame) has loaded. */
export function presentFromUrl(ed: Editor) {
  if (new URLSearchParams(location.search).get('present') !== '1') return;
  const go = () => startPresentation(ed);
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}
