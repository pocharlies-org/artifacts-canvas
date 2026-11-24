import { describe, expect, it } from 'vitest';
import { MAX_LINK_LENGTH, canvasUrl, classifyLink, linkContext } from '../src/artifact/links';
import { downloadUrl, isDownloadKey } from '../src/artifact/links';

const ORIGIN = 'https://artifacts.example.com';
// the core's link shape: /_canvas/<bucket>/<key>
const ctx = linkContext(ORIGIN, '/_canvas/artifacts/u/run-1/report.html', '/_canvas/', 'u/run-1/report.html');
// the client's shape (and development): /_canvas/<key>
const plain = linkContext('http://127.0.0.1:5180', '/_canvas/sample-report.html', '/_canvas/', 'sample-report.html');

describe('link context', () => {
  it('finds the canvas base and the plain artifact base from the wrapper URL', () => {
    expect(ctx).toEqual({ origin: ORIGIN, prefix: '/_canvas/', canvasBase: '/_canvas/artifacts/', artifactBase: '/artifacts/' });
    expect(plain).toEqual({ origin: 'http://127.0.0.1:5180', prefix: '/_canvas/', canvasBase: '/_canvas/', artifactBase: null });
  });

  it('copes with encoded paths and with a path that does not end with the key', () => {
    const enc = linkContext(ORIGIN, '/_canvas/artifacts/u/r/caf%C3%A9%20menu.html', '/_canvas/', 'u/r/café menu.html');
    expect(enc.canvasBase).toBe('/_canvas/artifacts/');
    expect(linkContext(ORIGIN, '/_canvas/other.html', '/_canvas/', 'u/r/a.html').canvasBase).toBe('/_canvas/');
    expect(linkContext(ORIGIN, '/_canvas/%E0%A4%A', '/_canvas/', 'x').canvasBase).toBe('/_canvas/');
    // never the reserved segment
    expect(linkContext(ORIGIN, '/_canvas/_/frame/u/r/a.html', '/_canvas/', 'u/r/a.html').canvasBase).toBe('/_canvas/');
  });
});

