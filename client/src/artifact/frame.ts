import type { Box } from '../geometry/vec';
import { MAX_LINK_LENGTH } from './links';

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
  private pending = new Map<string, (snap: FrameSnapshot | null) => void>();
  private growthStreak = 0;
  private probes = new Map<string, (link: boolean) => void>();
  private probeSeq = 0;

  constructor(parent: HTMLElement, src: string, width: number, initialHeight: number, private vendorUrl: string, private ev: FrameEvents = {}) {
    this.width = width;
    this.height = initialHeight;
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
    switch (d.type) {
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
        const h = Number(d.h);
        if (!isFinite(h) || h <= 0) return;
        const nh = Math.min(MAX_HEIGHT, Math.ceil(h));
        if (Math.abs(nh - this.height) < 2) return;
        // guard against layouts that grow with the viewport height (100vh + margin) forever
        if (nh > this.height) this.growthStreak++;
        else this.growthStreak = 0;
        if (this.growthStreak > 20) return;
        this.height = nh;
        this.el.style.height = `${nh}px`;
        this.ev.size?.(this.width, nh);
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
