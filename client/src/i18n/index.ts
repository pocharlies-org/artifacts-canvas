import { en } from './en';
import { es, type MessageKey } from './es';

export type Lang = 'es' | 'en';
export type { MessageKey };

const CATALOGS: Record<Lang, Record<MessageKey, string>> = { es, en };

let current: Lang = 'es';

export function setLang(l: Lang) {
  current = CATALOGS[l] ? l : 'es';
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

export function getLang(): Lang {
  return current;
}

/** Spanish is the default UI language; English on request (?lang=en or server config). */
export function detectLang(explicit?: string | null): Lang {
  if (explicit === 'en' || explicit === 'es') return explicit;
  return 'es';
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let s: string = CATALOGS[current][key] ?? es[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Has key? (for optional keys such as a.geo.<kind>) */
export function has(key: string): key is MessageKey {
  return key in es;
}

export const catalogs = CATALOGS;
