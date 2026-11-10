import { has, t } from '../i18n';
import { personColor } from './colors';
import type { Attribution, HistoryEntry, Shape, ShapeType, GeoKind, UserInfo } from './types';

/** "Ana Torres" -> "Ana T."; anonymous pseudonyms and single names stay as they are. */
export function shortName(name: string, anonymous = false): string {
  if (anonymous) return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

/** First name for history lines ("Ana movió…"). */
export function firstName(name: string, anonymous = false): string {
  if (anonymous) return name;
  return name.trim().split(/\s+/)[0] || name;
}

export function displayUser(users: (id: string) => UserInfo | undefined, id: string): { name: string; anonymous: boolean; color: string } {
  const u = users(id);
  if (u) return { name: u.name, anonymous: u.anonymous, color: u.color || personColor(id, u.anonymous) };
  const anon = id.startsWith('anon:');
  // anonymous ids are opaque (anon:<visitor id>); only a legacy anon:NNNN carries the number
  const name = anon ? (/^anon:\d{4}$/.test(id) ? `Anónimo ${id.slice(5)}` : 'Anónimo') : id || '?';
  return { name, anonymous: anon, color: personColor(id, anon) };
}

export function shapeTypeLabel(type: ShapeType, geo?: GeoKind, highlight?: boolean): string {
  if (type === 'geo') return geo && has(`geo.${geo}`) ? t(`geo.${geo}` as never) : t('geo.rectangle');
  if (type === 'draw' && highlight) return t('shape.highlight');
  return t(`shape.${type}` as never);
}

export function shapeArticle(type: ShapeType, geo?: GeoKind, highlight?: boolean): string {
  if (type === 'geo') {
    const k = `a.geo.${geo}`;
    return has(k) ? t(k) : t('a.geo');
  }
  if (type === 'draw' && highlight) return t('a.highlight');
  return t(`a.${type}` as never);
}

export function formatTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return hm;
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return `${t('history.yesterday')} ${hm}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

export function formatTimeVerbose(ts: number, now = Date.now()): string {
  const s = formatTime(ts, now);
  return /^\d\d:\d\d$/.test(s) ? `${t('history.today')} ${s}` : s;
}

export function describeHistory(e: HistoryEntry, users: (id: string) => UserInfo | undefined): string {
  const who = displayUser(users, e.by);
  let what = shapeArticle(e.shapeType, e.geo, e.highlight);
  if (e.owner && e.owner !== e.by) {
    const o = displayUser(users, e.owner);
    what = t('what.owned', { what, owner: firstName(o.name, o.anonymous) });
  }
  const key = e.verb === 'create' && e.shapeType === 'draw' ? 'verb.create.draw' : (`verb.${e.verb}` as const);
  return t(key as never, { who: firstName(who.name, who.anonymous), what });
}

/** "Rectángulo · dibujado por Iván P." / "hoy 10:14 · editado por Ana T. 10:16" */
export function hoverLines(s: Shape, a: Attribution | undefined, users: (id: string) => UserInfo | undefined, now = Date.now()): [string, string] {
  const type = shapeTypeLabel(s.type, s.type === 'geo' ? s.geo : undefined, s.type === 'draw' ? s.highlight : undefined);
  if (!a) return [type, ''];
  const c = displayUser(users, a.createdBy);
  const line1 = t('hover.drawnBy', { type, name: shortName(c.name, c.anonymous) });
  let line2 = formatTimeVerbose(a.createdAt, now);
  if (a.updatedBy && (a.updatedBy !== a.createdBy || a.updatedAt - a.createdAt > 60000)) {
    const u = displayUser(users, a.updatedBy);
    line2 = t('hover.editedBy', { time: line2, name: shortName(u.name, u.anonymous), time2: formatTime(a.updatedAt, now) });
  }
  return [line1, line2];
}

export function initials(name: string, anonymous: boolean): string {
  if (anonymous) return 'A';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '?';
}
