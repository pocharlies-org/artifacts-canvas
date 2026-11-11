/**
 * Regressions of the fifth verification (fv5) in a REAL browser against the REAL server
 * (stack.ts): the verifier's browser PoCs with the expectation turned around.
 *   M-2  a keystroke while the tab reconnects with offline edits is never refused (4403)
 *   M-1  offline paste / undo / paste is accepted on reconnect
 *   M-3  the text editor never lets more than MAX_TEXT_LENGTH characters through
 *   M-7  one anonymous message with 72 000 presence states does not reach a viewer
 */
import { expect, test } from '@playwright/test';
import * as encoding from 'lib0/encoding';
import { allowAnonKey, allowUser, openAs, rawConnect, startStack, waitFor, type Stack } from './stack';

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

type W = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

for (const inject of [false, true]) {
  test(`M-2: offline typing, server restart, ${inject ? 'a keystroke while reconnecting' : 'no edit while reconnecting (control)'}: never closed 4403, the room gets every edit`, async ({ browser }) => {
    const key = `reports/fv5-reconnect-${inject}.html`;
    allowUser(stack.core, key, 'ana', 'u-ana', 'Ana');
    const a = await openAs(stack, browser, 'ana', key);
    await a.page.evaluate(() => {
      const W = window as unknown as W;
      const ed = W.__canvas.editor;
      W.__noteId = ed.doc.create({ type: 'note', x: 200, y: 200, w: 200, h: 200, text: 'online' });
      ed.doc.endGesture();
    });
    await a.page.waitForTimeout(1500); // saved
    // a keystroke handled right before the server's sync step 1, between two WebSocket
    // message tasks (where a real input event can land, e.g. while a big step 2 applies)
    await a.page.evaluate((inject) => {
      const W = window as unknown as W;
      const ed = W.__canvas.editor;
      const prov = ed.conn.provider;
      const orig = prov.messageHandlers[0];
      W.__armed = false;
      W.__injected = 0;
      prov.messageHandlers[0] = (enc: unknown, dec: { arr: Uint8Array; pos: number }, p: unknown, emitSynced: boolean, mt: number) => {
        if (inject && W.__armed && dec.arr[dec.pos] === 0) {
          W.__armed = false;
          W.__injected++;
          const sh = ed.doc.get(W.__noteId);
          ed.doc.update(W.__noteId, { text: sh.text + 'K' });
        }
        return orig(enc, dec, p, emitSynced, mt);
      };
      W.__typedOffline = 0;
      ed.conn.onStatus((st: string) => {
        if (st === 'disconnected' && !W.__typedOffline) {
          W.__typedOffline++;
          const sh = ed.doc.get(W.__noteId);
          ed.doc.update(W.__noteId, { text: sh.text + ' typed offline' });
          W.__armed = true;
        }
      });
    }, inject);
    await stack.restart();
    await waitFor(async () => (await a.page.evaluate(() => (window as unknown as W).__typedOffline)) > 0, 15_000, 'offline edit');
    const want = inject ? 'online typed offlineK' : 'online typed offline';
    await waitFor(async () => (await a.page.evaluate(() => (window as unknown as W).__canvas.editor.status)) === 'synced', 30_000, 'resynced');
    // a second viewer sees what the room holds
    allowUser(stack.core, key, 'bob', 'u-bob', 'Bob');
    const b = await openAs(stack, browser, 'bob', key);
    await waitFor(async () => (await b.page.evaluate(() => (window as unknown as W).__canvas.editor.doc.all().find((x: W) => x.type === 'note')?.text)) === want, 10_000, 'room has every edit');
    const r = await a.page.evaluate(() => ({ status: (window as unknown as W).__canvas.editor.status, closes: (window as unknown as W).__wsCloses as number[], injected: (window as unknown as W).__injected }));
    // before (inject): closes [1006, 4403], status "closed", the keystroke and the offline edit lost
    expect(r.closes.filter((c) => c >= 4400 && c < 4500)).toEqual([]);
    expect(r.status).toBe('synced');
    expect(r.injected).toBe(inject ? 1 : 0);
    expect(stack.serverLog()).not.toMatch(/forbidden content write/);
    await a.close();
    await b.close();
  });
}

test('M-1: offline paste 6 000 characters, undo, paste again; reconnect: accepted, the room holds the second paste', async ({ browser }) => {
  const key = 'reports/fv5-offline-paste.html';
  allowUser(stack.core, key, 'ana', 'u-ana', 'Ana');
  const a = await openAs(stack, browser, 'ana', key);
  await a.page.evaluate(() => {
    const W = window as unknown as W;
    const ed = W.__canvas.editor;
    W.__noteId = ed.doc.create({ type: 'note', x: 200, y: 200, w: 200, h: 200, text: 'online' });
    ed.doc.endGesture();
  });
  await a.page.waitForTimeout(1500);
  await a.page.evaluate(() => {
    const W = window as unknown as W;
    const ed = W.__canvas.editor;
    W.__done = 0;
    ed.conn.onStatus((st: string) => {
      if (st === 'disconnected' && !W.__done) {
        W.__done = 1;
        const id = W.__noteId;
        ed.doc.update(id, { text: 'online' + 'x'.repeat(6000) });
        ed.doc.endGesture();
        ed.doc.undo();
        ed.doc.update(id, { text: 'online' + 'y'.repeat(6000) });
        ed.doc.endGesture();
      }
    });
  });
  await stack.restart();
  await waitFor(async () => (await a.page.evaluate(() => (window as unknown as W).__done)) > 0, 15_000, 'offline edit');
  await waitFor(async () => (await a.page.evaluate(() => (window as unknown as W).__canvas.editor.status)) === 'synced', 30_000, 'resynced');
  allowUser(stack.core, key, 'bob', 'u-bob', 'Bob');
  const b = await openAs(stack, browser, 'bob', key);
  // before: the reconnect answer was refused (shapes-schema, 4403); the room kept "online"
  await waitFor(async () => (await b.page.evaluate(() => (window as unknown as W).__canvas.editor.doc.all().find((x: W) => x.type === 'note')?.text.length)) === 6006, 10_000, 'room has the paste');
  const closes = await a.page.evaluate(() => (window as unknown as W).__wsCloses as number[]);
  expect(closes.filter((c) => c >= 4400 && c < 4500)).toEqual([]);
  await a.close();
  await b.close();
});

