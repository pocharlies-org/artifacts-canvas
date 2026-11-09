import { expect, test } from '@playwright/test';
import { newRoom } from './helpers';

test('the artifact iframe is sandboxed with an opaque origin and cannot reach the wrapper', async ({ page }) => {
  await page.goto('/_canvas/sample-report.html'); // establish the origin for the cookie/storage below
  await page.evaluate(() => {
    document.cookie = 'canvas_session=secret-value; path=/';
    localStorage.setItem('canvas-secret', 'secret-value');
    sessionStorage.setItem('canvas-secret', 'secret-value');
  });
  const probe = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('PROBE '), timeout: 15000 });
  await page.addInitScript(() => {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.probe) console.log('PROBE ' + JSON.stringify({ origin: e.origin, probe: e.data.probe }));
    });
  });
  await page.goto(`/_canvas/isolation-probe.html?room=${newRoom('iso')}`);
  const msg = JSON.parse((await probe).text().slice(6));

  // the frame element itself
  const sandbox = await page.locator('iframe.artifact-frame').getAttribute('sandbox');
  expect(sandbox).toBe('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  // the wrapper cannot script into the frame either (opaque origin)
  expect(await page.evaluate(() => (document.querySelector('iframe.artifact-frame') as HTMLIFrameElement).contentDocument)).toBeNull();
  // the frame response carries the CSP sandbox header too
  const res = await page.request.get('/_canvas/_/frame/isolation-probe.html');
  expect(res.headers()['content-security-policy']).toBe('sandbox allow-scripts');

  const p = msg.probe;
  expect(msg.origin).toBe('null');
  expect(p.origin.value).toBe('null');
  for (const k of ['cookie', 'localStorage', 'sessionStorage', 'parentDocument', 'parentLocalStorage', 'parentCanvas', 'topLocation']) {
    expect(p[k].ok, `${k} must fail: ${JSON.stringify(p[k])}`).toBe(false);
    expect(p[k].error).toBe('SecurityError');
  }
  // a same-host fetch is cross-origin from an opaque origin: blocked by CORS, nothing readable
  expect(p.sameHostFetch.ok).toBe(false);
  expect(p.indexedDB.ok).toBe(false);
  expect(JSON.stringify(p)).not.toContain('secret-value');
});
