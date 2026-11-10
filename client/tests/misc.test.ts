import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import { buildPdf } from '../src/export/pdf';
import { encodeIdentity, MSG_IDENTITY, parseIdentity } from '../src/collab/protocol';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { setLang, t } from '../src/i18n';
import { describeHistory, firstName, formatTime, hoverLines, shortName } from '../src/model/people';
import { sanitizePath } from '../src/config';
import { injectReporter } from '../dev/plugin';
import { clampZoom, fitBox, matchViewport, screenToWorld, visibleWorld, worldToScreen, zoomAt } from '../src/editor/camera';

describe('pdf writer', () => {
  it('writes a valid single-image-per-page PDF with a correct xref', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = buildPdf([{ jpeg, width: 100, height: 200 }, { jpeg, width: 100, height: 50 }], 'Título (x)');
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/MediaBox [0 0 75 150]');
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o).startsWith(`${i + 1} 0 obj\n`)).toBe(true));
    expect(offsets).toHaveLength(3 + 2 * 3);
  });
});

describe('protocol', () => {
  it('encodes and validates IDENTITY', () => {
    const msg = encodeIdentity({ id: 'ana.lopez', name: 'Ana', anonymous: false, attribution: 'server' });
    const dec = decoding.createDecoder(msg);
    expect(decoding.readVarUint(dec)).toBe(MSG_IDENTITY);
    expect(parseIdentity(decoding.readVarString(dec))).toMatchObject({ id: 'ana.lopez', name: 'Ana', anonymous: false, attribution: 'server' });
    expect(parseIdentity('{"id":"","name":"x","anonymous":false}')).toBeNull();
    expect(parseIdentity('{"id":"x","name":"x"}')).toBeNull();
    expect(parseIdentity('nope')).toBeNull();
    expect(parseIdentity('{"id":"x","name":"x","anonymous":true,"color":"red"}')?.color).toBeUndefined();
  });
});

describe('i18n', () => {
  it('es and en have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });
  it('interpolates', () => {
    setLang('es');
    expect(t('app.follow', { name: 'Ana' })).toBe('Seguir a Ana');
    setLang('en');
    expect(t('app.follow', { name: 'Ana' })).toBe('Follow Ana');
    setLang('es');
  });
});

describe('people', () => {
  const users = (id: string) => ({ ivan: { name: 'Iván Pérez', anonymous: false }, dan: { name: 'Ana Torres', anonymous: false } } as Record<string, { name: string; anonymous: boolean }>)[id];
  it('formats names', () => {
    expect(shortName('Ana Torres')).toBe('Ana T.');
    expect(shortName('Anónimo 4821', true)).toBe('Anónimo 4821');
    expect(firstName('Marta Ruiz')).toBe('Marta');
  });
  it('describes history lines like the mockup', () => {
    setLang('es');
    expect(describeHistory({ t: 0, by: 'dan', verb: 'move', shapeId: 's', shapeType: 'geo', geo: 'rectangle', owner: 'ivan' }, users)).toBe('Ana movió un rectángulo de Iván');
    expect(describeHistory({ t: 0, by: 'anon:4821', verb: 'create', shapeId: 's', shapeType: 'arrow' }, users)).toBe('Anónimo 4821 añadió una flecha');
    expect(describeHistory({ t: 0, by: 'dan', verb: 'create', shapeId: 's', shapeType: 'draw', highlight: true }, users)).toBe('Ana dibujó un resaltado');
  });
  it('builds the hover card', () => {
    const now = new Date(2026, 10, 9, 10, 20).getTime();
    const created = new Date(2026, 10, 9, 10, 14).getTime();
    const edited = new Date(2026, 10, 9, 10, 16).getTime();
    const s = { id: 's', type: 'geo', geo: 'rectangle' } as never;
    expect(hoverLines(s, { createdBy: 'ivan', createdAt: created, updatedBy: 'dan', updatedAt: edited }, users, now)).toEqual([
      'Rectángulo · dibujado por Iván P.',
      'hoy 10:14 · editado por Ana T. 10:16',
    ]);
    expect(formatTime(now - 86400000, now)).toBe('ayer 10:20');
  });
});

describe('config and dev server helpers', () => {
  it('sanitizes artifact paths', () => {
    expect(sanitizePath('/runs/../x/./a.html')).toBe('runs/x/a.html');
  });
  it('injects the reporter as the first script of <head>', () => {
    expect(injectReporter('<html><head><title>x</title></head></html>', 'R()')).toBe('<html><head><script>R()</script><title>x</title></head></html>');
    expect(injectReporter('<p>x</p>', 'a</script>b')).toBe('<script>a<\\/script>b</script><p>x</p>');
  });
});

describe('camera', () => {
  it('round-trips and zooms around an anchor', () => {
    const c = { tx: 10, ty: 20, z: 2 };
    const w = screenToWorld(c, { x: 110, y: 220 });
    expect(worldToScreen(c, w)).toEqual({ x: 110, y: 220 });
    const z = zoomAt(c, 4, { x: 110, y: 220 });
    expect(worldToScreen(z, w)).toEqual({ x: 110, y: 220 });
    expect(clampZoom(100)).toBe(8);
  });
  it('fits boxes and matches another viewport', () => {
    const c = fitBox({ x: 0, y: 0, w: 1000, h: 500 }, 1100, 600, 50, 1);
    expect(c.z).toBe(1);
    const m = matchViewport({ x: 100, y: 100, w: 500, h: 300 }, 1000, 600);
    const v = visibleWorld(m, 1000, 600);
    expect(v.x + v.w / 2).toBeCloseTo(350);
    expect(v.y + v.h / 2).toBeCloseTo(250);
  });
});
