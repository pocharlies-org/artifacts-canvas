/*
 * Vite plugin: the development stack of the canvas client.
 *   GET  /                                   -> redirect to the sample artifact
 *   GET  /_canvas/<path>                     -> the wrapper page (index.html)
 *   GET  /_canvas/_/frame/<path>             -> dev/artifacts/<path> with reporter.js injected,
 *                                               served with "Content-Security-Policy: sandbox allow-scripts"
 *   GET  /_canvas/_/vendor/html-to-image.js
 *   WS   /_canvas/_/ws/<path>                -> reference y-websocket room (dev/yroom.ts)
 * In `vite build` it emits vendor/html-to-image.js next to the bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { WebSocketServer } from 'ws';
import { devIdentity, getRoom } from './yroom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ARTIFACTS = path.join(here, 'artifacts');
const H2I = path.join(root, 'node_modules/html-to-image/dist/html-to-image.js');
const REPORTER = path.join(root, 'public/reporter.js');

/** Insert the reporter as the first script of the document (the production server does the same). */
export function injectReporter(html: string, reporter: string): string {
  const tag = `<script>${reporter.replace(/<\/script/gi, '<\\/script')}</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) return html.replace(m[0], m[0] + tag);
  const d = html.match(/<!doctype[^>]*>/i);
  if (d) return html.replace(d[0], d[0] + tag);
  return tag + html;
}

function safeJoin(base: string, rel: string): string | null {
  const clean = rel.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  const p = path.resolve(base, clean);
  return p.startsWith(base + path.sep) ? p : null;
}

export function canvasDev(): Plugin {
  return {
    name: 'artifacts-canvas-dev',
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/_canvas/_/ws/')) return;
        const room = decodeURIComponent(url.pathname.slice('/_canvas/_/ws/'.length));
        wss.handleUpgrade(req, socket, head, (ws) => {
          getRoom(room).join(ws, devIdentity(url.searchParams));
        });
      });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const p = decodeURIComponent(url.pathname);
        if (p === '/') {
          res.statusCode = 302;
          res.setHeader('Location', '/_canvas/sample-report.html');
          res.end();
          return;
        }
        if (p.startsWith('/_canvas/_/frame/')) {
          const file = safeJoin(ARTIFACTS, p.slice('/_canvas/_/frame/'.length));
          if (!file || !fs.existsSync(file)) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          const html = injectReporter(fs.readFileSync(file, 'utf8'), fs.readFileSync(REPORTER, 'utf8'));
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
          res.setHeader('Cache-Control', 'no-store');
          res.end(html);
          return;
        }
        if (p === '/_canvas/_/vendor/html-to-image.js') {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(fs.readFileSync(H2I));
          return;
        }
        if (p.startsWith('/_canvas/') && !p.startsWith('/_canvas/_/')) {
          const html = await server.transformIndexHtml(req.url ?? '/', fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(html);
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'vendor/html-to-image.js', source: fs.readFileSync(H2I) });
    },
  };
}
