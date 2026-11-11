import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import * as decoding from 'lib0/decoding';
import * as encodingRt from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { Awareness } from 'y-protocols/awareness';
import { MSG_IDENTITY, MSG_LEDGER, MSG_NOTICE, parseIdentity, type Notice } from './protocol';
import type { Identity } from '../model/types';
import { personColor } from '../model/colors';

export type Status = 'connecting' | 'connected' | 'synced' | 'disconnected' | 'closed';

export interface ConnectionOptions {
  wsUrl: string;
  room: string;
  /** Extra query params (anon pseudonym hint, dev user). */
  params: Record<string, string>;
  /** Allow a local identity when the server sends none (development only). */
  devIdentity: Identity | null;
  identityTimeoutMs?: number;
  /** WebSocket implementation (tests drive the provider over an in-memory socket). */
  WebSocketPolyfill?: typeof WebSocket;
}

/** Transaction origin of ledger updates received from the server. */
export const LEDGER_ORIGIN = 'artifacts-canvas:ledger';

/**
 * y-websocket connection (content document) plus the IDENTITY / NOTICE / LEDGER extensions
 * of docs/protocol.md. The ledger document is only ever applied FROM the server: nothing
 * observes it to send, so a local change to it (a dev-mode local stamper) never leaves the
 * tab, and the server would close a client that sent one anyway.
 */
