import * as Y from 'yjs';
import { CanvasDoc, newId } from '../model/doc';
import { MAX_TEXT_LENGTH } from '@pocharlies/artifacts-canvas-shared/model';
import { encodeImage, roomBytes, wouldOverfill } from './images';
import { attachStamper } from '../model/stamper';
import { DEFAULT_STYLE, STYLE_KEYS, type Identity, type Shape, type Style, type GeoKind } from '../model/types';
import { Connection, type Status } from '../collab/connection';
import { Throttle, sendIntervalMs } from '../collab/pacer';
import { audienceOf, hiddenPresence, peers, setPresence, type Audience, type LaserPoint, type PresenceState } from '../collab/presence';
import {
  INITIAL_FOLLOW, currentPresenter, followPresenter, followUser, onPeers, startPresenting, stopFollowing, stopPresenting,
  targetPeer, type FollowPeer, type FollowState,
} from '../collab/follow';
import type { Notice } from '../collab/protocol';
import { ArtifactFrame, type FrameReading, type FrameWheel } from '../artifact/frame';
import { nextSlide, screenStep, stepOf } from './slides';
import { canvasUrl, classifyLink, downloadUrl, linkContext, type LinkContext } from '../artifact/links';
import { DEFAULT_BOARD, isDark, opaque, toCss, type Rgba } from '../ui/theme';
import { Renderer } from '../render/renderer';
import {
  type Camera, type NativeScroll, clampZoom, fitBox, matchViewport, nativeScroll, nextZoomStep, screenToWorld, visibleWorld, worldToScreen, zoomAt,
} from './camera';
import { type Box, type Pt, unionBoxes } from '../geometry/vec';
import { shapeBounds, topShapeAt, FONT_SIZE, NOTE_FONT_SIZE, NOTE_SIZE } from '../geometry/shapes';
import { FONT_FAMILY, layoutText } from '../render/text';
import { DEFAULT_PREFIX, RESERVED, type CanvasConfig } from '../config';
import { TOOLS, nudgeSelection as TOOLS_NUDGE, type ToolId, type Tool, type PointerInfo } from '../tools/tools';
import { Overlay } from '../render/overlay';
import { t } from '../i18n';
import { own } from '../model/colors';

export type Topic = 'camera' | 'selection' | 'tool' | 'style' | 'presence' | 'doc' | 'status' | 'identity' | 'visibility' | 'follow' | 'present' | 'canvas' | 'theme' | 'history' | 'notice';

export interface EditorDom {
  stage: HTMLElement;
}

const LASER_TTL = 1000;
/** While the laser is held still, its point is sent again this often, so it does not fade for the others. */
const LASER_HOLD_MS = 300;
/** A follower publishes its viewport once its camera stood still this long (publishFollowedViewport). */
export const FOLLOW_SETTLE_MS = 500;
/** Presentation mode: the artifact page fills the screen width, up to this zoom. */
const PRESENT_MAX_ZOOM = 2;
/** Presentation mode: screen px above the page top, under the "Presentando" badge. */
const PRESENT_TOP = 48;
/** A presentation opened from a link still shows the page top while the line under the badge is above this (artifact px). */
const SLIDE_AT_TOP = 8;
/** A scroll of the stage (a page's scrollIntoView) is taken as a camera move once it has been still this long. */
const STAGE_SCROLL_SETTLE_MS = 200;
/** After the canvas is shown, the frame's reading position (where the hidden page was read) is taken this long. */
const READING_WINDOW_MS = 3000;
/** Under this view width the editor lays out for a phone (the side panels as drawers, the page below the top bars). */
const PHONE_W = 760;
/** Nobody follows this tab and it does not present: its own viewport goes out at most this often. */
export const VIEWPORT_IDLE_MS = 1000;
/** Native scroll: after this many requests the page did not follow, it is off for the document (it scrolls itself back). */
const SCROLL_REFUSALS = 3;
/**
 * Native scroll: a document may land a request up to this many artifact px from the line asked for
 * (it snaps the scroll to pixels of its own). That still follows the request, and the next move
 * starts from the line asked for, not from the snapped one, or every step would drift.
 */
const SCROLL_SNAP = 2;
/** Page keys: an arrow scrolls this many screen px; a page, this share of the view. */
const ARROW_SCROLL = 40;
const PAGE_SCROLL = 0.9;

/** The presenter seen by this tab: who, and whether it is this person in another tab or device. */
export interface PresenterInfo {
  name: string;
  userId: string;
  clientId: number;
  self: boolean;
}

export class Editor {
  readonly doc: CanvasDoc;
  readonly conn: Connection | null;
  readonly cfg: CanvasConfig;
  readonly stage: HTMLElement;
  readonly world: HTMLElement;
  readonly page: HTMLElement;
  readonly frame: ArtifactFrame;
  readonly renderer: Renderer;
  readonly overlay: Overlay;
  readonly textarea: HTMLTextAreaElement;

  camera: Camera = { tx: 0, ty: 0, z: 1 };
  viewW = 0;
  viewH = 0;
  pageWidth: number;
  pageHeight: number;
  tool: ToolId = 'select';
  geoKind: GeoKind = 'rectangle';
  style: Style = { ...DEFAULT_STYLE };
  selection = new Set<string>();
  me: Identity | null = null;
  status: Status = 'connecting';
  notice: Notice | null = null;
  annotationsVisible = true;
  editingId: string | null = null;
  hoverId: string | null = null;
  pointerWorld: Pt | null = null;
  spaceDown = false;
  /** Presenting and following (collab/follow.ts): what this tab presents or follows. */
  private fstate: FollowState = INITIAL_FOLLOW;
  /** The tool in use when presentation mode started; back when it ends. */
  private toolBeforePresenting: { tool: ToolId; geo: GeoKind } | null = null;
  /** The presence `status` last published (a laser cursor shows as one for the others). */
  private publishedStatus: string | null = null;
  /** Where a click on a link of the artifact leads (artifact/links.ts). */
  readonly links: LinkContext;
  /**
   * The canvas is hidden (ui/visibility.ts): the artifact shows as the plain page (full view,
   * its own scrolling, links work), no annotations, no chrome, and nothing of this tab's
   * pointer goes to the others. The connection stays, so the annotation count stays live.
   */
  hidden = false;
  private cameraBeforeHiding: Camera | null = null;
  /** The artifact's background, as the board shows it (opaque), and whether it is dark. */
  board: Rgba = DEFAULT_BOARD;
  dark = false;
  /** Local laser trail (published through awareness, never stored). */
  laser: LaserPoint[] = [];
  /** Receive time of each peer's laser state (for fading). */
  laserSeen = new Map<number, { at: number; now: number }>();
  private clipboard: { shapes: Shape[]; assets: Record<string, string> } | null = null;
  private listeners = new Map<Topic, Set<() => void>>();
  activeTool: Tool;
  /** Awareness goes out at the send rate, not once per animation frame (collab/pacer.ts). */
  private readonly presencePace = new Throttle(() => this.sendIntervalMs());
  private pendingPresence: Partial<PresenceState> = {};
  private laserAnim = 0;
  private stamperDetach: (() => void) | null = null;
  private initialCameraSet = false;
  private stageScrollTimer = 0;
  /** Until when the frame's reading position is taken (the canvas was just shown). */
  private readingUntil = 0;
  /**
   * Native scroll (docs/design.md §6.4): where the artifact's document is scrolled, as the reporter
   * last said (artifact px); the frame's window sits at that line of the page.
   */
  private scrollAt = 0;
  /** The scroll last asked for, until the reporter says it applied it (its `seq`); null: none pending. */
  private scrollWant: number | null = null;
  /**
   * The scroll last asked for, kept after the answer: the document snaps a scroll to its own pixels,
   * and the next move starts from the line asked for, not from the snapped one (a wheel would drift).
   */
  private scrollAsked: number | null = null;
  private scrollWantSeq = 0;
  private scrollSeq = 0;
  private scrollSource: 'user' | 'follow' | 'system' = 'system';
  /** Requests in a row the document did not follow; at SCROLL_REFUSALS native scroll is off for it. */
  private scrollRefusals = 0;
  private scrollRefused = false;
  /** The page box's corners, as last written (rounded only at the page's own top and end). */
  private pageCorners = '';
  /** Somebody follows this tab (a peer's `following` is this user): its viewport goes out at the send rate. */
  private followed = false;
  /** This tab's viewport, when nobody follows it and it does not present (VIEWPORT_IDLE_MS). */
  private readonly viewportPace = new Throttle(() => VIEWPORT_IDLE_MS);
  /** The awareness change being set is this tab's own viewport or cursor: nothing the chrome shows. */
  private quietPresence = false;

