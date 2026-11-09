import * as Y from 'yjs';
import './ui/styles.css';
import { resolveConfig } from './config';
import { setLang } from './i18n';
import { Connection, anonPseudonym } from './collab/connection';
import { Editor } from './editor/editor';
import { buildChrome } from './ui/chrome';
import { personColor } from './model/colors';
import type { Identity } from './model/types';

const cfg = resolveConfig(location, document, import.meta.env.DEV);
setLang(cfg.lang);

const ydoc = new Y.Doc();
const anon = anonPseudonym(safeStorage());
const params: Record<string, string> = { anon };
if (cfg.dev && cfg.devUser) params.devUser = cfg.devUser;

// Development without a stamping server (e.g. a plain y-websocket relay): a local identity.
const devIdentity: Identity | null = cfg.dev
  ? cfg.devUser
    ? { id: `dev:${cfg.devUser}`, name: cfg.devUser, anonymous: false, color: personColor(`dev:${cfg.devUser}`, false), attribution: 'client' }
    : { id: `anon:${anon}`, name: `Anónimo ${anon}`, anonymous: true, attribution: 'client' }
  : null;

const conn = new Connection(ydoc, { wsUrl: cfg.wsUrl, room: cfg.room, params, devIdentity });
const app = document.getElementById('app')!;
const editor = new Editor(cfg, app, ydoc, conn);
buildChrome(editor, app);

// Handle for tests and debugging; it has the same powers as the page itself.
(window as unknown as { __canvas: unknown }).__canvas = { editor, ydoc, conn, Y };

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
