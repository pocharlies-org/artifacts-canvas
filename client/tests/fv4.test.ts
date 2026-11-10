/**
 * Regressions of the fourth independent verification (fv4), client side. Each case is the
 * verifier's PoC with the expectation turned around.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { MAX_TEXT_LENGTH } from '@pocharlies/artifacts-canvas-shared/model';
import { checkClientUpdate } from '@pocharlies/artifacts-canvas-shared/stamper';
import { materializeContent } from '@pocharlies/artifacts-canvas-shared/ledger';
import { readShape } from '../src/model/doc';
import { shapeMarkup } from '../src/render/shapeSvg';
import { layoutText, measureWidth } from '../src/render/text';
import { peers } from '../src/collab/presence';

const env = { get: () => undefined, asset: () => undefined };

/** One shape written by another client, as its update, plus the room it lands in. */
function remoteShape(fields: Record<string, unknown>, text?: string) {
  const room = materializeContent(new Y.Doc());
  const att = new Y.Doc();
  let upd: Uint8Array | null = null;
  att.on('update', (u: Uint8Array) => (upd = u));
  att.transact(() => {
    const m = new Y.Map<unknown>();
    att.getMap('shapes').set('s', m);
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    if (text !== undefined) {
      const t = new Y.Text();
      m.set('text', t);
      t.insert(0, text);
    }
  });
  return { room, update: upd! };
}

describe('fv4 H3: text wrapping is not cubic', () => {
  it('poc4: a 6002-character unbroken word in a 20 px box renders in < 50 ms', () => {
    const { room, update } = remoteShape({ id: 's', type: 'geo', geo: 'rectangle', x: 0, y: 0, w: 20, h: 20, size: 'xl' }, 'a ' + 'W'.repeat(6000));
    Y.applyUpdate(room, update);
    const shape = readShape(room.getMap('shapes').get('s'), 's')!;
    const t0 = performance.now();
    const svg = shapeMarkup(shape, env as never);
    const ms = performance.now() - t0;
    expect(svg).toContain('<text');
    expect(ms).toBeLessThan(50); // before: 19 476 ms for this input (1 002 chars: 206 ms)
  });

  it('long words still break into lines that fit, and no character is lost', () => {
    for (const word of ['W'.repeat(6000), 'abc'.repeat(700), 'x']) {
      const text = `a ${word} tail`;
      const t0 = performance.now();
      const lay = layoutText(text, 'draw', 24, 60);
      expect(performance.now() - t0).toBeLessThan(50);
      for (const l of lay.lines) if (l.length > 1) expect(measureWidth(l, 'draw', 24)).toBeLessThanOrEqual(60);
      expect(lay.lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    }
    // a leading word longer than the box is broken as well
    expect(layoutText('W'.repeat(50), 'draw', 24, 60).lines.length).toBeGreaterThan(1);
  });

  it('the server refuses text over MAX_TEXT_LENGTH; the client renders at most that many characters', () => {
    const over = remoteShape({ id: 's', type: 'note', x: 0, y: 0, w: 200, h: 200 }, 'x'.repeat(MAX_TEXT_LENGTH + 1));
    expect(checkClientUpdate(over.room, over.update).bad).toBe('shapes-schema');
    const at = remoteShape({ id: 's', type: 'note', x: 0, y: 0, w: 200, h: 200 }, 'x'.repeat(MAX_TEXT_LENGTH));
    expect(checkClientUpdate(at.room, at.update).bad).toBeNull();
    // a document written before the limit: shown truncated (still selectable and deletable)
    Y.applyUpdate(over.room, over.update);
    const s = readShape(over.room.getMap('shapes').get('s'), 's');
    expect(s).not.toBeNull();
    expect((s as { text: string }).text.length).toBe(MAX_TEXT_LENGTH);
    expect(layoutText('y'.repeat(MAX_TEXT_LENGTH * 2), 'sans', 12, null).lines[0].length).toBe(MAX_TEXT_LENGTH);
  });
});

describe('fv4 M2: image assets are raster data URLs only', () => {
  it('an image whose asset is a same-origin URL renders a placeholder, never an <image href>', () => {
    const image = { id: 'i', type: 'image', x: 0, y: 0, w: 50, h: 50, rotation: 0, index: 1, groupId: '', locked: false, color: 'black', fill: 'none', dash: 'solid', size: 'm', font: 'draw', arrowheads: 'end', opacity: 1, assetId: 'evil' } as const;
    for (const href of ['/oauth2/sign_out', 'https://elsewhere.example/x.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'javascript:alert(1)']) {
      const svg = shapeMarkup(image as never, { get: () => undefined, asset: () => href } as never);
      expect(svg, href).not.toContain('<image');
    }
    const ok = shapeMarkup(image as never, { get: () => undefined, asset: () => 'data:image/png;base64,AAAA' } as never);
    expect(ok).toContain('<image href="data:image/png;base64,AAAA"');
  });
});

describe('fv4 M3: awareness states are schema-checked on the client', () => {
  it('a malformed or heavy state from another client never reaches the renderer', () => {
    const local = new awarenessProtocol.Awareness(new Y.Doc());
    const remote = new awarenessProtocol.Awareness(new Y.Doc());
    const user = { id: 'u2', name: 'Two', anonymous: false };
    const now = Date.now();
    const cases: Record<string, unknown>[] = [
      { user, cursor: { x: 50, y: 50 }, laser: { pts: null, now: 1 }, status: 5 },
      { user, laser: { pts: Array.from({ length: 60_000 }, (_, i) => [i, i, now]), now } },
      { user, cursor: 'x', viewport: { x: 1 }, following: 7, presenting: 'yes' },
    ];
    for (const st of cases) {
      remote.setLocalState(st);
      awarenessProtocol.applyAwarenessUpdate(local, awarenessProtocol.encodeAwarenessUpdate(remote, [remote.clientID]), 'server');
      const [p] = peers(local);
      expect(p).toBeDefined();
      // the editor's onAwareness and the overlay read these unconditionally
      expect(() => p.state.laser && p.state.laser.pts.length).not.toThrow();
      expect(p.state.laser ?? null).toBeNull();
      expect(p.state.status ?? null).toBeNull();
      expect(p.state.cursor === undefined || p.state.cursor === null || typeof p.state.cursor.x === 'number').toBe(true);
      expect(typeof p.state.user!.color).toBe('string');
    }
    remote.setLocalState({ user, cursor: { x: 1, y: 2 }, status: 'cursor.typing', laser: { pts: [[1, 2, now]], now } });
    awarenessProtocol.applyAwarenessUpdate(local, awarenessProtocol.encodeAwarenessUpdate(remote, [remote.clientID]), 'server');
    const [p] = peers(local);
    expect(p.state).toMatchObject({ cursor: { x: 1, y: 2 }, status: 'cursor.typing', laser: { pts: [[1, 2, now]], now } });
  });
});