describe('link classification', () => {
  it('a relative link of the artifact (resolved to the frame route) opens that file in the canvas', () => {
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/details.html`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1/details.html' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/sub/page%20two.html?x=1#s`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1/sub/page two.html' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/other-run/index.html`, ctx)).toEqual({ kind: 'canvas', key: 'u/other-run/index.html' });
  });

  it('absolute links to the plain artifact URL or to a canvas URL of this host stay in the canvas', () => {
    expect(classifyLink(`${ORIGIN}/artifacts/u/run-1/a.html`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1/a.html' });
    expect(classifyLink(`${ORIGIN}/_canvas/artifacts/g/team/b.html`, ctx)).toEqual({ kind: 'canvas', key: 'g/team/b.html' });
    expect(classifyLink(`${ORIGIN}/_canvas/pub/x/c.html`, ctx)).toEqual({ kind: 'canvas', key: 'pub/x/c.html' });
    // without a known bucket segment the plain URL of this host opens in a new tab
    expect(classifyLink('http://127.0.0.1:5180/artifacts/u/r/a.html', plain)).toEqual({ kind: 'external', url: 'http://127.0.0.1:5180/artifacts/u/r/a.html' });
  });

  it('traversal never leaves the artifact keys', () => {
    // the URL parser resolves dot segments, encoded or not; what is left is sanitised
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/../../../etc/passwd`, ctx)).toEqual({ kind: 'blocked', reason: 'reserved' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/../../../../../etc/passwd`, ctx)).toEqual({ kind: 'external', url: `${ORIGIN}/etc/passwd` });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/%2e%2e/x.html`, ctx)).toEqual({ kind: 'canvas', key: 'x.html' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/a%2F..%2F..%2Fb.html`, ctx)).toEqual({ kind: 'canvas', key: 'u/a/b.html' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/`, ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
  });

  it("the canvas's own routes other than the frame open nothing", () => {
    expect(classifyLink(`${ORIGIN}/_canvas/_/ws/u/run-1/report.html`, ctx)).toEqual({ kind: 'blocked', reason: 'reserved' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/assets/index.js`, ctx)).toEqual({ kind: 'blocked', reason: 'reserved' });
    expect(classifyLink(`${ORIGIN}/_canvas/_`, ctx)).toEqual({ kind: 'blocked', reason: 'reserved' });
  });

  it('other http(s) pages open in a new tab', () => {
    expect(classifyLink('https://example.org/docs?q=1#top', ctx)).toEqual({ kind: 'external', url: 'https://example.org/docs?q=1#top' });
    expect(classifyLink('http://example.org/', ctx)).toEqual({ kind: 'external', url: 'http://example.org/' });
    // same host but not an artifact (the core's own pages): a new tab, as from the plain artifact
    expect(classifyLink(`${ORIGIN}/oauth2-artifacts/sign_in`, ctx)).toEqual({ kind: 'external', url: `${ORIGIN}/oauth2-artifacts/sign_in` });
    // another port is another origin
    expect(classifyLink('https://artifacts.example.com:8443/_canvas/_/frame/u/x.html', ctx)).toEqual({ kind: 'external', url: 'https://artifacts.example.com:8443/_canvas/_/frame/u/x.html' });
  });

  it('only http and https: javascript:, data:, blob:, file:, mailto: and the like are blocked', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/png;base64,AAAA',
      `blob:${ORIGIN}/0b0a6b1e-1111-2222-3333-444455556666`,
      'file:///etc/passwd',
      'mailto:a@example.com',
      'tel:+34900000000',
      'ftp://example.org/x',
      'ws://example.org/',
      'chrome://settings',
      'about:blank',
    ]) {
      expect(classifyLink(href, ctx).kind, href).toBe('blocked');
    }
    expect(classifyLink('javascript:alert(1)', ctx)).toEqual({ kind: 'blocked', reason: 'scheme' });
  });

  it('refuses credentials in the URL, unparsable, empty, non-string and over-long input', () => {
    expect(classifyLink('https://user:pass@example.org/', ctx)).toEqual({ kind: 'blocked', reason: 'credentials' });
    expect(classifyLink(`${ORIGIN.replace('https://', 'https://u@')}/_canvas/_/frame/u/x.html`, ctx)).toEqual({ kind: 'blocked', reason: 'credentials' });
    expect(classifyLink('not a url', ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
    expect(classifyLink('/relative/only', ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
    expect(classifyLink('', ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
    expect(classifyLink(42, ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
    expect(classifyLink(null, ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
    expect(classifyLink(`https://example.org/${'a'.repeat(MAX_LINK_LENGTH)}`, ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/%E0%A4%A.html`, ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
  });
});

describe('canvas URL of a link', () => {
  it('keeps the bucket segment and lang, adds present=1 while presenting', () => {
    const q = new URLSearchParams('lang=en&present=1&artifact=evil&room=r1&as=Ana');
    expect(canvasUrl('u/run-1/details.html', ctx, q, { presenting: false, dev: false })).toBe('/_canvas/artifacts/u/run-1/details.html?lang=en');
    expect(canvasUrl('u/run-1/details.html', ctx, q, { presenting: true, dev: false })).toBe('/_canvas/artifacts/u/run-1/details.html?lang=en&present=1');
    expect(canvasUrl('u/run-1/page two.html', ctx, new URLSearchParams(), { presenting: false, dev: false })).toBe('/_canvas/artifacts/u/run-1/page%20two.html');
  });

  it('a forced canvas visibility stays forced on the next page', () => {
    expect(canvasUrl('u/x.html', ctx, new URLSearchParams('canvas=0'), { presenting: false, dev: false })).toBe('/_canvas/artifacts/u/x.html?canvas=0');
  });

  it('development keeps the dev identity and room, never ?artifact=', () => {
    const q = new URLSearchParams('as=Ana&room=r1&artifact=x.html&pageWidth=500&csp=prod');
    expect(canvasUrl('links-b.html', plain, q, { presenting: true, dev: true })).toBe('/_canvas/links-b.html?as=Ana&room=r1&csp=prod&present=1');
  });

  it('the key is sanitised again', () => {
    expect(canvasUrl('../../x/./y.html', ctx, new URLSearchParams(), { presenting: false, dev: false })).toBe('/_canvas/artifacts/x/y.html');
  });
});

describe('download links: a non-HTML file of the artifact is saved and the page stays', () => {
  it('a file of the artifact downloads under its key, whichever of the three URL shapes it came by', () => {
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/x.zip`, ctx)).toEqual({ kind: 'download', key: 'u/run-1/x.zip' });
    expect(classifyLink(`${ORIGIN}/artifacts/u/run-1/x.zip`, ctx)).toEqual({ kind: 'download', key: 'u/run-1/x.zip' });
    expect(classifyLink(`${ORIGIN}/_canvas/artifacts/u/run-1/data.csv`, ctx)).toEqual({ kind: 'download', key: 'u/run-1/data.csv' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/archive.tar.gz`, ctx)).toEqual({ kind: 'download', key: 'u/run-1/archive.tar.gz' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/pic.PNG`, ctx)).toEqual({ kind: 'download', key: 'u/run-1/pic.PNG' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/x.zip?v=1#a`, ctx)).toEqual({ kind: 'download', key: 'u/run-1/x.zip' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/page%20two.pdf`, ctx)).toEqual({ kind: 'download', key: 'u/run-1/page two.pdf' });
  });

  it('traversal stays under the artifact base, encoded or not', () => {
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/%2e%2e/x.zip`, ctx)).toEqual({ kind: 'download', key: 'x.zip' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/a%2F..%2F..%2Fb.zip`, ctx)).toEqual({ kind: 'download', key: 'u/a/b.zip' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/../x.zip`, ctx)).toEqual({ kind: 'download', key: 'u/x.zip' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/../../../x.zip`, ctx)).toEqual({ kind: 'blocked', reason: 'reserved' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/../../../../../etc/x.zip`, ctx)).toEqual({ kind: 'external', url: `${ORIGIN}/etc/x.zip` });
  });

  it('pages and other keys stay canvas pages: .html, .htm, no extension, a path ending in /, dot files', () => {
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/Report.HTML`, ctx)).toEqual({ kind: 'canvas', key: 'Report.HTML' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/page.htm`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1/page.htm' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/README`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1/README' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/x.zip/`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1/x.zip' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/.hidden`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1/.hidden' });
    expect(classifyLink(`${ORIGIN}/_canvas/_/frame/u/run-1/x.`, ctx)).toEqual({ kind: 'canvas', key: 'u/run-1/x.' });
  });

  it('the other branches keep their result: another bucket, and the plain context without an artifact base', () => {
    expect(classifyLink(`${ORIGIN}/_canvas/pub/x/y.zip`, ctx)).toEqual({ kind: 'canvas', key: 'pub/x/y.zip' });
    expect(classifyLink('http://127.0.0.1:5180/_canvas/_/frame/x.zip', plain)).toEqual({ kind: 'canvas', key: 'x.zip' });
    expect(classifyLink('http://127.0.0.1:5180/_canvas/x.zip', plain)).toEqual({ kind: 'canvas', key: 'x.zip' });
  });

  it('external and blocked links do not change: the gate and sign-in routes, other hosts, data:, blob:, credentials', () => {
    expect(classifyLink(`${ORIGIN}/_gate/x.zip`, ctx)).toEqual({ kind: 'external', url: `${ORIGIN}/_gate/x.zip` });
    expect(classifyLink(`${ORIGIN}/oauth2-artifacts/x.zip`, ctx)).toEqual({ kind: 'external', url: `${ORIGIN}/oauth2-artifacts/x.zip` });
    expect(classifyLink('https://evil.example.com/x.zip', ctx)).toEqual({ kind: 'external', url: 'https://evil.example.com/x.zip' });
    expect(classifyLink('https://artifacts.example.com.evil.example/x.zip', ctx)).toEqual({ kind: 'external', url: 'https://artifacts.example.com.evil.example/x.zip' });
    expect(classifyLink('data:application/zip;base64,UEs=', ctx)).toEqual({ kind: 'blocked', reason: 'scheme' });
    expect(classifyLink(`blob:${ORIGIN}/x.zip`, ctx)).toEqual({ kind: 'blocked', reason: 'scheme' });
    expect(classifyLink(`https://user:pass@artifacts.example.com/artifacts/u/run-1/x.zip`, ctx)).toEqual({ kind: 'blocked', reason: 'credentials' });
    expect(classifyLink('//evil.example.com/x.zip', ctx)).toEqual({ kind: 'blocked', reason: 'invalid' });
  });

  it('downloadUrl: the artifact base and the encoded, sanitised key, no query and no fragment; none without a base', () => {
    expect(downloadUrl('u/run-1/x.zip', ctx)).toBe('/artifacts/u/run-1/x.zip');
    expect(downloadUrl('u/run-1/my file é.zip', ctx)).toBe('/artifacts/u/run-1/my%20file%20%C3%A9.zip');
    expect(downloadUrl('u/x.zip?v=1#a', ctx)).toBe('/artifacts/u/x.zip%3Fv%3D1%23a');
    expect(downloadUrl('../../u/./x.zip', ctx)).toBe('/artifacts/u/x.zip');
    expect(downloadUrl('u/run-1/x.zip', plain)).toBeNull();
  });

  it('isDownloadKey: one definition, case-insensitive, only the last segment counts', () => {
    expect(isDownloadKey('x.zip')).toBe(true);
    expect(isDownloadKey('u/run-1/archive.tar.gz')).toBe(true);
    expect(isDownloadKey('u/run-1/pic.PNG')).toBe(true);
    expect(isDownloadKey('a.html')).toBe(false);
    expect(isDownloadKey('a.HTM')).toBe(false);
    expect(isDownloadKey('a.Html')).toBe(false);
    expect(isDownloadKey('README')).toBe(false);
    expect(isDownloadKey('u/run-1/')).toBe(false);
    expect(isDownloadKey('.zip')).toBe(false);
    expect(isDownloadKey('x.')).toBe(false);
    expect(isDownloadKey('v1.2/README')).toBe(false);
  });
});
