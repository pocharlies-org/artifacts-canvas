import { describe, expect, it } from 'vitest';
import { LAST_USER_KEY, PREF_PREFIX, decideVisibility, queryVisibility, readLastUser, readPref, writeLastUser, writePref } from '../src/ui/canvas-pref';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

/** Storage that refuses every call (blocked cookies, a full quota). */
const blocked = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
} as unknown as Storage;

const q = (s: string) => new URLSearchParams(s);

describe('canvas shown or hidden at load', () => {
  it('a first visit is hidden', () => {
    expect(decideVisibility(q(''), null)).toEqual({ visible: false, forced: false, present: false });
  });

  it("the user's last choice applies when the URL says nothing", () => {
    expect(decideVisibility(q(''), '1')).toEqual({ visible: true, forced: false, present: false });
    expect(decideVisibility(q('lang=en'), '0')).toEqual({ visible: false, forced: false, present: false });
  });

  it('?canvas=1 and ?canvas=0 force this visit, whatever was chosen', () => {
    expect(decideVisibility(q('canvas=1'), '0')).toEqual({ visible: true, forced: true, present: false });
    expect(decideVisibility(q('canvas=0'), '1')).toEqual({ visible: false, forced: true, present: false });
    // anything else is ignored
    expect(decideVisibility(q('canvas=yes'), '0').visible).toBe(false);
    expect(queryVisibility(q('canvas=true'))).toBeNull();
  });

  it('?present=1 means shown, in presentation mode, even with ?canvas=0', () => {
    expect(decideVisibility(q('present=1'), '0')).toEqual({ visible: true, forced: true, present: true });
    expect(decideVisibility(q('present=1&canvas=0'), '0')).toEqual({ visible: true, forced: true, present: true });
    expect(decideVisibility(q('present=0'), null).present).toBe(false);
  });
});

describe('the stored choice', () => {
  it('is per user, not per artifact, and remembers the last user', () => {
    const s = new MemStorage();
    expect(readPref(s, 'ana@corp')).toBeNull();
    writePref(s, 'ana@corp', true);
    writePref(s, 'anon:4821', false);
    expect(readPref(s, 'ana@corp')).toBe('1');
    expect(readPref(s, 'anon:4821')).toBe('0');
    expect(s.getItem(PREF_PREFIX + 'ana@corp')).toBe('1');
    expect(readLastUser(s)).toBe('anon:4821');
    writeLastUser(s, 'ana@corp');
    expect(s.getItem(LAST_USER_KEY)).toBe('ana@corp');
    // the page opens with the last user's choice before the server says who it is
    expect(decideVisibility(q(''), readPref(s, readLastUser(s))).visible).toBe(true);
  });

  it('ignores values it did not write and absurd keys; never throws', () => {
    const s = new MemStorage();
    s.setItem(PREF_PREFIX + 'ana@corp', 'shown');
    expect(readPref(s, 'ana@corp')).toBeNull();
    expect(readPref(s, null)).toBeNull();
    expect(readPref(s, '')).toBeNull();
    writePref(s, 'x'.repeat(600), true);
    expect(s.length).toBe(1);
    expect(readPref(null, 'ana@corp')).toBeNull();
    expect(() => writePref(null, 'ana@corp', true)).not.toThrow();
    expect(readPref(blocked, 'ana@corp')).toBeNull();
    expect(() => writePref(blocked, 'ana@corp', true)).not.toThrow();
    expect(readLastUser(blocked)).toBeNull();
    expect(() => writeLastUser(blocked, 'ana@corp')).not.toThrow();
  });
});
