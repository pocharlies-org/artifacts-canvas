import type { Box, Pt } from '../geometry/vec';

/** screen = world * z + t */
export interface Camera {
  tx: number;
  ty: number;
  z: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function screenToWorld(c: Camera, p: Pt): Pt {
  return { x: (p.x - c.tx) / c.z, y: (p.y - c.ty) / c.z };
}

export function worldToScreen(c: Camera, p: Pt): Pt {
  return { x: p.x * c.z + c.tx, y: p.y * c.z + c.ty };
}

/** Zoom to `z` keeping the world point under screen point `anchor` fixed. */
export function zoomAt(c: Camera, z: number, anchor: Pt): Camera {
  const nz = clampZoom(z);
  const w = screenToWorld(c, anchor);
  return { z: nz, tx: anchor.x - w.x * nz, ty: anchor.y - w.y * nz };
}

export function nextZoomStep(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 1e-6) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? MIN_ZOOM;
}

/** The world rectangle visible in a viewport of size w x h. */
export function visibleWorld(c: Camera, w: number, h: number): Box {
  return { x: -c.tx / c.z, y: -c.ty / c.z, w: w / c.z, h: h / c.z };
}

/** Camera that fits `box` inside the viewport (w x h) with `pad` screen px, zoom capped at `maxZ`. */
export function fitBox(box: Box, w: number, h: number, pad = 40, maxZ = 1): Camera {
  const z = clampZoom(Math.min((w - pad * 2) / Math.max(box.w, 1), (h - pad * 2) / Math.max(box.h, 1), maxZ));
  return { z, tx: w / 2 - (box.x + box.w / 2) * z, ty: h / 2 - (box.y + box.h / 2) * z };
}

/** Camera showing the same world rect another person sees (follow / presenter mode). */
export function matchViewport(rect: Box, w: number, h: number): Camera {
  const z = clampZoom(Math.min(w / Math.max(rect.w, 1), h / Math.max(rect.h, 1)));
  return { z, tx: w / 2 - (rect.x + rect.w / 2) * z, ty: h / 2 - (rect.y + rect.h / 2) * z };
}
