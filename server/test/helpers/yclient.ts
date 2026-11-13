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
 * messages (IDENTITY 100, NOTICE 101, LEDGER 102 into `ledger`) and the close code.
 */
/** Origin every test client sends unless told otherwise (tests set ALLOWED_ORIGINS to it). */
export const TEST_ORIGIN = 'http://canvas.test';

export class TestClient {
  /** the room's content document (shapes, assets, meta) */
  readonly doc = new Y.Doc();
  /** the room's ledger document (attribution, users, history, writers), from MSG_LEDGER */
  readonly ledger = new Y.Doc();
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

  /** Set-Cookie of the 101 response (anonymous pseudonym cookie). */
  setCookie: string | null = null;
  /** answer the server's sync step 1 with a step 2, like the stock y-websocket client */
  answerStep1 = true;
  /** sync step 1 messages received from the server (the join's, plus any resync request) */
  step1Received = 0;

  constructor(
    private readonly url: string,
    private readonly cookie?: string,
    /** Origin header; null = send none. */
    private readonly origin: string | null = TEST_ORIGIN,
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
        headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.origin !== null ? { origin: this.origin } : {}) },
      });
      this.ws = ws;
      ws.on('upgrade', (res) => {
        const sc = res.headers['set-cookie'];
        this.setCookie = sc ? sc.join('\n') : null;
      });
      ws.on('open', () => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        syncProtocol.writeSyncStep1(e, this.doc);
        ws.send(encoding.toUint8Array(e));
        // resolve once the join is complete — the server's sync step 1 comes after the identity,
        // the ledger and the content (fv9: the frames come from the room's worker, so the content
        // can arrive a while after the identity) — or the server closed, so callers can assert on
        // `identity` and on the room's documents right away
        waitFor(() => this.step1Received > 0 || ws.readyState !== WebSocket.OPEN, 15_000).then(resolve, () => resolve());
      });
      ws.on('error', reject);
      ws.on('close', (code) => {
        this.closeCode = code;
        this.closedResolve(code);
      });
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
      } else if (syncType === syncProtocol.messageYjsSyncStep1 && (this.step1Received++, this.answerStep1)) {
        // what y-websocket does: answer the server's state vector with what it lacks
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        syncProtocol.writeSyncStep2(e, this.doc, decoding.readVarUint8Array(dec));
        this.ws.send(encoding.toUint8Array(e));
      }
      return;
    }
    if (type === 102) {
      Y.applyUpdate(this.ledger, decoding.readVarUint8Array(dec), 'server');
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
export function waitFor(pred: () => boolean | Promise<boolean>, ms = 3000, what = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let busy = false;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        if (await pred()) {
          clearInterval(t);
          resolve();
        } else if (Date.now() - started > ms) {
          clearInterval(t);
          reject(new Error('waitFor timed out: ' + what));
        }
      } catch (err) {
        clearInterval(t);
        reject(err);
      } finally {
        busy = false;
      }
    };
    const t = setInterval(() => void check(), 10);
    void check();
  });
}

/**
 * The room's two documents as its worker holds them now (fv9: they live in the room's worker
 * thread; this decodes the worker's encoding of them), or undefined when the room is not loaded.
 */
export async function roomDocs(app: { manager: { get(key: string): { inspect(): Promise<{ doc: Y.Doc; ledger: Y.Doc }> } | undefined } }, key: string): Promise<{ doc: Y.Doc; ledger: Y.Doc } | undefined> {
  const r = app.manager.get(key);
  if (!r) return undefined;
  try {
    return await r.inspect();
  } catch {
    return undefined;
  }
}

/** Wait until a client's connection closes with the given code. */
export async function expectClose(client: TestClient, code: number, ms = 5000): Promise<void> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`expected close ${code}, still open after ${ms}ms`)), ms),
  );
  const got = await Promise.race([client.closed, timer]);
  if (got !== code) throw new Error(`expected close code ${code}, got ${got}`);
}

/**
 * The room's documents: as its worker holds them while it is loaded, else as stored (fv9: an
 * evicted room has no documents in this process any more; its last leave saved them).
 */
export async function roomOrStored(
  app: { manager: { get(key: string): { inspect(): Promise<{ doc: Y.Doc; ledger: Y.Doc }> } | undefined } },
  store: { objects: Map<string, { body: Uint8Array }> },
  key: string,
  prefix = '_plugins/canvas',
): Promise<{ doc: Y.Doc; ledger: Y.Doc }> {
  const live = await roomDocs(app, key);
  if (live) return live;
  const doc = new Y.Doc();
  const ledger = new Y.Doc();
  const c = store.objects.get(`${prefix}/${key}.ydoc`)?.body;
  const l = store.objects.get(`${prefix}/${key}.ydoc.ledger`)?.body;
  if (c) Y.applyUpdate(doc, c);
  if (l) Y.applyUpdate(ledger, l);
  return { doc, ledger };
}
