import type { Box } from '../geometry/vec';

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
 */
export const REPORTER_SOURCE = 'artifacts-canvas-reporter';
const MAX_HEIGHT = 100000;

export interface FrameEvents {
  size?: (w: number, h: number) => void;
  title?: (t: string) => void;
  scroll?: (x: number, y: number) => void;
}

export class ArtifactFrame {
  readonly el: HTMLIFrameElement;
  width: number;
  height: number;
  title = '';
  loaded = false;
  private pending = new Map<string, (img: HTMLImageElement | null) => void>();
  private growthStreak = 0;

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
    this.el = f;
    parent.appendChild(f);
    window.addEventListener('message', this.onMessage);
  }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.el.contentWindow) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || d.source !== REPORTER_SOURCE) return;
    switch (d.type) {
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
        const img = new Image();
        img.onload = () => cb(img);
        img.onerror = () => cb(null);
        img.src = url;
        return;
      }
    }
  };

  /** Ask the artifact for a PNG of `rect` (artifact px) at `scale`. Resolves null on failure. */
  snapshot(rect: Box, scale: number, timeoutMs = 20000): Promise<HTMLImageElement | null> {
    const win = this.el.contentWindow;
    if (!win) return Promise.resolve(null);
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (img) => {
        clearTimeout(timer);
        resolve(img);
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