for (const n of [10_000, 10_001, 12_000]) {
  test(`M-3: pasting ${n} characters into a note keeps at most 10 000 and the connection open`, async ({ browser }) => {
    const key = `reports/fv5-paste-${n}.html`;
    allowUser(stack.core, key, 'ana', 'u-ana', 'Ana');
    const a = await openAs(stack, browser, 'ana', key);
    const id = await a.page.evaluate(() => {
      const ed = (window as unknown as W).__canvas.editor;
      const id = ed.doc.create({ type: 'note', x: 200, y: 200, w: 200, h: 200 });
      ed.doc.endGesture();
      ed.startEditing(id);
      return id;
    });
    const ta = a.page.locator('[data-testid="text-editor"]');
    await ta.waitFor({ state: 'visible' });
    expect(await ta.getAttribute('maxlength')).toBe('10000');
    await ta.fill('y'.repeat(n));
    // a real paste (clipboard event) on top: cut to what fits
    await a.page.evaluate((more) => {
      const t = document.querySelector('[data-testid="text-editor"]') as HTMLTextAreaElement;
      t.setSelectionRange(t.value.length, t.value.length);
      const dt = new DataTransfer();
      dt.setData('text/plain', 'z'.repeat(more));
      t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, 500);
    await a.page.waitForTimeout(1500);
    const r = await a.page.evaluate((id) => {
      const ed = (window as unknown as W).__canvas.editor;
      return { status: ed.status, closes: (window as unknown as W).__wsCloses as number[], len: ed.doc.get(id).text.length };
    }, id);
    // before (10 001 and 12 000): closes [4403], status "closed", every later edit lost
    expect(r.closes).toEqual([]);
    expect(r.status).toBe('synced');
    expect(r.len).toBe(10_000);
    // a later edit still reaches the server
    await a.page.evaluate(() => (window as unknown as W).__canvas.editor.doc.create({ type: 'geo', geo: 'rectangle', x: 600, y: 200, w: 50, h: 50 }));
    allowUser(stack.core, key, 'bob', 'u-bob', 'Bob');
    const b = await openAs(stack, browser, 'bob', key);
    await waitFor(async () => (await b.page.evaluate(() => (window as unknown as W).__canvas.editor.doc.all().length)) === 2, 10_000, 'both shapes in the room');
    expect(await b.page.evaluate((id) => (window as unknown as W).__canvas.editor.doc.get(id).text.length, id)).toBe(10_000);
    await a.close();
    await b.close();
  });
}

test('M-7: one anonymous awareness message with 72 000 states: the viewer gets one cursor at most and stays responsive', async ({ browser }) => {
  const key = 'pub/fv5-aw/index.html';
  allowAnonKey(stack.core, key);
  const v = await openAs(stack, browser, null, key);
  const ws = await rawConnect(stack, key, null);
  const state = JSON.stringify({ cursor: { x: 100, y: 100 } });
  const entries: Uint8Array[] = [];
  let size = 8;
  for (let k = 0; ; k++) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 2_000_000 + k);
    encoding.writeVarUint(e, 1);
    encoding.writeVarString(e, state);
    const b = encoding.toUint8Array(e);
    if (size + b.byteLength > 2 * 1024 * 1024 - 64) break;
    entries.push(b);
    size += b.byteLength;
  }
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const b of entries) encoding.writeUint8Array(inner, b);
  const m = encoding.createEncoder();
  encoding.writeVarUint(m, 1);
  encoding.writeVarUint8Array(m, encoding.toUint8Array(inner));
  const gap = v.page.evaluate(
    (ms) =>
      new Promise<number>((res) => {
        let last = performance.now();
        let g = 0;
        const iv = setInterval(() => {
          const n = performance.now();
          g = Math.max(g, n - last);
          last = n;
        }, 50);
        setTimeout(() => {
          clearInterval(iv);
          res(Math.round(g));
        }, ms);
      }),
    4000,
  );
  ws.send(encoding.toUint8Array(m));
  const maxGap = await gap;
  const states = await v.page.evaluate(() => (window as unknown as W).__canvas.editor.conn.awareness.getStates().size);
  const cursors = await v.page.locator('[data-testid="remote-cursor"]').count();
  // before: 72 314 states reached the viewer, peers() took 138 ms per call
  expect(states).toBeLessThanOrEqual(2);
  expect(cursors).toBeLessThanOrEqual(1);
  expect(maxGap).toBeLessThan(500);
  ws.close();
  await v.close();
});
