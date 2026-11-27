import type { Box } from '../geometry/vec';
import { MAX_LINK_LENGTH } from './links';
import { parseColor, type Rgba } from '../ui/theme';
import { stepOf } from '../editor/slides';

/**
 * The artifact, rendered in a sandboxed iframe (`sandbox="allow-scripts"`, never
 * `allow-same-origin`), so it runs in an opaque origin: no cookies, no storage and no
 * same-origin access to this wrapper page.
 *
 * Scroll/size approach (design §7): the iframe is laid out at a fixed page width and sized to
 * the artifact's full content height; it never scrolls itself. The canvas camera pans and zooms
 * the iframe and the drawings together, so world coordinates ARE artifact CSS pixels and
 * annotations stay on the element they were drawn on. The content height comes from a tiny
 * reporter script (public/reporter.js) that the server injects into the artifact HTML; it posts
 * {size, title, scroll, bg, reading} and, with native scroll, `pos`, and answers what the wrapper
 * asks (`slides`, `probe`, and a PNG snapshot for export); what the user does in the page (links,
 * anchors, wheel, keys) is below. docs/protocol.md §3 lists every message.
 *
 * Native scroll (design §6.4): at the zoom the page is read at, the frame is instead a window as
 * tall as the view (`setScroller`), the wrapper asks the reporter to scroll the document
 * (`scrollTo`) and the reporter says where it is (`pos`): the window sits at that line of the
 * page, so world coordinates stay artifact pixels and the frame does not move on the screen.
 *
 * Interacting with the artifact (docs/protocol.md §3 "Links"): with the interact tool the frame
 * takes the pointer, and the reporter turns a click on a link into a `link` message (the wrapper
 * decides what it opens, artifact/links.ts), a same-document anchor into an `anchor` position,
 * and a wheel that nothing inside the page scrolls into a `wheel` message (the camera pans).
 * The select tool asks the reporter which element is under a point (`probe`) and to follow the
 * link there (`click`); a presentation asks where the page's slides are (`slides`), and a camera
 * move says so (`motion`: the page's animation frames wait until the camera stands still). Every message
 * is checked: it must come from this frame's window, with the opaque origin "null", the
 * reporter's source tag and the right field types.
 */
export const REPORTER_SOURCE = 'artifacts-canvas-reporter';
const MAX_HEIGHT = 100000;

/** A snapshot of the artifact; `partial`: some of it (an image, a background) could not be read. */
export interface FrameSnapshot {
  img: HTMLImageElement;
  partial: boolean;
}

export interface FrameWheel {
  dx: number;
  dy: number;
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
  mode: number;
  /** ctrl or ⌘ held (a trackpad pinch arrives as ctrl + wheel): zoom. */
  zoom: boolean;
  shift: boolean;
  /** Pointer position in artifact pixels (world coordinates). */
  x: number;
  y: number;
}

export interface FrameEvents {
  size?: (w: number, h: number) => void;
  title?: (t: string) => void;
  scroll?: (x: number, y: number) => void;
  /** A link was clicked in the artifact: `href` as the frame resolved it, not checked yet. */
  link?: (href: string, newTab: boolean) => void;
  /** A same-document anchor was followed: its target is at (x, y) artifact px. */
  anchor?: (x: number, y: number) => void;
  /** A wheel over the artifact that no element of the page scrolled. */
  wheel?: (w: FrameWheel) => void;
  /** Escape pressed inside the artifact. */
  escape?: () => void;
  /** A key that steps a presentation (editor/slides.ts stepOf), pressed inside the artifact and left by the page. */
  step?: (dir: 1 | -1, key: string) => void;
  /** Native scroll: the document is scrolled to `y` artifact px; `seq`, the last scroll request it applied. */
  scrolled?: (y: number, seq: number) => void;
  /** The artifact's background colour (checked: rgb(), rgba() or hex only). */
  background?: (c: Rgba) => void;
  /** Where the hidden page was being read, said once the canvas layout is back (FrameReading). */
  reading?: (r: FrameReading) => void;
  /**
   * A new document loaded in the frame (the page reloaded or navigated itself): its reporter starts
   * over and knows no native scroll period. Called before the mode goes out to it.
   */
  reload?: () => void;
}

