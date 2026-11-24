import type { Box } from '../geometry/vec';
import { MAX_LINK_LENGTH } from './links';
import { parseColor, type Rgba } from '../ui/theme';

/**
 * The artifact, rendered in a sandboxed iframe (`sandbox="allow-scripts"`, never
 * `allow-same-origin`), so it runs in an opaque origin: no cookies, no storage and no
 * same-origin access to this wrapper page.
 *
 * Scroll/size approach (design §7): the iframe is laid out at a fixed page width and sized to
 * the artifact's full content height; it never scrolls itself. The canvas camera pans and zooms
 * the iframe and the drawings together, so world coordinates ARE artifact CSS pixels and
 * annotations stay on the element they were drawn on. The content height comes from a tiny
 * reporter script (public/reporter.js) that the server injects into the artifact HTML; it only
 * posts {size, title, scroll} and, on request, a PNG snapshot for export.
 *
 * Interacting with the artifact (docs/protocol.md §3 "Links"): with the interact tool the frame
 * takes the pointer, and the reporter turns a click on a link into a `link` message (the wrapper
 * decides what it opens, artifact/links.ts), a same-document anchor into an `anchor` position,
 * and a wheel that nothing inside the page scrolls into a `wheel` message (the camera pans).
 * The select tool asks the reporter which element is under a point (`probe`) and to follow the
 * link there (`click`). Every message is checked: it must come from this frame's window, with
 * the opaque origin "null", the reporter's source tag and the right field types.
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
  /** The artifact's background colour (checked: rgb(), rgba() or hex only). */
  background?: (c: Rgba) => void;
  /** Where the hidden page was being read, said once the canvas layout is back (FrameReading). */
  reading?: (r: FrameReading) => void;
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
      this.loaded = true;
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
      case 'key':
        if (d.key === 'Escape') this.ev.escape?.();
        return;
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
        const h = Number(d.h);
        if (!isFinite(h) || h <= 0) return;
        const nh = Math.min(MAX_HEIGHT, Math.ceil(h));
        if (Math.abs(nh - this.height) < 2) return;
        // guard against layouts that grow with the viewport height (100vh + margin) forever
        if (nh > this.height) this.growthStreak++;
        else this.growthStreak = 0;
        if (this.growthStreak > 20) return;
        this.height = nh;
        // native mode: the page scrolls inside a frame the size of the view; only its height is noted
        if (!this.native) {
          this.canvasHeight = nh;
          this.el.style.height = `${nh}px`;
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
    win.postMessage({ source: 'artifacts-canvas', type: 'mode', native: this.native }, '*');
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