  constructor(cfg: CanvasConfig, root: HTMLElement, ydoc: Y.Doc, conn: Connection | null, ledger?: Y.Doc) {
    this.cfg = cfg;
    // content = ydoc (this tab writes it); ledger = attribution/users/history, from the server
    this.doc = new CanvasDoc(ydoc, ledger ?? conn?.ledger ?? new Y.Doc());
    this.conn = conn;
    this.pageWidth = cfg.pageWidth;
    this.pageHeight = 900;

    this.stage = el('div', 'stage');
    this.stage.setAttribute('data-testid', 'stage');
    // A page in the frame can scroll the canvas itself: scrollIntoView() also scrolls the frame's
    // ancestors, and the stage is a scroll container (overflow hidden). A deck's own navigation
    // (arrow keys, its slide links) did that: the picture moved under the camera, so the
    // presenter saw one part and the followers another, and a stroke landed off the pointer.
    this.stage.addEventListener('scroll', () => this.onStageScroll());
    this.world = el('div', 'world');
    this.page = el('div', 'page');
    this.page.style.width = `${this.pageWidth}px`;
    this.page.style.height = `${this.pageHeight}px`;
    this.world.appendChild(this.page);
    this.stage.appendChild(this.world);
    root.appendChild(this.stage);

    this.frame = new ArtifactFrame(this.page, cfg.frameUrl, this.pageWidth, this.pageHeight, cfg.vendorUrl, {
      size: (_w, h) => {
        this.pageHeight = h;
        if (!this.hidden && !this.frame.scroller) this.page.style.height = `${h}px`;
        this.emit('camera');
        // native scroll or transform: the page's height says which (and how far it scrolls)
        this.syncScroller();
      },
      scrolled: (y, seq) => this.onScrolled(y, seq),
      title: () => this.emit('status'),
      scroll: (x, y) => this.panTo({ x, y }),
      // The artifact's own scripts share the frame with the reporter and can post the same
      // messages, so each is taken only when the user is acting on the artifact (frameGesture)
      link: (href, newTab) => {
        if (this.frameGesture()) this.openLink(href, newTab);
      },
      anchor: (x, y) => {
        if (this.frameGesture()) this.revealTop({ x, y });
      },
      wheel: (w) => {
        if (this.tool === 'interact' && this.frame.hovered) this.wheelFromFrame(w);
      },
      escape: () => {
        if (this.tool === 'interact' && !this.hidden && this.focusInFrame()) this.escape();
      },
      // a step key the page left (it has no navigation of its own for it): as the same key on the canvas
      step: (dir, key) => {
        if (this.tool !== 'interact' || !this.focusInFrame() || !userActivated()) return;
        if (this.presenting) this.stepSlide(dir);
        else this.scrollKey(key, dir);
      },
      background: (c) => this.applyBackground(c),
      reading: (r) => this.onReading(r),
      reload: () => this.onFrameReload(),
    });
    const prefix = (() => {
      const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/_canvas/_/';
      return base.endsWith(RESERVED) ? base.slice(0, -RESERVED.length) : DEFAULT_PREFIX;
    })();
    this.links = linkContext(location.origin, location.pathname, prefix, cfg.artifactPath);

    this.renderer = new Renderer(this.world, this.doc);
    this.overlay = new Overlay(this);
    this.renderer.onRendered = () => {
      this.overlay.update();
      this.emit('doc');
    };

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'text-editor';
    this.textarea.setAttribute('data-testid', 'text-editor');
    this.textarea.spellcheck = false;
    this.textarea.style.display = 'none';
    this.stage.appendChild(this.textarea);
    this.textarea.addEventListener('input', () => this.onTextInput());
    // fv5 M-3: the server refuses a text longer than MAX_TEXT_LENGTH (and closes the
    // connection), so the editor never lets one through: maxLength on the textarea (typing),
    // a paste cut to what fits (with a toast), and onTextInput truncates whatever got in anyway.
    this.textarea.addEventListener('paste', (e) => this.onTextPaste(e));
    this.textarea.addEventListener('blur', () => this.stopEditing());
    this.textarea.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.textarea.blur();
      }
    });

    this.activeTool = TOOLS.select(this);

    this.doc.onChange((c) => {
      let selChanged = false;
      for (const id of c.shapes) if (!this.doc.has(id) && this.selection.delete(id)) selChanged = true;
      if (selChanged) this.emit('selection');
      if (c.history || c.attribution || c.users) this.emit('history');
      if (c.meta) this.applyPageWidth();
      if (c.shapes.size) this.emit('history');
    });

    if (conn) {
      conn.onStatus((s) => {
        this.status = s;
        // a notice that only meant "reconnecting" ends once the tab is synced again (a rate
        // limit too: the connection waits a moment and reconnects, see Connection)
        if (s === 'synced' && this.notice && (this.notice.kind === 'busy' || this.notice.kind === 'shutdown' || this.notice.kind === 'rate-limited')) {
          this.notice = null;
          this.emit('notice');
        }
        this.emit('status');
      });
      conn.onIdentity((id) => this.setIdentity(id));
      conn.onNotice((n) => {
        this.notice = n;
        this.emit('notice');
      });
      conn.awareness.on('change', (_c: unknown, origin: unknown) => this.onAwareness(origin));
      conn.provider.on('sync', (synced: boolean) => {
        if (synced) {
          this.doc.ensurePageWidth(cfg.pageWidth);
          this.applyPageWidth();
        }
      });
    }

    this.bindInput();
    const ro = new ResizeObserver(() => this.onResize());
    ro.observe(this.stage);
    this.onResize();
  }

  // ------------------------------------------------------------------ events

  on(topic: Topic, fn: () => void): () => void {
    let s = this.listeners.get(topic);
    if (!s) this.listeners.set(topic, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(topic: Topic) {
    for (const fn of this.listeners.get(topic) ?? []) fn();
    if (topic === 'camera' || topic === 'selection' || topic === 'tool') this.overlay?.update();
  }

  // ------------------------------------------------------------------ identity & presence

  private setIdentity(id: Identity) {
    this.me = id;
    if (this.stamperDetach) {
      this.stamperDetach();
      this.stamperDetach = null;
    }
    if (id.attribution === 'client') {
      // No stamping server (development relay): stamp my own transactions into a ledger
      // local to this tab (it is never sent: the ledger has no outgoing channel).
      const mine = { id: id.id, info: { name: id.name, anonymous: id.anonymous, color: id.color } };
      this.stamperDetach = attachStamper(this.doc.doc, this.doc.ledger, {
        userOf: (origin) => (origin === this.doc.origin || origin === this.doc.undoManager || origin === 'asset' ? mine : null),
      });
    }
    this.publishPresence({
      user: { id: id.id, name: id.name, color: id.color!, anonymous: id.anonymous },
      viewport: this.visibleWorld(),
      presenting: this.presenting,
    });
    // a peer may follow this user already (its presence came before this identity)
    this.updateFollowed();
    this.emit('identity');
    this.emit('presence');
  }

  get readOnly(): boolean {
    if (this.notice?.kind === 'readonly' || this.me?.readOnly) return true;
    if (!this.me) return true;
    return this.status === 'closed';
  }

  /** Milliseconds between two awareness messages (collab/pacer.ts; the connection paces content). */
  sendIntervalMs(): number {
    return sendIntervalMs(!!this.me?.anonymous);
  }

  publishPresence(patch: Partial<PresenceState>, immediate = false) {
    if (!this.conn) return;
    // a hidden canvas only views (collab/presence.ts hiddenPresence). Its state is set when the
    // canvas hides and then left alone (setPresence skips an unchanged patch): renewals only, every 15 s.
    if (this.hidden) patch = hiddenPresence(patch);
    if ('status' in patch) this.publishedStatus = patch.status ?? null;
    Object.assign(this.pendingPresence, patch);
    this.presencePace.schedule(() => this.flushPresence());
    if (immediate) this.presencePace.flush();
  }

  private flushPresence() {
    if (!this.conn || !this.me) {
      return;
    }
    // this tab's own viewport or cursor changes nothing the chrome shows (the avatars, who is
    // here): the awareness change it raises in this tab is not a presence change (onAwareness)
    this.quietPresence = Object.keys(this.pendingPresence).every((k) => k === 'viewport' || k === 'cursor');
    try {
      setPresence(this.conn.awareness, this.pendingPresence);
    } finally {
      this.quietPresence = false;
    }
    this.pendingPresence = {};
  }

  /**
   * This tab's viewport goes out to the room: at the send rate while it presents or somebody
   * follows it, else at most every VIEWPORT_IDLE_MS (the last one always goes): a pan or a scroll
   * no one follows is not a stream of awareness messages.
   */
  private publishViewport() {
    if (!this.conn) return;
    if (this.presenting || this.followed) {
      this.viewportPace.cancel();
      this.publishPresence({ viewport: this.visibleWorld() });
      return;
    }
    this.viewportPace.schedule(() => this.publishPresence({ viewport: this.visibleWorld() }));
  }

  /** Does a peer follow this user? Then this tab's viewport goes out at the send rate (publishViewport). */
  private updateFollowed() {
    if (!this.conn) return;
    const me = this.me?.id;
    const followed = !!me && peers(this.conn.awareness).some((p) => p.state.following === me);
    if (followed && !this.followed && this.viewportPace.pending) this.viewportPace.flush();
    this.followed = followed;
  }

  private onAwareness(origin?: unknown) {
    if (!this.conn) return;
    if (origin === 'local' && this.quietPresence) return;
    if (origin !== 'local') this.updateFollowed();
    const now = performance.now();
    for (const p of peers(this.conn.awareness)) {
      if (p.state.laser && p.state.laser.pts.length) this.laserSeen.set(p.clientId, { at: now, now: p.state.laser.now });
    }
    this.ensureLaserAnimation();
    this.setFollowState(onPeers(this.fstate, this.followPeers(), this.selfClientId()));
    if (this.fstate.target) this.applyFollow();
    this.overlay.updateCursors();
    this.emit('presence');
  }

  /** The awareness peers as the follow state machine sees them. */
  private followPeers(): FollowPeer[] {
    if (!this.conn) return [];
    return peers(this.conn.awareness).map((p) => ({ clientId: p.clientId, userId: p.state.user!.id, presenting: !!p.state.presenting }));
  }

  private selfClientId(): number {
    return this.conn?.awareness.clientID ?? -1;
  }

  private setFollowState(next: FollowState) {
    const prev = this.fstate;
    if (next === prev) return;
    this.fstate = next;
    const following = next.target?.userId ?? null;
    if (following !== (prev.target?.userId ?? null)) this.publishPresence({ following });
    if (next.target !== prev.target || next.dismissed !== prev.dismissed) this.emit('follow');
  }

  /** This tab presents (presentation mode). */
  get presenting(): boolean {
    return this.fstate.presenting;
  }

  /** The person this tab follows, or null. */
  get followingUserId(): string | null {
    return this.fstate.target?.userId ?? null;
  }

  /** Following because someone presents (not "Seguir a ..."). */
  get followingPresenter(): boolean {
    return this.fstate.target?.reason === 'presenter';
  }

  /** The presenter this tab sees (followed or not), or null. Never this tab. */
  presenter(): PresenterInfo | null {
    if (!this.conn) return null;
    const p = currentPresenter(this.followPeers(), this.selfClientId(), this.fstate);
    if (!p) return null;
    const st = peers(this.conn.awareness).find((x) => x.clientId === p.clientId)?.state;
    return { name: st?.user?.name ?? '', userId: p.userId, clientId: p.clientId, self: p.userId === this.me?.id };
  }

  follow(userId: string) {
    this.setFollowState(followUser(this.fstate, userId, this.followPeers(), this.selfClientId()));
    this.applyFollow();
  }

  /** Follow the presenter again after "Dejar de seguir". */
  followPresenter() {
    this.setFollowState(followPresenter(this.fstate, this.followPeers(), this.selfClientId()));
    this.applyFollow();
  }

  stopFollowing() {
    this.setFollowState(stopFollowing(this.fstate));
  }

  private applyFollow() {
    if (!this.conn || this.hidden) return;
    const target = targetPeer(this.fstate, this.followPeers(), this.selfClientId());
    if (!target) return;
    const vp = peers(this.conn.awareness).find((p) => p.clientId === target.clientId)?.state.viewport;
    if (!vp) return;
    const next = matchViewport(vp, this.viewW, this.viewH);
    // every awareness update of the room comes here (a laser, a cursor): the camera moves only when the viewport did
    if (next.tx === this.camera.tx && next.ty === this.camera.ty && clampZoom(next.z) === this.camera.z) return;
    this.setCamera(next, 'follow');
  }

  /**
   * Presentation mode on or off. On: this tab follows nobody, the others (this person's other
   * tabs too) follow it, the laser is the tool and the artifact fills the screen width, from the
   * line at the top of the view (*Presentar* keeps the reading position) or, with `fromTop`, from
   * the page top (a `?present=1` link: wherever the camera was, a presenter it followed included).
   * Off: the tool from before comes back, and the followers are released. Fullscreen is the UI's
   * part (ui/present.ts): it needs the click that started it.
   */
  setPresenting(on: boolean, fromTop = false) {
    if (on === this.fstate.presenting) return;
    if (on && this.hidden) this.setCanvasVisible(true);
    if (on) {
      this.toolBeforePresenting = { tool: this.tool, geo: this.geoKind };
      this.setFollowState(startPresenting(this.fstate));
      if (this.tool !== 'laser') this.setTool('laser');
      this.fitForPresentation(fromTop ? 0 : undefined);
    } else {
      this.setFollowState(stopPresenting(this.fstate, this.followPeers(), this.selfClientId()));
      const back = this.toolBeforePresenting;
      this.toolBeforePresenting = null;
      if (back) {
        this.geoKind = back.geo;
        this.setTool(back.tool);
      }
      if (this.fstate.target) this.applyFollow();
    }
    this.publishPresence({ presenting: on, viewport: this.visibleWorld() }, true);
    // the zoom the page is read at changed (the presentation's, or the view's again)
    this.syncScroller();
    this.emit('present');
    this.emit('follow');
  }

  /** Esc: leave presentation mode, else drop the tool for select, else the selection. */
  escape() {
    if (this.presenting) {
      this.setPresenting(false);
      return;
    }
    this.activeTool.cancel?.();
    if (this.tool !== 'select') this.setTool('select');
    else this.clearSelection();
  }

  // ------------------------------------------------------------------ links of the artifact

  /** Until when a link or anchor message answers the select tool's click (clickArtifact). */
  private frameClickUntil = 0;

  /**
   * Is a `link` or `anchor` message from the frame the user's doing? It must come with a user
   * gesture on this page (a click inside the frame activates its ancestors too), and either
   * answer the select tool's click of the last moment, or come while the user works inside the
   * artifact (interact tool, focus in the frame). A script of the artifact posting on its own,
   * or riding on a click made elsewhere on the canvas, gets nothing.
   */
  private frameGesture(): boolean {
    if (!userActivated()) return false;
    if (performance.now() < this.frameClickUntil) {
      this.frameClickUntil = 0;
      return true;
    }
    return (this.tool === 'interact' || this.hidden) && this.focusInFrame();
  }

  // ------------------------------------------------------------------ canvas shown / hidden

  /** Show the canvas (the full editor) or hide it (the artifact as the plain page). */
  setCanvasVisible(visible: boolean) {
    if (visible === !this.hidden) return;
    if (!visible) {
      if (this.presenting) this.setPresenting(false);
      if (this.editingId) this.stopEditing();
      this.activeTool.cancel?.();
      this.clearSelection();
      this.hideHover();
      this.setLaserPointer(null);
      this.laser = [];
      this.cameraBeforeHiding = { ...this.intendedCamera() };
      this.hidden = true;
      // what the others had of this tab goes away; it views (publishPresence keeps it so from now on)
      this.publishPresence({ cursor: null, viewport: null, laser: null, presenting: false }, true);
      this.frame.setInteractive(true);
      this.layoutHidden();
    } else {
      this.hidden = false;
      // the frame goes back to the canvas layout's height (the hidden page reported its own)
      this.frame.setNative(false);
      this.pageHeight = this.frame.height;
      this.page.style.width = `${this.pageWidth}px`;
      this.page.style.height = `${this.pageHeight}px`;
      this.frame.setInteractive(this.tool === 'interact');
      const cam = this.cameraBeforeHiding;
      this.cameraBeforeHiding = null;
      if (cam && this.initialCameraSet) this.setCamera(cam, 'system');
      else this.resetCamera();
      // the reporter says where the hidden page was being read; the camera then puts that block
      // where it was, at the size it had (onReading): showing the canvas never shrinks the page
      this.readingUntil = performance.now() + READING_WINDOW_MS;
      this.publishPresence({ status: this.tool === 'laser' ? 'cursor.laser' : null, viewport: this.visibleWorld(), following: this.fstate.target?.userId ?? null });
      if (this.fstate.target) this.applyFollow();
    }
    this.emit('canvas');
    this.emit('camera');
  }

  /** Hidden: the frame takes the whole view at scale 1, and the page scrolls on its own. */
  private layoutHidden() {
    this.leaveScroller();
    this.page.style.width = `${this.viewW}px`;
    this.page.style.height = `${this.viewH}px`;
    this.frame.setNative(true, this.viewW, this.viewH);
    this.camera = { tx: 0, ty: 0, z: 1 };
    this.world.style.transform = 'translate(0px, 0px) scale(1)';
  }

  /** Annotations in the room (the hidden canvas's badge). */
  annotationCount(): number {
    return this.doc.all().length;
  }

  /** Other people here, by person: viewing (any session) and annotating (canvas shown), never this user. */
  audience(): Audience {
    return audienceOf(this.conn ? peers(this.conn.awareness) : [], this.me?.id ?? null);
  }

  // ------------------------------------------------------------------ the artifact's background

  /**
   * The board takes the artifact's background (ui/theme.ts), so the area around and beyond the
   * page is the page's own colour. On a dark one the chrome goes dark and the shapes are drawn
   * for a dark board (render/shapeSvg.ts): `black`, the default ink, shows near-white, and the
   * highlighter lightens the page instead of darkening it. The stored colours do not change.
   */
  private applyBackground(c: Rgba) {
    this.board = opaque(c);
    const dark = isDark(c);
    document.documentElement.style.setProperty('--board', toCss(c));
    document.body.classList.toggle('theme-dark', dark);
    this.dark = dark;
    this.renderer.setDark(dark);
    this.emit('theme');
  }

  private focusInFrame(): boolean {
    return document.activeElement === this.frame.el;
  }

  /** A link clicked in the artifact (the reporter's `link` message, artifact/links.ts). */
  openLink(href: string, newTab: boolean) {
    const a = classifyLink(href, this.links);
    if (a.kind === 'blocked') {
      this.toast(t('link.blocked'));
      return;
    }
    if (a.kind === 'external') {
      window.open(a.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (a.kind === 'download') {
      const fileUrl = downloadUrl(a.key, this.links);
      if (fileUrl) this.download(fileUrl);
      return;
    }
    const url = canvasUrl(a.key, this.links, new URLSearchParams(location.search), { presenting: this.presenting, dev: this.cfg.dev });
    if (newTab) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    // the edits of the last send interval go out before the page changes
    this.conn?.flush();
    this.navigate(url);
  }

  /** A full page load opens the other file's canvas (its own room, its own annotations). */
  navigate(url: string) {
    location.assign(url);
  }

  /**
   * Save a file of the artifact and keep this page: an `<a download>` click starts the download
   * with no navigation and no history entry, and a failed response (403, 404) leaves the page in
   * place. The click runs in the caller's call stack, so it keeps the user gesture openLink checked.
   */
  download(url: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Follow the link of the artifact at a world point (the select tool's click on the page). */
  clickArtifact(p: Pt, newTab: boolean) {
    if (p.x < 0 || p.y < 0 || p.x > this.pageWidth || p.y > this.pageHeight) return;
    this.frameClickUntil = performance.now() + 1500;
    this.frame.clickAt(p.x, p.y, newTab);
  }

  private probeSeq = 0;
  private readonly probePace = new Throttle(() => 80);

  /** The select tool hovers the page: a pointer cursor over a link of the artifact. */
  probeLink(p: Pt | null) {
    const seq = ++this.probeSeq;
    if (!p || p.x < 0 || p.y < 0 || p.x > this.pageWidth || p.y > this.pageHeight) {
      if (this.stage.dataset.cursor === 'pointer') this.stage.dataset.cursor = '';
      return;
    }
    this.probePace.schedule(() => {
      void this.frame.probe(p.x, p.y).then((link) => {
        if (seq !== this.probeSeq || this.tool !== 'select') return;
        const cur = this.stage.dataset.cursor ?? '';
        if (cur === '' || cur === 'pointer') this.stage.dataset.cursor = link ? 'pointer' : '';
      });
    });
  }

  /** Bring the world point `p` near the top of the view, under the top panels (an anchor of the artifact). */
  revealTop(p: Pt) {
    const cam = this.intendedCamera();
    const z = cam.z;
    const vis = visibleWorld(cam, this.viewW, this.viewH);
    const tx = p.x >= vis.x && p.x <= vis.x + vis.w ? cam.tx : this.viewW / 2 - p.x * z;
    const margin = this.presenting ? PRESENT_TOP : this.viewW < 760 ? 112 : 70;
    this.setCamera({ z, tx, ty: margin - p.y * z });
  }

  // ------------------------------------------------------------------ camera

  private onResize() {
    const r = this.stage.getBoundingClientRect();
    const first = this.viewW === 0;
    this.viewW = r.width;
    this.viewH = r.height;
    if (first || !this.initialCameraSet) {
      if (r.width > 0) {
        this.initialCameraSet = true;
        this.resetCamera();
      }
    } else if (this.hidden) this.layoutHidden();
    else if (this.followingUserId) this.applyFollow();
    // fullscreen on or off, a phone turned: the page fills the new width, the same line at the top
    else if (this.presenting && r.width > 0) this.fitForPresentation();
    // the same camera; native scroll's window takes the view's new height (or the transform takes over)
    else this.syncScroller();
    this.emit('camera');
  }

  /** Initial camera: the artifact page at the top, as wide as fits (100% on a desktop). */
  resetCamera() {
    if (this.hidden) {
      this.layoutHidden();
      return;
    }
    if (this.presenting) {
      this.fitForPresentation();
      return;
    }
    // a desktop: the page as wide as the view, its top at the top, as the page itself is shown
    // (the side panels overlay it, ui/chrome.ts); a phone: a margin, below the two top bars
    const z = this.fitZoom();
    this.setCamera({ z, tx: (this.viewW - this.pageWidth * z) / 2, ty: this.viewW < PHONE_W ? 112 : 0 }, 'system');
  }

  /** The zoom at which the page is as wide as the view (a phone keeps a 12 px margin each side). */
  fitZoom(): number {
    return clampZoom(this.viewW < PHONE_W ? (this.viewW - 24) / this.pageWidth : this.viewW / this.pageWidth);
  }

  /** Presentation: the zoom at which the page is as wide as the screen (up to PRESENT_MAX_ZOOM). */
  presentZoom(): number {
    const pad = this.viewW < 760 ? 6 : 24;
    return clampZoom(Math.min(PRESENT_MAX_ZOOM, (this.viewW - 2 * pad) / this.pageWidth));
  }

  /** The zoom the page is read at: native scroll works at this one (docs/design.md §6.4). */
  homeZoom(): number {
    return this.presenting ? this.presentZoom() : this.fitZoom();
  }

  /**
   * The canvas was just shown, and the reporter says where the hidden page was being read: a block
   * of the page, its box on the screen then (left, top, width nw) and in the canvas layout now
   * (x, y, width w). The camera puts it at the same place and the same width on the screen, so the
   * text the user was reading does not move or shrink. A page whose column is narrower than the
   * view (a max-width) keeps its size; a page that fills the width fills it. Never wider than the
   * view, never under 40 % of that. Taken once, only right after the canvas was shown, and not
   * while presenting or following.
   */
  private onReading(r: FrameReading) {
    if (performance.now() > this.readingUntil || this.hidden || this.presenting || this.followingUserId) return;
    this.readingUntil = 0;
    const fit = this.fitZoom();
    const z = clampZoom(Math.max(fit * 0.4, Math.min(fit, r.nw / r.w)));
    this.setCamera({ z, tx: r.left - r.x * z, ty: r.top - r.y * z }, 'system');
    this.emit('camera');
  }

  /**
   * Presentation: the artifact page as wide as the screen (up to PRESENT_MAX_ZOOM), the line at
   * the top of the view kept at the top (the page top, under the badge, when it was in view), or
   * the line `at` (artifact px; 0: the page top, under the badge).
   */
  fitForPresentation(at?: number) {
    if (this.viewW <= 0) return;
    const z = this.presentZoom();
    const top = at ?? Math.max(0, visibleWorld(this.intendedCamera(), this.viewW, this.viewH).y);
    this.setCamera({ z, tx: (this.viewW - this.pageWidth * z) / 2, ty: top > 0 ? -top * z : PRESENT_TOP }, 'system');
  }

  /**
   * A presentation opened from a link with a `#hash` (`?present=1#s3`): its target at the top, under
   * the badge, once the frame says where it is. Not when the presenter moved first, or the page has
   * no such target (the presentation stays at the page top).
   */
  async presentAt(hash: string) {
    if (hash.length < 2) return;
    const s = await this.frame.slides(hash);
    if (!s?.target || !this.presenting || this.presentLine() > SLIDE_AT_TOP) return;
    this.revealTop({ x: this.visibleWorld().x + this.visibleWorld().w / 2, y: s.target.y });
  }

  /** Presentation: the line of the page (artifact px) under the badge, where a slide stepped to sits. */
  private presentLine(): number {
    const cam = this.intendedCamera();
    return visibleWorld(cam, this.viewW, this.viewH).y + PRESENT_TOP / cam.z;
  }

  /**
   * Presentation: step to the next (1) or the previous (-1) slide of the page, with any tool (the
   * arrow keys, Page Up/Down, Space). The frame says where the page's slides are; the camera brings
   * the one after (or before) the line under the badge to the top, as a same-document anchor does,
   * and the followers follow. With no slide that way (a page without slides, the notes after the
   * last one), a screen at a time.
   */
  stepSlide(dir: 1 | -1) {
    if (!this.presenting) return;
    void this.frame.slides().then((s) => {
      if (!this.presenting) return;
      const at = this.presentLine();
      const slide = s?.tops.length ? nextSlide(s.tops, at, dir) : null;
      const y = slide ?? screenStep(at, dir, (this.viewH - PRESENT_TOP) / this.camera.z, this.pageHeight);
      if (y === null) return;
      const vis = visibleWorld(this.intendedCamera(), this.viewW, this.viewH);
      this.revealTop({ x: vis.x + vis.w / 2, y });
    });
  }

  private applyPageWidth() {
    const w = this.doc.pageWidth(this.cfg.pageWidth);
    if (w === this.pageWidth) return;
    this.pageWidth = w;
    this.frame.width = w;
    if (!this.hidden) {
      this.page.style.width = `${w}px`;
      this.frame.el.style.width = `${w}px`;
    }
    this.resetCamera();
  }

  /**
   * Move the camera; source 'user' stops following, 'follow' and 'system' do not.
   *
   * Two ways to show it (docs/design.md §6.4). By default the transform. With native scroll on
   * (`?scroll=native`), at the zoom the page is read at (homeZoom), with the
   * view inside the page, the artifact's document scrolls itself: the frame is a
   * window as tall as the view that stays put on the screen, the document is asked to scroll to
   * the line at the top of the view, and the camera follows once the reporter says where it is
   * (onScrolled), so the page moves without the frame moving and the drawings follow one frame
   * later. A horizontal move shows at once. Anything else (a zoom, the view past the page top or
   * end) is the transform: the frame as tall as the page, panned and zoomed with the drawings.
   * Either way the camera maps world px (artifact px) to the screen the same way, so every viewer,
   * presenter and followers, sees the same part of the page and the drawings stay on it.
   */
  setCamera(c: Camera, source: 'user' | 'follow' | 'system' = 'user') {
    if (source === 'user' && this.followingUserId) this.stopFollowing();
    const cam = { tx: c.tx, ty: c.ty, z: clampZoom(c.z) };
    const n = this.nativeOf(cam);
    if (n) {
      if (!this.frame.scroller) {
        this.enterScroller(n);
        this.showCamera({ tx: cam.tx, ty: lineTy(n.y, cam.z), z: cam.z }, source);
        return;
      }
      // the view's height changed: the window follows it
      if (n.winH !== this.frame.windowH) {
        this.frame.setScroller(true, n.winH);
        this.page.style.height = `${n.winH}px`;
        this.placeWindow();
      }
      // sideways (or a new view's zoom) at once, at the line the document is at
      if (cam.tx !== this.camera.tx || cam.z !== this.camera.z) this.showCamera({ tx: cam.tx, ty: lineTy(this.scrollAt, cam.z), z: cam.z }, source);
      if (Math.abs(n.y - this.intendedY()) >= 0.5) this.requestScroll(n.y, source);
      return;
    }
    if (this.frame.scroller) this.leaveScroller();
    this.showCamera(cam, source);
  }

  /** Put the camera on the screen (the world's transform) and tell whoever needs to know. */
  private showCamera(cam: Camera, source: 'user' | 'follow' | 'system') {
    this.camera = cam;
    this.world.style.transform = `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.z})`;
    // the page's animation waits while the camera moves (ArtifactFrame.cameraMoved)
    if (!this.hidden) this.frame.cameraMoved();
    if (source === 'follow') this.publishFollowedViewport();
    else {
      this.clearFollowSettle();
      this.publishViewport();
    }
    if (this.editingId) this.positionTextarea();
    this.emit('camera');
  }

  /**
   * The camera this tab is going to: the one on the screen, or, while a native scroll is on its
   * way, the one it asked for. Moves made from the camera (a wheel, a drag, a slide step) start
   * from it, so a fast wheel adds up instead of starting each step from where the page still is.
   */
  intendedCamera(): Camera {
    if (!this.frame.scroller) return this.camera;
    const y = this.intendedY();
    return y === this.scrollAt ? this.camera : { ...this.camera, ty: lineTy(y, this.camera.z) };
  }

  /** Native scroll: the line the document is going to (or is at, as asked: it snaps to its pixels). */
  private intendedY(): number {
    if (this.scrollWant !== null) return this.scrollWant;
    const a = this.scrollAsked;
    return a !== null && Math.abs(a - this.scrollAt) <= SCROLL_SNAP ? a : this.scrollAt;
  }

  /** Native scroll is on: the frame is a window of the view and the document scrolls in it. */
  get nativeScrolling(): boolean {
    return this.frame.scroller;
  }

  /** How `cam` shows natively, or null when the transform shows it (camera.ts nativeScroll). */
  private nativeOf(cam: Camera): NativeScroll | null {
    if (!this.cfg.nativeScroll || this.hidden || this.scrollRefused || !this.frame.canScroll || !this.initialCameraSet) return null;
    return nativeScroll(cam, this.homeZoom(), this.viewH, this.pageHeight);
  }

  /** The camera stays; whether native scroll or the transform shows it follows the page and the view. */
  private syncScroller() {
    if (this.hidden || !this.initialCameraSet || this.viewW <= 0) return;
    const cam = this.intendedCamera();
    const n = this.nativeOf(cam);
    if (!!n === this.frame.scroller && (!n || (n.winH === this.frame.windowH && Math.abs(n.y - this.intendedY()) < 0.5))) return;
    this.setCamera(cam, 'system');
  }

  /** Start native scroll: the frame becomes the view's window at line `n.y`, the document goes there. */
  private enterScroller(n: NativeScroll) {
    this.scrollAt = n.y;
    // the period's first position is the line it starts at (the reporter says it once it is there)
    this.scrollWant = n.y;
    this.scrollAsked = n.y;
    this.scrollSeq = 0;
    this.scrollWantSeq = 0;
    this.scrollSource = 'system';
    this.frame.setScroller(true, n.winH, n.y);
    this.page.style.height = `${n.winH}px`;
    this.placeWindow();
  }

  /** End native scroll: the frame is as tall as the page again, its top at the page top. */
  private leaveScroller() {
    this.scrollWant = null;
    this.scrollAsked = null;
    this.scrollAt = 0;
    if (!this.frame.scroller) return;
    this.frame.setScroller(false);
    if (!this.hidden) this.page.style.height = `${this.pageHeight}px`;
    this.page.style.transform = '';
    this.setCorners('');
  }

  /** The frame's window at the line the document is scrolled to: the page shows where it is in the world. */
  private placeWindow() {
    this.page.style.transform = `translate(0px, ${this.scrollAt}px)`;
    // rounded only where the window is at the page's own top or end
    const top = this.scrollAt <= 0.5;
    const end = this.scrollAt + this.frame.windowH >= this.pageHeight - 1.5;
    this.setCorners(top && end ? '' : top ? '6px 6px 0 0' : end ? '0 0 6px 6px' : '0');
  }

  private setCorners(v: string) {
    if (v === this.pageCorners) return;
    this.pageCorners = v;
    this.page.style.borderRadius = v;
  }

  /** Native scroll: ask the document to scroll to `y`; the camera follows when it is there (onScrolled). */
  private requestScroll(y: number, source: 'user' | 'follow' | 'system') {
    this.scrollWant = y;
    this.scrollAsked = y;
    this.scrollWantSeq = ++this.scrollSeq;
    this.scrollSource = source;
    this.frame.scrollTo(y, this.scrollWantSeq);
    // the page's animation waits while it scrolls, as while the camera moves
    this.frame.cameraMoved();
  }

  /**
   * The reporter says where the document is (native scroll): the window goes there and the camera
   * with it, so the drawings move with the page. An answer to the last request ends it; a scroll
   * nobody asked for is the page's own navigation (a deck's arrows, scrollIntoView): the camera
   * follows it, and the followers with it. A follower's page that moved by itself goes back to
   * the view it follows.
   */
  private onScrolled(y: number, seq: number) {
    if (this.hidden || !this.frame.scroller) return;
    const pending = this.scrollWant !== null;
    const source: 'user' | 'follow' | 'system' = pending ? this.scrollSource : this.followingUserId ? 'follow' : 'user';
    if (pending && seq >= this.scrollWantSeq) {
      const want = this.scrollWant!;
      this.scrollWant = null;
      const max = this.pageHeight - this.frame.windowH;
      // asked for a line the page has and it stayed elsewhere: the page scrolls itself back
      if (Math.abs(y - want) > SCROLL_SNAP && want > SCROLL_SNAP && want < max - SCROLL_SNAP) {
        if (++this.scrollRefusals >= SCROLL_REFUSALS) {
          this.scrollRefused = true;
          const cam = { ...this.camera, ty: lineTy(want, this.camera.z) };
          this.leaveScroller();
          this.showCamera(cam, source);
          return;
        }
      } else this.scrollRefusals = 0;
    }
    // the page's own scroll: the line asked for no longer stands for where it is
    if (!pending) this.scrollAsked = null;
    this.scrollAt = y;
    this.placeWindow();
    const z = this.camera.z;
    this.showCamera({ tx: this.camera.tx, ty: lineTy(y, z), z }, source);
    if (!pending && this.followingUserId) this.applyFollow();
  }

  /**
   * A new document in the frame (the page reloaded or navigated itself). Its reporter starts over:
   * it knows no native scroll period, and a request the old document never answered gets no `pos`
   * (the new one counts from `seq` 0), so it would stay pending and the next move would start from
   * it. The period ends here and a new one starts at the line on the screen.
   */
  private onFrameReload() {
    if (this.hidden || !this.frame.scroller) return;
    const cam = this.camera;
    this.leaveScroller();
    this.setCamera(cam, 'system');
  }

  private followSettle: ReturnType<typeof setTimeout> | null = null;

  /**
   * A follower's camera moves with the presenter's: its own viewport goes out once that camera
   * stood still for FOLLOW_SETTLE_MS, not at the presenter's pace. Otherwise every follower became
   * a sender as soon as the presenter scrolled, and the room carried one stream per member instead
   * of the presenter's alone.
   */
  private publishFollowedViewport() {
    this.clearFollowSettle();
    this.followSettle = setTimeout(() => {
      this.followSettle = null;
      this.publishPresence({ viewport: this.visibleWorld() });
    }, FOLLOW_SETTLE_MS);
  }

  private clearFollowSettle() {
    if (this.followSettle) clearTimeout(this.followSettle);
    this.followSettle = null;
  }

  visibleWorld(): Box {
    return visibleWorld(this.camera, this.viewW, this.viewH);
  }

  toWorld(p: Pt): Pt {
    return screenToWorld(this.camera, p);
  }

  toScreen(p: Pt): Pt {
    return worldToScreen(this.camera, p);
  }

  zoomBy(dir: 1 | -1, anchor?: Pt) {
    const a = anchor ?? { x: this.viewW / 2, y: this.viewH / 2 };
    const cam = this.intendedCamera();
    this.setCamera(zoomAt(cam, nextZoomStep(cam.z, dir), a));
  }

  zoomTo(z: number) {
    this.setCamera(zoomAt(this.intendedCamera(), z, { x: this.viewW / 2, y: this.viewH / 2 }));
  }

  pageBox(): Box {
    return { x: 0, y: 0, w: this.pageWidth, h: this.pageHeight };
  }

  contentBox(): Box {
    const boxes = [this.pageBox(), ...this.visibleShapes().map((s) => shapeBounds(s, this.renderer.env))];
    return unionBoxes(boxes)!;
  }

  zoomToFit() {
    this.setCamera(fitBox(this.contentBox(), this.viewW, this.viewH, 40, 1));
  }

  /** Centre the camera on a world point (minimap, artifact anchor links). */
  panTo(p: Pt) {
    this.setCamera({ z: this.camera.z, tx: this.viewW / 2 - p.x * this.camera.z, ty: this.viewH / 2 - p.y * this.camera.z });
  }

  /**
   * The stage was scrolled (a page's scrollIntoView reached it). Once the scroll stops (a smooth
   * one takes several frames), it becomes a camera move: the same picture, the stage back at 0,
   * and the viewport published as any pan of this tab is, so followers follow. A tab that follows
   * someone, or shows the page as itself (canvas hidden), only puts the stage back.
   */
  private onStageScroll() {
    clearTimeout(this.stageScrollTimer);
    this.stageScrollTimer = window.setTimeout(() => {
      const dx = this.stage.scrollLeft;
      const dy = this.stage.scrollTop;
      if (!dx && !dy) return;
      this.stage.scrollLeft = 0;
      this.stage.scrollTop = 0;
      if (this.hidden || this.followingUserId) return;
      this.panBy(-dx, -dy);
    }, STAGE_SCROLL_SETTLE_MS);
  }

  panBy(dx: number, dy: number, source: 'user' | 'system' = 'user') {
    const cam = this.intendedCamera();
    this.setCamera({ ...cam, tx: cam.tx + dx, ty: cam.ty + dy }, source);
  }

  // ------------------------------------------------------------------ shapes & selection

  /** Shapes in paint order, without those of hidden authors. */
  visibleShapes(): Shape[] {
    const hidden = this.renderer.hiddenAuthors;
    const all = this.doc.all();
    if (!hidden.size) return all;
    return all.filter((s) => !hidden.has(this.doc.attributionOf(s.id)?.createdBy ?? ''));
  }

  shapeAt(p: Pt, skip?: (s: Shape) => boolean): Shape | null {
    if (!this.annotationsVisible) return null;
    return topShapeAt(this.visibleShapes(), p, 4 / this.camera.z, this.renderer.env, skip);
  }

  selected(): Shape[] {
    const out: Shape[] = [];
    for (const id of this.selection) {
      const s = this.doc.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  select(ids: Iterable<string>, add = false) {
    if (!add) this.selection.clear();
    for (const id of this.doc.expandGroups(ids)) this.selection.add(id);
    this.syncStyleFromSelection();
    this.emit('selection');
  }

  deselect(ids: Iterable<string>) {
    for (const id of this.doc.expandGroups(ids)) this.selection.delete(id);
    this.emit('selection');
  }

  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.emit('selection');
  }

  selectAll() {
    this.select(this.visibleShapes().map((s) => s.id));
  }

  private syncStyleFromSelection() {
    const first = this.selected()[0];
    if (!first) return;
    const next = { ...this.style };
    for (const k of STYLE_KEYS) (next as Record<string, unknown>)[k] = first[k];
    this.style = next;
    this.emit('style');
  }

  /** Change the style for the next shape and for the selected shapes. */
  applyStyle(patch: Partial<Style>) {
    this.style = { ...this.style, ...patch };
    const ids = this.selected().filter((s) => !s.locked).map((s) => s.id);
    if (ids.length && !this.readOnly) {
      this.doc.setStyle(ids, patch);
      this.doc.endGesture();
    }
    this.emit('style');
  }

  deleteSelection() {
    if (this.readOnly) return;
    const ids = this.selected().filter((s) => !s.locked).map((s) => s.id);
    if (!ids.length) return;
    this.doc.delete(ids);
    this.doc.endGesture();
    this.clearSelection();
  }

  bringToFront() {
    const ids = [...this.selection];
    if (ids.length && !this.readOnly) {
      this.doc.bringToFront(ids);
      this.doc.endGesture();
    }
  }

  sendToBack() {
    const ids = [...this.selection];
    if (ids.length && !this.readOnly) {
      this.doc.sendToBack(ids);
      this.doc.endGesture();
    }
  }

  toggleGroup() {
    const sel = this.selected();
    if (!sel.length || this.readOnly) return;
    const groups = new Set(sel.map((s) => s.groupId));
    if (groups.size === 1 && sel[0].groupId) this.doc.ungroup(sel.map((s) => s.id));
    else if (sel.length > 1) this.doc.group(sel.map((s) => s.id));
    this.doc.endGesture();
    this.emit('selection');
  }

  isGrouped(): boolean {
    const sel = this.selected();
    return sel.length > 0 && !!sel[0].groupId && sel.every((s) => s.groupId === sel[0].groupId);
  }

  toggleLock() {
    const sel = this.selected();
    if (!sel.length || this.readOnly) return;
    const lock = !sel.every((s) => s.locked);
    this.doc.setLocked(sel.map((s) => s.id), lock);
    this.doc.endGesture();
    this.emit('selection');
  }

  undo() {
    if (this.readOnly) return;
    this.doc.undo();
    this.emit('history');
  }

  redo() {
    if (this.readOnly) return;
    this.doc.redo();
    this.emit('history');
  }

  duplicate() {
    if (this.readOnly) return;
    this.copy();
    this.paste(16);
  }

  copy() {
    const shapes = this.selected();
    if (!shapes.length) return;
    const assets: Record<string, string> = {};
    for (const s of shapes) if (s.type === 'image') assets[s.assetId] = this.doc.assets.get(s.assetId) ?? '';
    this.clipboard = { shapes: JSON.parse(JSON.stringify(shapes)), assets };
  }

  paste(offset = 24): boolean {
    if (!this.clipboard || this.readOnly) return false;
    // image data the room no longer holds (its shapes were deleted since the copy) is stored again:
    // it must fit like a new image (canvasFits), or the server would refuse the update (4413)
    const missing = Object.entries(this.clipboard.assets).filter(([aid, url]) => url && !this.doc.assets.has(aid));
    const adding = missing.reduce((a, [, url]) => a + url.length, 0);
    if (adding && !this.canvasFits(adding)) return true;
    const idMap = new Map<string, string>();
    const groupMap = new Map<string, string>();
    for (const s of this.clipboard.shapes) idMap.set(s.id, newId());
    const created: string[] = [];
    this.doc.transact(() => {
      // setAsset keeps only raster data URLs (assetValueOk); in the same transaction as the shapes
      for (const [aid, url] of missing) this.doc.setAsset(aid, url);
      for (const s of this.clipboard!.shapes) {
        const copy: Record<string, unknown> = { ...s, id: idMap.get(s.id), index: undefined };
        if (s.groupId) {
          if (!groupMap.has(s.groupId)) groupMap.set(s.groupId, newId('g'));
          copy.groupId = groupMap.get(s.groupId);
        }
        if (s.type === 'line' || s.type === 'arrow') {
          const term = (tm: typeof s.start) => {
            const b = tm.bind && idMap.get(tm.bind.shapeId);
            return b ? { ...tm, x: tm.x + offset, y: tm.y + offset, bind: { ...tm.bind!, shapeId: b } } : { x: tm.x + offset, y: tm.y + offset };
          };
          copy.start = term(s.start);
          copy.end = term(s.end);
        } else {
          copy.x = s.x + offset;
          copy.y = s.y + offset;
        }
        created.push(this.doc.create(copy as unknown as Shape));
      }
    });
    this.doc.endGesture();
    this.select(created);
    return true;
  }

  // ------------------------------------------------------------------ tools

  setTool(id: ToolId) {
    if (this.editingId) this.stopEditing();
    this.activeTool.cancel?.();
    this.tool = id;
    this.activeTool = TOOLS[id](this);
    if (id !== 'select') this.hideHover();
    this.stage.dataset.tool = id;
    // a cursor the select tool set (move, a resize arrow, a link's pointer) must not hide the new tool's
    this.stage.dataset.cursor = '';
    this.frame.setInteractive(id === 'interact' || this.hidden);
    if (id !== 'laser') this.setLaserPointer(null);
    // the others see a laser dot instead of an arrow for this cursor
    const status = id === 'laser' ? 'cursor.laser' : null;
    if (status !== this.publishedStatus) this.publishPresence({ status });
    this.emit('tool');
  }

  setGeo(kind: GeoKind) {
    this.geoKind = kind;
    this.setTool('geo');
  }

  /** Laser points: add and publish. */
  addLaserPoint(p: Pt) {
    const now = Date.now();
    this.laser.push([round(p.x), round(p.y), now]);
    this.laser = this.laser.filter((q) => now - q[2] < LASER_TTL);
    this.publishPresence({ laser: { pts: this.laser.slice(-60), now } });
    this.ensureLaserAnimation();
  }

  private laserHoldTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The laser is pressed (true) or released (false). While it is pressed and held still, its
   * last point goes out again every LASER_HOLD_MS so the dot stays on for the others (a few
   * messages per second, inside the awareness pace).
   */
  holdLaser(on: boolean) {
    if (this.laserHoldTimer) clearInterval(this.laserHoldTimer);
    this.laserHoldTimer = null;
    if (!on) return;
    this.laserHoldTimer = setInterval(() => {
      const last = this.laser[this.laser.length - 1];
      if (last && Date.now() - last[2] >= LASER_HOLD_MS) this.addLaserPoint({ x: last[0], y: last[1] });
    }, LASER_HOLD_MS);
  }

  /** The laser dot under a finger or a pen (no mouse cursor there); null hides it. */
  setLaserPointer(screen: Pt | null) {
    this.overlay?.setLaserPointer(screen);
  }

  ensureLaserAnimation() {
    if (this.laserAnim) return;
    const tick = () => {
      this.laserAnim = 0;
      const active = this.overlay.updateLaser();
      if (active) this.laserAnim = requestAnimationFrame(tick);
      else if (this.laser.length) {
        this.laser = [];
        this.publishPresence({ laser: null });
      }
    };
    this.laserAnim = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ text editing

  startEditing(id: string) {
    const s = this.doc.get(id);
    if (!s || this.readOnly || s.locked) return;
    if (s.type !== 'text' && s.type !== 'note' && s.type !== 'geo' && s.type !== 'frame') return;
    this.editingId = id;
    this.select([id]);
    const ta = this.textarea;
    ta.maxLength = s.type === 'frame' ? FRAME_NAME_MAX : MAX_TEXT_LENGTH;
    ta.value = clampText(s.type === 'frame' ? s.name : s.text, ta.maxLength);
    ta.dataset.kind = s.type;
    ta.style.display = 'block';
    this.positionTextarea();
    this.renderer.elementFor(id)?.classList.add('editing');
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    this.publishPresence({ status: s.type === 'note' ? 'cursor.typingNote' : 'cursor.typing' });
  }

  positionTextarea() {
    const s = this.editingId ? this.doc.get(this.editingId) : undefined;
    if (!s) return;
    const ta = this.textarea;
    const z = this.camera.z;
    const p = this.toScreen({ x: s.x, y: s.y });
    let fontSize = 18;
    let w = s.w;
    let h = s.h;
    let pad = 0;
    let align = 'left';
    let dy = 0;
    if (s.type === 'text') {
      fontSize = own(FONT_SIZE, s.size, 24);
      w = Math.max(s.w + 40, 120);
    } else if (s.type === 'note') {
      fontSize = own(NOTE_FONT_SIZE, s.size, 18);
      pad = 14;
    } else if (s.type === 'geo') {
      fontSize = 18;
      pad = 8;
      align = 'center';
    } else if (s.type === 'frame') {
      fontSize = 13;
      h = 20;
      dy = -22;
      w = Math.max(s.w * 0.6, 120);
    }
    const family = getComputedFontFamily(s.font);
    Object.assign(ta.style, {
      left: `${p.x}px`,
      top: `${p.y + dy * z}px`,
      width: `${w}px`,
      height: `${h}px`,
      transform: `scale(${z})${s.rotation ? ` rotate(${s.rotation}rad)` : ''}`,
      transformOrigin: '0 0',
      fontSize: `${fontSize}px`,
      fontFamily: s.type === 'frame' ? getComputedFontFamily('sans') : family,
      padding: `${pad}px`,
      textAlign: align,
      color: s.type === 'note' ? '#1d1d1f' : 'inherit',
    });
  }

  /** A paste into the text editor: only what fits under the length cap goes in. */
  private onTextPaste(e: ClipboardEvent) {
    const ta = this.textarea;
    const pasted = e.clipboardData?.getData('text/plain');
    if (pasted === undefined) return;
    const room = ta.maxLength - (ta.value.length - (ta.selectionEnd - ta.selectionStart));
    if (pasted.length <= room) return; // the browser inserts it
    e.preventDefault();
    const part = clampText(pasted, Math.max(0, room));
    ta.setRangeText(part, ta.selectionStart, ta.selectionEnd, 'end');
    this.toast(t('text.truncated', { max: ta.maxLength.toLocaleString() }));
    this.onTextInput();
  }

  private onTextInput() {
    const id = this.editingId;
    const s = id ? this.doc.get(id) : undefined;
    if (!id || !s) return;
    const max = s.type === 'frame' ? FRAME_NAME_MAX : MAX_TEXT_LENGTH;
    let text = this.textarea.value;
    if (text.length > max) {
      // a value set around maxLength (drop, IME, a script): cut it, keep the caret
      const caret = Math.min(this.textarea.selectionStart, max);
      text = clampText(text, max);
      this.textarea.value = text;
      this.textarea.setSelectionRange(caret, caret);
      this.toast(t('text.truncated', { max: max.toLocaleString() }));
    }
    if (s.type === 'frame') {
      this.doc.update(id, { name: text });
      return;
    }
    const patch: Record<string, unknown> = { text };
    if (s.type === 'text') {
      const lay = layoutText(text || ' ', s.font, own(FONT_SIZE, s.size, 24), s.fixedWidth ? s.w : null);
      if (!s.fixedWidth) patch.w = Math.max(10, Math.ceil(lay.width) + 2);
      patch.h = Math.ceil(lay.height);
    } else if (s.type === 'note') {
      const lay = layoutText(text || ' ', s.font, own(NOTE_FONT_SIZE, s.size, 18), s.w - 28);
      patch.h = Math.max(NOTE_SIZE, Math.ceil(lay.height + 28));
    }
    this.doc.update(id, patch);
    this.positionTextarea();
  }

  stopEditing() {
    const id = this.editingId;
    if (!id) return;
    this.editingId = null;
    this.textarea.style.display = 'none';
    this.renderer.elementFor(id)?.classList.remove('editing');
    const s = this.doc.get(id);
    if (s && s.type === 'text' && !s.text.trim()) this.doc.delete([id]);
    this.doc.endGesture();
    this.publishPresence({ status: null });
    this.emit('selection');
  }

  // ------------------------------------------------------------------ images

  /** images refused client-side because the canvas is full (fv8 U1; tests read it) */
  canvasFullRefusals = 0;

  async insertImageFile(file: File, at?: Pt): Promise<void> {
    if (this.readOnly || !file.type.startsWith('image/')) return;
    const url = await readAsDataUrl(file);
    const img = await loadImage(url);
    const max = this.cfg.maxImageBytes;
    // fv8 U1: stored at most 1600 px, as WebP (JPEG without WebP), PNG or the original file,
    // whichever is smallest; only png/jpeg/gif/webp data URLs are stored (server rule): anything
    // else (svg, bmp, avif, ...) is re-encoded through a canvas
    const dataUrl = encodeImage(img, url, file.type, max);
    if (!dataUrl || dataUrl.length * 0.75 > max) {
      this.toast(t('image.tooLarge', { max: `${Math.round(max / 1024 / 1024)} MB` }));
      return;
    }
    this.insertImageData(dataUrl, img.naturalWidth, img.naturalHeight, at);
  }

  /**
   * Add an image already in its stored form (a data URL the server accepts) of `naturalWidth` x
   * `naturalHeight` px at `at`, when the canvas can take it. Returns the new shape's id, or null.
   */
  insertImageData(dataUrl: string, naturalWidth: number, naturalHeight: number, at?: Pt): string | null {
    if (this.readOnly || !this.canvasFits(dataUrl.length)) return null;
    const assetId = newId('a');
    const scale = Math.min(1, 600 / naturalWidth, 600 / naturalHeight);
    const w = Math.max(20, naturalWidth * scale);
    const h = Math.max(20, naturalHeight * scale);
    const c = at ?? this.toWorld({ x: this.viewW / 2, y: this.viewH / 2 });
    // the data and the shape that names it: one update, one undo step
    let id = '';
    this.doc.transact(() => {
      if (!this.doc.setAsset(assetId, dataUrl)) return;
      id = this.doc.create({ type: 'image', assetId, x: c.x - w / 2, y: c.y - h / 2, w, h, opacity: this.style.opacity } as Partial<Shape> & { type: 'image' });
    });
    if (!id) return null;
    this.doc.endGesture();
    this.select([id]);
    this.setTool('select');
    return id;
  }

  /**
   * fv8 U1: a canvas that cannot take `adding` more characters of image data says so, before the
   * server would refuse the update by closing the connection (4413). The room is measured as the
   * server stores it (deleted image data no longer counts, roomBytes), and image data left with no
   * shape naming it is deleted first. Data deleted in the last FREED_GRACE_MS still counts: the
   * server forgets it at its next save, and until then the toast asks to wait a moment.
   */
  canvasFits(adding: number): boolean {
    const cap = this.cfg.maxDocBytes;
    let room = roomBytes(this.doc.doc, this.doc.ledger);
    if (wouldOverfill(room, adding, cap) && this.doc.collectUnreferencedAssets() > 0) room = roomBytes(this.doc.doc, this.doc.ledger);
    if (wouldOverfill(room, adding, cap)) {
      this.toast(t('image.canvasFull', { max: `${(cap / 1024 / 1024).toFixed(cap < 2 * 1024 * 1024 ? 2 : 1)} MB` }));
      this.canvasFullRefusals++;
      return false;
    }
    if (wouldOverfill(room + this.doc.recentlyFreedBytes(), adding, cap)) {
      this.toast(t('image.freeing'), 6000);
      this.canvasFullRefusals++;
      return false;
    }
    return true;
  }

  pickImage(at?: Pt) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void this.insertImageFile(f, at);
    };
    input.click();
  }

  // ------------------------------------------------------------------ misc UI hooks

  toastFn: ((msg: string, ms?: number) => void) | null = null;
  /** Show `msg` for `ms` milliseconds (the UI's default when omitted). */
  toast(msg: string, ms?: number) {
    this.toastFn?.(msg, ms);
  }

  setAnnotationsVisible(v: boolean) {
    this.annotationsVisible = v;
    this.renderer.setVisible(v);
    if (!v) this.clearSelection();
    this.overlay.update();
    this.emit('visibility');
  }

  setAuthorHidden(id: string, hidden: boolean) {
    if (hidden) this.renderer.hiddenAuthors.add(id);
    else this.renderer.hiddenAuthors.delete(id);
    for (const s of this.selected()) if (this.doc.attributionOf(s.id)?.createdBy === id) this.selection.delete(s.id);
    this.renderer.invalidateAll();
    this.emit('visibility');
    this.emit('selection');
  }

  showHover(id: string | null) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.overlay.updateHover();
  }

  hideHover() {
    this.showHover(null);
  }

  // ------------------------------------------------------------------ input

  private activePointers = new Map<number, Pt>();
  private pinch: { d: number; c: Pt; cam: Camera } | null = null;
  private panning: { last: Pt } | null = null;
  private lastClick = { t: 0, x: 0, y: 0 };

  private info(e: PointerEvent | MouseEvent): PointerInfo {
    const r = this.stage.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const pe = e as PointerEvent;
    return {
      screen,
      world: this.toWorld(screen),
      shift: e.shiftKey,
      alt: e.altKey,
      mod: e.metaKey || e.ctrlKey,
      pressure: pe.pointerType === 'pen' ? pe.pressure || 0.5 : 0.5,
      pen: pe.pointerType === 'pen',
      button: e.button,
    };
  }

  private bindInput() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => {
      if (e.target === this.textarea) return;
      if (this.editingId) this.textarea.blur();
      st.setPointerCapture(e.pointerId);
      const info = this.info(e);
      this.activePointers.set(e.pointerId, info.screen);
      if (this.activePointers.size === 2) {
        // two fingers: pinch-zoom / pan, cancel what the first finger started
        this.activeTool.cancel?.();
        const [a, b] = [...this.activePointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam: { ...this.camera } };
        return;
      }
      // the interact tool: the page takes the pointer itself; around it, a drag pans
      if (e.button === 1 || this.spaceDown || (e.button === 0 && (this.tool === 'hand' || this.tool === 'interact'))) {
        this.panning = { last: info.screen };
        st.classList.add('panning');
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const now = performance.now();
      const dbl = now - this.lastClick.t < 400 && Math.hypot(info.screen.x - this.lastClick.x, info.screen.y - this.lastClick.y) < 6;
      this.lastClick = { t: dbl ? 0 : now, x: info.screen.x, y: info.screen.y };
      if (dbl && this.activeTool.doubleClick) {
        this.activeTool.doubleClick(info);
        return;
      }
      if (this.readOnly && this.tool !== 'select' && this.tool !== 'laser') return;
      if (this.tool === 'laser' && e.pointerType !== 'mouse') this.setLaserPointer(info.screen);
      this.activeTool.down(info);
    });
    st.addEventListener('pointermove', (e) => {
      const info = this.info(e);
      if (this.activePointers.has(e.pointerId)) this.activePointers.set(e.pointerId, info.screen);
      this.pointerWorld = info.world;
      // a finger only moves while it touches; a pen also hovers
      if (this.tool === 'laser' && (e.pointerType === 'pen' || (e.pointerType === 'touch' && this.activePointers.has(e.pointerId)))) this.setLaserPointer(info.screen);
      if (this.annotationsVisible || this.tool === 'laser') this.publishPresence({ cursor: { x: round(info.world.x), y: round(info.world.y) } });
      if (this.pinch && this.activePointers.size >= 2) {
        const [a, b] = [...this.activePointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const p0 = this.pinch;
        const z = clampZoom(p0.cam.z * (d / (p0.d || 1)));
        const wpt = screenToWorld(p0.cam, p0.c);
        this.setCamera({ z, tx: c.x - wpt.x * z, ty: c.y - wpt.y * z });
        return;
      }
      if (this.panning) {
        this.panBy(info.screen.x - this.panning.last.x, info.screen.y - this.panning.last.y);
        this.panning.last = info.screen;
        return;
      }
      // coalesced events give smoother freehand strokes
      const events = (e as PointerEvent).getCoalescedEvents?.() ?? [];
      if (events.length > 1 && (this.tool === 'draw' || this.tool === 'highlight')) {
        for (const ce of events) this.activeTool.move(this.info(ce));
      } else this.activeTool.move(info);
    });
    const up = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);
      if (e.pointerType === 'touch') this.setLaserPointer(null);
      if (this.pinch) {
        if (this.activePointers.size < 2) this.pinch = null;
        return;
      }
      if (this.panning) {
        this.panning = null;
        st.classList.remove('panning');
        return;
      }
      this.activeTool.up(this.info(e));
    };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', (e) => {
      this.activePointers.delete(e.pointerId);
      this.setLaserPointer(null);
      this.pinch = null;
      this.panning = null;
      this.activeTool.cancel?.();
    });
    st.addEventListener('pointerleave', () => {
      this.publishPresence({ cursor: null });
      this.hideHover();
      this.setLaserPointer(null);
    });
    st.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = st.getBoundingClientRect();
        const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.wheel({ dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, zoom: e.ctrlKey || e.metaKey, shift: e.shiftKey }, anchor);
      },
      { passive: false },
    );
    st.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    st.addEventListener('drop', (e) => {
      if (this.hidden) return;
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      const at = this.info(e).world;
      files.forEach((f, i) => void this.insertImageFile(f, { x: at.x + i * 24, y: at.y + i * 24 }));
    });
    window.addEventListener('paste', (e) => {
      if (isTyping(e.target) || this.hidden) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        void this.insertImageFile(files[0], this.pointerWorld ?? undefined);
        return;
      }
      if (this.paste()) e.preventDefault();
    });
    window.addEventListener('copy', (e) => {
      if (isTyping(e.target) || !this.selection.size || this.hidden) return;
      this.copy();
      e.preventDefault();
    });
    window.addEventListener('cut', (e) => {
      if (isTyping(e.target) || !this.selection.size || this.hidden) return;
      this.copy();
      this.deleteSelection();
      e.preventDefault();
    });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        st.classList.remove('space');
      }
    });
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      st.classList.remove('space');
    });
  }

  /** A wheel: ctrl/⌘ (or a trackpad pinch) zooms at `anchor` (screen px), else it pans. */
  wheel(w: Omit<FrameWheel, 'x' | 'y'>, anchor: Pt) {
    if (w.zoom) {
      const cam = this.intendedCamera();
      const factor = Math.exp(-w.dy * (w.mode === 1 ? 0.05 : 0.0025) * 4);
      this.setCamera(zoomAt(cam, cam.z * factor, anchor));
      return;
    }
    const k = w.mode === 1 ? 16 : w.mode === 2 ? this.viewH : 1;
    let dx = w.shift && !w.dx ? w.dy : w.dx;
    const dy = w.shift && !w.dx ? 0 : w.dy;
    // native scroll: a mostly vertical wheel scrolls the page; the sideways drift of a trackpad
    // would move the frame on every step
    if (this.frame.scroller && Math.abs(dy) >= Math.abs(dx)) dx = 0;
    this.panBy(-dx * k, -dy * k);
  }

  /**
   * A page key outside a presentation: ↑ ↓ a little, Page Up/Down and Space a screen, Home/End the
   * page's top and end (natively at the zoom the page is read at, else a pan of the camera).
   */
  scrollKey(key: string, dir: 1 | -1) {
    const cam = this.intendedCamera();
    const vis = visibleWorld(cam, this.viewW, this.viewH);
    if (key === 'Home' || key === 'End') {
      // the end: the page's last screen (natively, the window's last line, camera.ts nativeScroll)
      const end = Math.max(0, this.frame.scroller ? Math.floor(this.pageHeight) - this.frame.windowH - 1 : this.pageHeight - vis.h);
      this.setCamera({ ...cam, ty: lineTy(key === 'Home' ? 0 : end, cam.z) });
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') return;
    const step = key === 'ArrowUp' || key === 'ArrowDown' ? ARROW_SCROLL : this.viewH * PAGE_SCROLL;
    this.panBy(0, -dir * step);
  }

  /** The artifact handed over a wheel (interact tool): the same as a wheel on the canvas. */
  private wheelFromFrame(w: FrameWheel) {
    this.wheel(w, this.toScreen({ x: w.x, y: w.y }));
  }

  private onKeyDown(e: KeyboardEvent) {
    // a hidden canvas takes no shortcut: the page is the plain artifact
    if (isTyping(e.target) || this.hidden) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    // presenting: → ↓ Page Down Space and ← ↑ Page Up ⇧Space step the page, whatever the tool or
    // the selection (a note just written stays selected: the arrows do not nudge it)
    if (this.presenting && !mod && !e.altKey) {
      const dir = stepOf(e.key, e.shiftKey);
      if (dir) {
        e.preventDefault();
        this.stepSlide(dir);
        return;
      }
    }
    if (e.code === 'Space') {
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.stage.classList.add('space');
      }
      e.preventDefault();
      return;
    }
    if (mod) {
      if (k === 'z' && !e.shiftKey) this.undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') this.redo();
      else if (k === 'a') this.selectAll();
      else if (k === 'd') this.duplicate();
      else if (k === 'g' && e.shiftKey) {
        if (this.isGrouped()) this.toggleGroup();
      } else if (k === 'g') {
        if (!this.isGrouped()) this.toggleGroup();
      } else if (k === '=' || k === '+') this.zoomBy(1);
      else if (k === '-') this.zoomBy(-1);
      else if (k === '0') this.zoomTo(1);
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelection();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      this.escape();
      return;
    }
    // page keys (the arrows only with nothing selected: then they nudge it); Space is the hand
    if (e.key === 'PageDown' || e.key === 'PageUp' || e.key === 'Home' || e.key === 'End' || ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !this.selection.size)) {
      this.scrollKey(e.key, e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp' ? -1 : 1);
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && this.selection.size === 1) {
      const id = [...this.selection][0];
      this.startEditing(id);
      e.preventDefault();
      return;
    }
    if (e.key.startsWith('Arrow') && this.selection.size && !this.readOnly) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      TOOLS_NUDGE(this, dx, dy);
      e.preventDefault();
      return;
    }
    if (e.shiftKey) {
      if (k === 'd') this.setTool('highlight');
      else if (e.key === '!' || e.code === 'Digit1') this.zoomToFit();
      else if (e.key === ')' || e.code === 'Digit0') this.zoomTo(1);
      else if (k === 'l') this.toggleLock();
      else return;
      e.preventDefault();
      return;
    }
    const map: Record<string, ToolId> = {
      v: 'select', h: 'hand', d: 'draw', p: 'draw', e: 'eraser', a: 'arrow', l: 'line', t: 'text', n: 'note',
      f: 'frame', k: 'laser', i: 'interact',
    };
    if (map[k]) {
      this.setTool(map[k]);
      e.preventDefault();
      return;
    }
    if (k === 'r') this.setGeo('rectangle');
    else if (k === 'o') this.setGeo('ellipse');
    else if (k === ']') this.bringToFront();
    else if (k === '[') this.sendToBack();
    else if (k === '=' || k === '+') this.zoomBy(1);
    else if (k === '-') this.zoomBy(-1);
    else return;
    e.preventDefault();
  }
}


/**
 * Does this page have a user gesture right now? A click inside the artifact counts: user
 * activation reaches the ancestors of the frame clicked. A browser without the API says no.
 */
function userActivated(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return !!ua?.isActive;
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/** The camera's ty that puts world line `y` at the top of the view (never -0: a camera at the page top is ty 0). */
function lineTy(y: number, z: number): number {
  return 0 - y * z;
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}

function isTyping(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  if (!e) return false;
  return e.tagName === 'TEXTAREA' || e.tagName === 'INPUT' || e.isContentEditable;
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
}

function getComputedFontFamily(f: Style['font']): string {
  return own(FONT_FAMILY, f, FONT_FAMILY.draw);
}

/** Longest frame name the editor writes. */
const FRAME_NAME_MAX = 120;

/** `text` cut to at most `max` UTF-16 units, never in the middle of a surrogate pair. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (end > 0 && c >= 0xd800 && c <= 0xdbff) end--;
  return text.slice(0, end);
}