/**
 * A block of the page the user was reading while the canvas was hidden: its box on the screen then
 * (left, top, width nw, screen px) and in the canvas layout now (x, y, width w, artifact px).
 */
export interface FrameReading {
  x: number;
  y: number;
  w: number;
  left: number;
  top: number;
  nw: number;
}

/**
 * Where the page's slides are (the reporter's `slides` answer): their tops in artifact px, sorted,
 * and the target of the #hash asked about, or null.
 */
export interface FrameSlides {
  tops: number[];
  target: { x: number; y: number } | null;
}

/** Most slide tops taken from one answer. */
export const MAX_SLIDES = 500;

/**
 * At most one `motion` message per this many ms while the camera moves; the reporter holds the
 * page's animation frames 250 ms after the last one it got (docs/protocol.md §3 "Camera motion").
 */
export const MOTION_PING_MS = 100;

/** Most a wheel delta may say (one event); anything bigger is clamped. */
const MAX_WHEEL = 10000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class ArtifactFrame {
  readonly el: HTMLIFrameElement;
  width: number;
  height: number;
  title = '';
  loaded = false;
  /** The pointer is over the frame (it only gets the pointer with the interact tool). */
  hovered = false;
  /** The artifact's background colour, once the reporter has said it. */
  background: Rgba | null = null;
  /**
   * Native mode (the canvas hidden): the frame fills the view and the page scrolls on its own,
   * as the plain artifact does. Otherwise it is laid out at the page width and full height.
   */
  native = false;
  /** The reporter of the current document knows the mode (it starts in canvas mode). */
  private reporterTold = false;
  /**
   * The page's height as the reporter last measured it in canvas mode (the frame starts there).
   * Native mode lays the page out at the view's size, so its height says nothing about the
   * canvas layout; the frame goes back to this one when the canvas is shown again.
   */
  private canvasHeight: number;
  private pending = new Map<string, (snap: FrameSnapshot | null) => void>();
  private growthStreak = 0;
  private probes = new Map<string, (link: boolean) => void>();
  private probeSeq = 0;
  private slideAsks = new Map<string, (s: FrameSlides | null) => void>();
  /** When the last `motion` message went out (performance.now()). */
  private motionAt = -Infinity;
  /** The reporter can scroll its document for the wrapper (it said so in its `size` message). */
  canScroll = false;
  /** Native scroll: the frame is a window `windowH` artifact px tall and the document scrolls in it. */
  scroller = false;
  windowH = 0;
  /** Changes with every scroller period: a `pos` of another one is late and dropped. */
  private scrollEpoch = 0;
  /** Where the document goes when a scroller period starts (sent with the mode). */
  private entryY = 0;

  constructor(parent: HTMLElement, src: string, width: number, initialHeight: number, private vendorUrl: string, private ev: FrameEvents = {}) {
    this.width = width;
    this.height = initialHeight;
    this.canvasHeight = initialHeight;
    const f = document.createElement('iframe');
    // Opaque origin: scripts only. Never add allow-same-origin, allow-top-navigation or allow-popups-to-escape-sandbox.
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('scrolling', 'no');
    f.setAttribute('tabindex', '-1');
    f.setAttribute('aria-hidden', 'true');
    f.className = 'artifact-frame';
    f.style.width = `${width}px`;
    f.style.height = `${initialHeight}px`;
    f.src = src;
    f.addEventListener('load', () => {
      const again = this.loaded;
      this.loaded = true;
      if (again) this.ev.reload?.();
      this.sendMode();
      this.reporterTold = true;
    });
    f.addEventListener('pointerenter', () => {
      this.hovered = true;
    });
    f.addEventListener('pointerleave', () => {
      this.hovered = false;
    });
    this.el = f;
    parent.appendChild(f);
    window.addEventListener('message', this.onMessage);
  }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.el.contentWindow) return;
    // the frame is sandboxed without allow-same-origin: its origin is opaque, serialised "null"
    if (e.origin !== 'null') return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || d.source !== REPORTER_SOURCE) return;
    // the reporter starts in canvas mode: tell it the mode as soon as it speaks (before its load event)
    if (!this.reporterTold) {
      this.reporterTold = true;
      this.sendMode();
    }
    switch (d.type) {
      case 'bg': {
        const c = parseColor(d.color);
        if (!c) return;
        const b = this.background;
        if (b && b.r === c.r && b.g === c.g && b.b === c.b && b.a === c.a) return;
        this.background = c;
        this.ev.background?.(c);
        return;
      }
      case 'link':
        if (typeof d.href === 'string' && d.href.length <= MAX_LINK_LENGTH && typeof d.newTab === 'boolean') this.ev.link?.(d.href, d.newTab);
        return;
      case 'anchor': {
        if (!finite(d.x) || !finite(d.y)) return;
        this.ev.anchor?.(Math.max(0, Math.min(this.width, d.x)), Math.max(0, Math.min(this.height, d.y)));
        return;
      }
      case 'wheel': {
        if (!finite(d.dx) || !finite(d.dy) || !finite(d.x) || !finite(d.y) || (d.mode !== 0 && d.mode !== 1 && d.mode !== 2)) return;
        const clamp = (v: number) => Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, v));
        this.ev.wheel?.({ dx: clamp(d.dx), dy: clamp(d.dy), mode: d.mode, zoom: d.zoom === true, shift: d.shift === true, x: d.x, y: d.y });
        return;
      }
      case 'key': {
        if (d.key === 'Escape') {
          this.ev.escape?.();
          return;
        }
        const dir = typeof d.key === 'string' ? stepOf(d.key, d.shift === true) : 0;
        if (dir) this.ev.step?.(dir, d.key as string);
        return;
      }
      case 'slides': {
        const cb = typeof d.id === 'string' ? this.slideAsks.get(d.id) : undefined;
        if (!cb) return;
        this.slideAsks.delete(d.id as string);
        const c = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
        const tops = Array.isArray(d.tops) ? d.tops.slice(0, MAX_SLIDES).filter(finite).map((y) => c(y, this.height)) : [];
        const t = d.target as Record<string, unknown> | null;
        const target = t && typeof t === 'object' && finite(t.x) && finite(t.y) ? { x: c(t.x, this.width), y: c(t.y, this.height) } : null;
        cb({ tops: tops.sort((a, b) => a - b), target });
        return;
      }
      case 'probe': {
        const cb = typeof d.id === 'string' ? this.probes.get(d.id) : undefined;
        if (!cb) return;
        this.probes.delete(d.id as string);
        cb(d.link === true);
        return;
      }
      case 'size': {
        // measured in the other mode (the mode message is still on its way): it says nothing
        // about this one. In canvas mode a page measured at the view's units could be taken for
        // the canvas layout, and the frame would grow with it.
        if (typeof d.native === 'boolean' && d.native !== this.native) return;
        if (d.canScroll === true) this.canScroll = true;
        const h = Number(d.h);
        if (!isFinite(h) || h <= 0) return;
        const nh = Math.min(MAX_HEIGHT, Math.ceil(h));
        if (Math.abs(nh - this.height) < 2) return;
        // guard against layouts that grow with the viewport height (100vh + margin) forever
        if (nh > this.height) this.growthStreak++;
        else this.growthStreak = 0;
        if (this.growthStreak > 20) return;
        this.height = nh;
        // native mode: the page scrolls inside a frame the size of the view; only its height is noted.
        // Native scroll: the frame is a window of the view's height, the page's height is noted too.
        if (!this.native) {
          this.canvasHeight = nh;
          if (!this.scroller) this.el.style.height = `${nh}px`;
        }
        this.ev.size?.(this.width, nh);
        return;
      }
      case 'reading': {
        // sent once the canvas layout is back (canvas mode only); the editor takes it right after
        // it showed the canvas, and it moves this tab's camera only
        if (this.native) return;
        if (![d.x, d.y, d.w, d.left, d.top, d.nw].every(finite)) return;
        const w = d.w as number;
        const nw = d.nw as number;
        if (!(w > 0) || !(nw > 0)) return;
        const c = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
        this.ev.reading?.({
          x: c(d.x as number, 0, this.width), y: c(d.y as number, 0, this.height), w: Math.min(w, this.width),
          left: c(d.left as number, -MAX_HEIGHT, MAX_HEIGHT), top: c(d.top as number, -MAX_HEIGHT, MAX_HEIGHT), nw: Math.min(nw, MAX_HEIGHT),
        });
        return;
      }
      case 'pos': {
        // native scroll: where the document is; a report of an earlier period (or mode) is late
        if (!this.scroller || this.native || d.epoch !== this.scrollEpoch) return;
        if (!finite(d.y) || !finite(d.seq)) return;
        this.ev.scrolled?.(Math.max(0, Math.min(this.height, d.y)), d.seq);
        return;
      }
      case 'title':
        if (typeof d.title === 'string') {
          this.title = d.title.slice(0, 200);
          this.ev.title?.(this.title);
        }
        return;
      case 'scroll': {
        const x = Number(d.x);
        const y = Number(d.y);
        if (isFinite(x) && isFinite(y)) this.ev.scroll?.(x, y);
        return;
      }
      case 'snapshot': {
        const id = String(d.id ?? '');
        const cb = this.pending.get(id);
        if (!cb) return;
        this.pending.delete(id);
        const url = d.dataUrl;
        if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,') || url.length > 120_000_000) {
          cb(null);
          return;
        }
        const partial = d.partial === true;
        const img = new Image();
        img.onload = () => cb({ img, partial });
        img.onerror = () => cb(null);
        img.src = url;
        return;
      }
    }
  };

  /** Is there a link of the artifact at (x, y) artifact px? Resolves false when the frame does not say. */
  probe(x: number, y: number, timeoutMs = 1000): Promise<boolean> {
    const win = this.el.contentWindow;
    if (!win || !this.loaded) return Promise.resolve(false);
    const id = `p${++this.probeSeq}`;
    // only the latest probe matters (the pointer moved on): forget the older ones
    for (const [old, cb] of this.probes) {
      this.probes.delete(old);
      cb(false);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.probes.delete(id)) resolve(false);
      }, timeoutMs);
      this.probes.set(id, (link) => {
        clearTimeout(timer);
        resolve(link);
      });
      win.postMessage({ source: 'artifacts-canvas', type: 'probe', id, x, y }, '*');
    });
  }

  /**
   * Where are the page's slides, and where is the target of `hash` (a `#id`, or '' for none)?
   * Resolves null when the frame does not say (no reporter, or no answer in time).
   */
  slides(hash = '', timeoutMs = 1000): Promise<FrameSlides | null> {
    const win = this.el.contentWindow;
    if (!win || !this.loaded) return Promise.resolve(null);
    const id = `s${++this.probeSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.slideAsks.delete(id)) resolve(null);
      }, timeoutMs);
      this.slideAsks.set(id, (s) => {
        clearTimeout(timer);
        resolve(s);
      });
      win.postMessage({ source: 'artifacts-canvas', type: 'slides', id, hash: hash.slice(0, MAX_LINK_LENGTH) }, '*');
    });
  }

  /**
   * The camera moved (canvas mode). Every camera move makes the frame render again, and the move
   * shows only once it has: the reporter holds the page's animation frames while the camera moves,
   * so a pan never waits for the page's own animation (docs/protocol.md §3 "Camera motion").
   */
  cameraMoved() {
    const win = this.el.contentWindow;
    if (this.native || !this.loaded || !win) return;
    const now = performance.now();
    if (now - this.motionAt < MOTION_PING_MS) return;
    this.motionAt = now;
    win.postMessage({ source: 'artifacts-canvas', type: 'motion' }, '*');
  }

  /**
   * Native scroll on: the frame becomes a window `h` artifact px tall and, when a period starts, the
   * document goes to `y` (the reporter applies it again once the window has its size). Already on,
   * only the window's height follows (the view changed). Off: the frame is as tall as the page
   * again and the document goes back to its top. Canvas mode only.
   */
  setScroller(on: boolean, h = 0, y = 0) {
    if (this.native) return;
    if (on) {
      this.windowH = h;
      this.el.style.height = `${h}px`;
      if (this.scroller) return;
      this.scroller = true;
      this.scrollEpoch++;
      this.entryY = y;
      this.sendMode();
    } else if (this.scroller) {
      this.scroller = false;
      this.scrollEpoch++;
      this.el.style.height = `${this.canvasHeight}px`;
      this.sendMode();
    }
  }

  /** Native scroll: scroll the document to `y` artifact px; the reporter answers `pos` with `seq`. */
  scrollTo(y: number, seq: number) {
    const win = this.el.contentWindow;
    if (!this.scroller || !win) return;
    win.postMessage({ source: 'artifacts-canvas', type: 'scroll-to', y, seq, epoch: this.scrollEpoch }, '*');
  }

  /** Follow the link of the artifact at (x, y) artifact px, if there is one (the select tool's click). */
  clickAt(x: number, y: number, newTab: boolean) {
    this.el.contentWindow?.postMessage({ source: 'artifacts-canvas', type: 'click', x, y, newTab }, '*');
  }

  /**
   * Native mode on (the frame takes `w` x `h`, the view, and the page scrolls itself) or off
   * (the page width, its full height, no scrolling: the canvas pans it).
   */
  setNative(on: boolean, w = 0, h = 0) {
    if (on !== this.native) this.growthStreak = 0;
    this.native = on;
    if (this.scroller) {
      // native scroll is a canvas-mode layout: either way the frame starts again as tall as the page
      this.scroller = false;
      this.scrollEpoch++;
    }
    // the frame scrolls only in native mode (the canvas pans it otherwise)
    this.el.setAttribute('scrolling', on ? 'auto' : 'no');
    if (on) {
      this.el.style.width = `${w}px`;
      this.el.style.height = `${h}px`;
    } else {
      // the canvas layout's own height, not the native one (the frame cannot measure a page
      // shorter than itself, so it would keep the native height)
      this.height = this.canvasHeight;
      this.el.style.width = `${this.width}px`;
      this.el.style.height = `${this.height}px`;
    }
    this.sendMode();
  }

  private sendMode() {
    const win = this.el.contentWindow;
    if (!win) return;
    win.postMessage({ source: 'artifacts-canvas', type: 'mode', native: this.native, scroller: this.scroller, epoch: this.scrollEpoch, y: this.entryY }, '*');
  }

  /** With the interact tool the frame takes the pointer (links, buttons, inner scrolling). */
  setInteractive(on: boolean) {
    this.el.classList.toggle('interactive', on);
    if (!on) this.hovered = false;
    if (on) this.el.removeAttribute('aria-hidden');
    else this.el.setAttribute('aria-hidden', 'true');
  }

  /** Ask the artifact for a PNG of `rect` (artifact px) at `scale`. Resolves null on failure. */
  snapshot(rect: Box, scale: number, timeoutMs = 20000): Promise<FrameSnapshot | null> {
    const win = this.el.contentWindow;
    if (!win) return Promise.resolve(null);
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (snap) => {
        clearTimeout(timer);
        resolve(snap);
      });
      // The frame has an opaque origin, so '*' is the only usable target origin; the
      // message carries nothing secret (a rectangle and the public vendor URL).
      win.postMessage({ source: 'artifacts-canvas', type: 'snapshot', id, rect, scale, lib: this.vendorUrl }, '*');
    });
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    this.el.remove();
  }
}