export class Connection {
  readonly provider: WebsocketProvider;
  readonly ledger: Y.Doc;
  readonly awareness: Awareness;
  identity: Identity | null = null;
  status: Status = 'connecting';
  closeCode = 0;
  private identityListeners = new Set<(id: Identity) => void>();
  private noticeListeners = new Set<(n: Notice) => void>();
  private statusListeners = new Set<(s: Status) => void>();
  private devTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Local updates are held from the moment a socket opens until this tab has answered the
   * server's sync step 1 (fv5 M-2). The answer (a step 2 against the server's state vector)
   * carries every local change made until then — the offline edits AND a keystroke typed
   * while reconnecting — so the held updates are simply not sent. y-websocket alone sends a
   * local update as soon as the socket is open: one that depends on an offline struct reached
   * the server before the step-2 answer and was refused as pending.
   */
  private holding = true;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly doc: Y.Doc, opts: ConnectionOptions, ledger: Y.Doc = new Y.Doc()) {
    if (ledger === doc) throw new Error('Connection: the ledger must be a separate Y.Doc');
    this.ledger = ledger;
    this.provider = new WebsocketProvider(opts.wsUrl, opts.room, doc, {
      params: opts.params,
      // One identity per tab: never share updates through BroadcastChannel.
      disableBc: true,
      maxBackoffTime: 5000,
      ...(opts.WebSocketPolyfill ? { WebSocketPolyfill: opts.WebSocketPolyfill } : {}),
    });
    this.awareness = this.provider.awareness;
    this.holdLocalUpdates();

    this.provider.messageHandlers[MSG_IDENTITY] = (_enc: encodingRt.Encoder, dec: decoding.Decoder) => {
      const id = parseIdentity(decoding.readVarString(dec));
      if (!id) return;
      this.setIdentity(id);
    };
    this.provider.messageHandlers[MSG_LEDGER] = (_enc: encodingRt.Encoder, dec: decoding.Decoder) => {
      try {
        Y.applyUpdate(this.ledger, decoding.readVarUint8Array(dec), LEDGER_ORIGIN);
      } catch {
        /* ignore a malformed ledger message (the content is unaffected) */
      }
    };
    this.provider.messageHandlers[MSG_NOTICE] = (_enc: encodingRt.Encoder, dec: decoding.Decoder) => {
      try {
        const n = JSON.parse(decoding.readVarString(dec)) as Notice;
        if (n && typeof n.kind === 'string') for (const l of this.noticeListeners) l(n);
      } catch {
        /* ignore malformed notice */
      }
    };

    this.provider.on('status', (e: { status: string }) => {
      if (e.status === 'connected') this.setStatus('connected');
      else if (e.status === 'disconnected') this.setStatus(this.status === 'closed' ? 'closed' : 'disconnected');
      else this.setStatus('connecting');
    });
    this.provider.on('sync', (synced: boolean) => {
      if (synced) this.setStatus('synced');
    });
    this.provider.on('closed', (e: { code: number }) => {
      this.closeCode = e.code;
      this.setStatus('closed');
    });

    if (opts.devIdentity) {
      this.devTimer = setTimeout(() => {
        if (!this.identity && opts.devIdentity) this.setIdentity(opts.devIdentity);
      }, opts.identityTimeoutMs ?? 1500);
    }
  }

  /** See `holding`: wrap the provider's update sender and its sync handler. */
  private holdLocalUpdates() {
    const p = this.provider as WebsocketProvider & { _updateHandler: (u: Uint8Array, origin: unknown) => void };
    const send = p._updateHandler;
    this.doc.off('update', send);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === p) return; // received from the server
      if (this.holding) return; // covered by the step-2 answer still to come
      send(update, origin);
    });
    const sync = p.messageHandlers[0];
    p.messageHandlers[0] = (enc, dec, prov, emitSynced, mt) => {
      const kind = decoding.peekVarUint(dec);
      if (kind === syncProtocol.messageYjsSyncStep2 && this.holding) {
        // remember what the server has (for the fallback below)
        try {
          const d = decoding.clone(dec);
          decoding.readVarUint(d);
          this.serverSv = Y.encodeStateVectorFromUpdate(decoding.readVarUint8Array(d));
        } catch {
          this.serverSv = null;
        }
      }
      // the server's step 1: y-websocket writes the step-2 answer into `enc` and sends it right
      // after this handler returns — from then on, local updates go out as they happen
      sync(enc, dec, prov, emitSynced, mt);
      if (kind === syncProtocol.messageYjsSyncStep1) this.release(false);
    };
    p.on('status', (e: { status: string }) => {
      if (e.status !== 'connected') {
        this.holding = true;
        this.serverSv = null;
        this.clearHoldTimer();
      }
    });
    p.on('sync', (synced: boolean) => {
      // a server that sends no step 1 after its step 2 (not this one): stop holding after a
      // while and send what it lacks against the state it sent
      if (!synced || !this.holding) return;
      this.clearHoldTimer();
      this.holdTimer = setTimeout(() => this.release(true), 5000);
    });
  }

  private serverSv: Uint8Array | null = null;

  private clearHoldTimer() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private release(sendAll: boolean) {
    if (!this.holding) return;
    this.holding = false;
    this.clearHoldTimer();
    const ws = this.provider.ws;
    if (sendAll && ws && ws.readyState === ws.OPEN) {
      const e = encodingRt.createEncoder();
      encodingRt.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(this.doc, this.serverSv ?? undefined));
      ws.send(encodingRt.toUint8Array(e));
    }
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private setIdentity(id: Identity) {
    if (this.devTimer) clearTimeout(this.devTimer);
    const prev = this.identity;
    this.identity = { ...id, color: id.color || personColor(id.id, id.anonymous) };
    if (prev && prev.id === this.identity.id && prev.name === this.identity.name) return;
    for (const l of this.identityListeners) l(this.identity);
  }

  onIdentity(fn: (id: Identity) => void) {
    this.identityListeners.add(fn);
    if (this.identity) fn(this.identity);
  }

  onNotice(fn: (n: Notice) => void) {
    this.noticeListeners.add(fn);
  }

  onStatus(fn: (s: Status) => void) {
    this.statusListeners.add(fn);
    fn(this.status);
  }

  destroy() {
    if (this.devTimer) clearTimeout(this.devTimer);
    this.clearHoldTimer();
    this.provider.destroy();
  }
}

/** The pseudonym number of this browser for anonymous drawing ("Anónimo 4821"). */
export function anonPseudonym(storage: Storage | null): string {
  const key = 'artifacts-canvas:anon';
  try {
    const cur = storage?.getItem(key);
    if (cur && /^\d{4}$/.test(cur)) return cur;
    const fresh = String(1000 + Math.floor(Math.random() * 9000));
    storage?.setItem(key, fresh);
    return fresh;
  } catch {
    return String(1000 + Math.floor(Math.random() * 9000));
  }
}
