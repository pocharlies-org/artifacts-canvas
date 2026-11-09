/*
 * Local definitions for the vendored client modules (stamper.ts, protocol.ts).
 * ROOT and the type definitions mirror client/src/model/doc.ts and
 * client/src/model/types.ts; test/vendor-drift.test.ts guards the copies.
 */
export const ROOT = {
  shapes: 'shapes',
  assets: 'assets',
  meta: 'meta',
  attribution: 'attribution',
  users: 'users',
  history: 'history',
} as const;

export type GeoKind =
  | 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'pentagon' | 'hexagon' | 'octagon'
  | 'star' | 'rhombus' | 'trapezoid' | 'cloud' | 'heart' | 'oval'
  | 'check-box' | 'x-box' | 'arrow-right' | 'arrow-left' | 'arrow-up' | 'arrow-down';

export type ShapeType = 'draw' | 'line' | 'arrow' | 'text' | 'note' | 'geo' | 'frame' | 'image';

export interface Attribution {
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedAt: number;
}

/** A participant as recorded in the root map `users` (keyed by user id). */
export interface UserInfo {
  name: string;
  anonymous: boolean;
  color?: string;
}

export type HistoryVerb =
  | 'create' | 'move' | 'resize' | 'rotate' | 'edit' | 'style' | 'delete' | 'order' | 'group' | 'lock';

export interface HistoryEntry {
  t: number;
  by: string;
  verb: HistoryVerb;
  shapeId: string;
  shapeType: ShapeType;
  geo?: GeoKind;
  highlight?: boolean;
  /** createdBy of the shape at the time of the change, when it differs from `by`. */
  owner?: string;
}

export interface Identity {
  id: string;
  name: string;
  anonymous: boolean;
  color?: string;
  /** 'server': the server stamps attribution/history/users. 'client': this client must do it. */
  attribution: 'server' | 'client';
  readOnly?: boolean;
}
