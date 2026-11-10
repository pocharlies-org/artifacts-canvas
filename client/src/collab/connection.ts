import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
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

  constructor(readonly doc: Y.Doc, opts: ConnectionOptions, ledger: Y.Doc = new Y.Doc()) {
    if (ledger === doc) throw new Error('Connection: the ledger must be a separate Y.Doc');
    this.ledger = ledger;
    this.provider = new WebsocketProvider(opts.wsUrl, opts.room, doc, {
      params: opts.params,
      // One identity per tab: never share updates through BroadcastChannel.
      disableBc: true,
      maxBackoffTime: 5000,
    });
    this.awareness = this.provider.awareness;

    this.provider.messageHandlers[MSG_IDENTITY] = (_enc: encoding.Encoder, dec: decoding.Decoder) => {
      const id = parseIdentity(decoding.readVarString(dec));
      if (!id) return;
      this.setIdentity(id);
    };
    this.provider.messageHandlers[MSG_LEDGER] = (_enc: encoding.Encoder, dec: decoding.Decoder) => {
      try {
        Y.applyUpdate(this.ledger, decoding.readVarUint8Array(dec), LEDGER_ORIGIN);
      } catch {
        /* ignore a malformed ledger message (the content is unaffected) */
      }
    };
    this.provider.messageHandlers[MSG_NOTICE] = (_enc: encoding.Encoder, dec: decoding.Decoder) => {
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
