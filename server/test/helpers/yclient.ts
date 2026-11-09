import WebSocket from 'ws';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { Identity } from '../../src/types.js';

/**
 * Minimal y-websocket client for tests: speaks the stock wire protocol (varUint type +
 * payload) exactly like the browser client, plus captures of the canvas-specific
 * messages (IDENTITY 100, NOTICE 101) and the close code.
 */
export class TestClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  ws!: WebSocket;
  identities: Identity[] = [];
  notices: { kind: string; message?: string }[] = [];
  /** message types in arrival order, for the "IDENTITY first" assertion */
  messageTypes: number[] = [];
  closeCode: number | null = null;
  closed: Promise<number>;
  private closedResolve!: (code: number) => void;
  private lastIdentity: Identity | null = null;

  constructor(
    private readonly url: string,
    private readonly cookie?: string,
  ) {
    this.closed = new Promise((resolve) => (this.closedResolve = resolve));
  }

  get identity(): Identity | null {
    return this.lastIdentity;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        maxPayload: 16 * 1024 * 1024,
        ...(this.cookie ? { headers: { cookie: this.cookie } } : {}),
      });
      this.ws = ws;
      ws.on('open', () => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        syncProtocol.writeSyncStep1(e, this.doc);
        ws.send(encoding.toUint8Array(e));
        resolve();
      });
      ws.on('error', reject);
      ws.on('close', (code) => this.closedResolve(code));
      ws.on('message', (data: ArrayBuffer) => this.onMessage(new Uint8Array(data)));

      this.doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === 'server' || !this.open) return;
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        syncProtocol.writeUpdate(e, update);
        ws.send(encoding.toUint8Array(e));
      });
      this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        if (!this.open) return;
        const changed = [...added, ...updated, ...removed];
        if (!changed.length) return;
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        ws.send(encoding.toUint8Array(e));
      });
    });
  }

  private get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private onMessage(buf: Uint8Array): void {
    const dec = decoding.createDecoder(buf);
    const type = decoding.readVarUint(dec);
    this.messageTypes.push(type);
    if (type === 0) {
      const syncType = decoding.readVarUint(dec);
      if (syncType === syncProtocol.messageYjsSyncStep2) {
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(dec), 'server');
      } else if (syncType === syncProtocol.messageYjsUpdate) {
        Y.applyUpdate(this.doc, decoding.readVarUint8Array(dec), 'server');
      }
      return;
    }
    if (type === 1) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), 'server');
      return;
    }
    if (type === 100) {
      const id = JSON.parse(decoding.readVarString(dec)) as Identity;
      this.identities.push(id);
      this.lastIdentity = id;
      return;
    }
    if (type === 101) {
      this.notices.push(JSON.parse(decoding.readVarString(dec)));
      return;
    }
  }

  /** Send raw bytes (for forged/malformed messages). */
  sendRaw(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  setAwareness(state: Record<string, unknown>): void {
    this.awareness.setLocalState(state);
  }

  close(): void {
    if (this.open) this.ws.close();
  }
}

/** Resolve when `pred()` holds or reject after `ms`. */
export function waitFor(pred: () => boolean, ms = 3000, what = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const started = Date.now();
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(t);
        reject(new Error('waitFor timed out: ' + what));
      }
    }, 10);
  });
}

/** Wait until a client's connection closes with the given code. */
export async function expectClose(client: TestClient, code: number, ms = 5000): Promise<void> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`expected close ${code}, still open after ${ms}ms`)), ms),
  );
  const got = await Promise.race([client.closed, timer]);
  if (got !== code) throw new Error(`expected close code ${code}, got ${got}`);
}
