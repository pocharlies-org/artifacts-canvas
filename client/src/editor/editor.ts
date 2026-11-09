import type * as Y from 'yjs';
import { CanvasDoc, newId } from '../model/doc';
import { attachStamper } from '../model/stamper';
import { DEFAULT_STYLE, STYLE_KEYS, type Identity, type Shape, type Style, type GeoKind } from '../model/types';
import { Connection, type Status } from '../collab/connection';
import { peers, setPresence, type LaserPoint, type PresenceState } from '../collab/presence';
import type { Notice } from '../collab/protocol';
import { ArtifactFrame } from '../artifact/frame';
import { Renderer } from '../render/renderer';
import {
  type Camera, clampZoom, fitBox, matchViewport, nextZoomStep, screenToWorld, visibleWorld, worldToScreen, zoomAt,
} from './camera';
import { type Box, type Pt, unionBoxes } from '../geometry/vec';
import { shapeBounds, topShapeAt, FONT_SIZE, NOTE_FONT_SIZE, NOTE_SIZE } from '../geometry/shapes';
import { FONT_FAMILY, layoutText } from '../render/text';
import type { CanvasConfig } from '../config';
import { TOOLS, nudgeSelection as TOOLS_NUDGE, type ToolId, type Tool, type PointerInfo } from '../tools/tools';
import { Overlay } from '../render/overlay';
import { t } from '../i18n';

export type Topic = 'camera' | 'selection' | 'tool' | 'style' | 'presence' | 'doc' | 'status' | 'identity' | 'visibility' | 'follow' | 'history' | 'notice';

export interface EditorDom {
  stage: HTMLElement;
}

const LASER_TTL = 1000;

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
  presenting = false;
  followingUserId: string | null = null;
  private followReason: 'manual' | 'presenter' | null = null;
  private dismissedPresenter: string | null = null;
  /** Local laser trail (published through awareness, never stored). */
  laser: LaserPoint[] = [];
  /** Receive time of each peer's laser state (for fading). */
  laserSeen = new Map<number, { at: number; now: number }>();
  private clipboard: { shapes: Shape[]; assets: Record<string, string> } | null = null;
  private listeners = new Map<Topic, Set<() => void>>();
  activeTool: Tool;
  private presenceFrame = 0;
  private pendingPresence: Partial<PresenceState> = {};
  private laserAnim = 0;
  private stamperDetach: (() => void) | null = null;
  private initialCameraSet = false;

  constructor(cfg: CanvasConfig, root: HTMLElement, ydoc: Y.Doc, conn: Connection | null) {
    this.cfg = cfg;
    this.doc = new CanvasDoc(ydoc);
    this.conn = conn;
    this.pageWidth = cfg.pageWidth;
    this.pageHeight = 900;

    this.stage = el('div', 'stage');
    this.stage.setAttribute('data-testid', 'stage');
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
        this.page.style.height = `${h}px`;
        this.emit('camera');
      },
      title: () => this.emit('status'),
      scroll: (x, y) => this.panTo({ x, y }),
    });

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
        this.emit('status');
      });
      conn.onIdentity((id) => this.setIdentity(id));
      conn.onNotice((n) => {
        this.notice = n;
        this.emit('notice');
      });
      conn.awareness.on('change', () => this.onAwareness());
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
      // No stamping server (development relay): stamp my own transactions locally.
      const mine = { id: id.id, info: { name: id.name, anonymous: id.anonymous, color: id.color } };
      this.stamperDetach = attachStamper(this.doc.doc, {
        userOf: (origin) => (origin === this.doc.origin || origin === this.doc.undoManager || origin === 'asset' ? mine : null),
      });
    }
    this.publishPresence({
      user: { id: id.id, name: id.name, color: id.color!, anonymous: id.anonymous },
      viewport: this.visibleWorld(),
      presenting: this.presenting,
    });
    this.emit('identity');
    this.emit('presence');
  }

  get readOnly(): boolean {
    if (this.notice?.kind === 'readonly' || this.me?.readOnly) return true;
    if (!this.me) return true;
    return this.status === 'closed';
  }

  publishPresence(patch: Partial<PresenceState>, immediate = false) {
    if (!this.conn) return;
    Object.assign(this.pendingPresence, patch);
    if (immediate) {
      this.flushPresence();
      return;
    }
    if (this.presenceFrame) return;
    this.presenceFrame = requestAnimationFrame(() => this.flushPresence());
  }

  private flushPresence() {
    if (this.presenceFrame) cancelAnimationFrame(this.presenceFrame);
    this.presenceFrame = 0;
    if (!this.conn || !this.me) {
      return;
    }
    setPresence(this.conn.awareness, this.pendingPresence);
    this.pendingPresence = {};
  }

  private onAwareness() {
    if (!this.conn) return;
    const now = performance.now();
    for (const p of peers(this.conn.awareness)) {
      if (p.state.laser && p.state.laser.pts.length) this.laserSeen.set(p.clientId, { at: now, now: p.state.laser.now });
    }
    this.ensureLaserAnimation();
    // presenter / follow
    const presenter = peers(this.conn.awareness).find((p) => p.state.presenting && p.state.user && p.state.user.id !== this.me?.id);
    const pid = presenter?.state.user?.id ?? null;
    if (!pid) this.dismissedPresenter = null;
    if (this.followReason === 'presenter' && this.followingUserId !== pid) this.stopFollowing();
    if (pid && !this.presenting && !this.followingUserId && this.dismissedPresenter !== pid) this.follow(pid, 'presenter');
    if (this.followingUserId) this.applyFollow();
    this.overlay.updateCursors();
    this.emit('presence');
  }

  presenterName(): string | null {
    if (!this.conn) return null;
    const p = peers(this.conn.awareness).find((x) => x.state.presenting && x.state.user);
    return p?.state.user?.name ?? null;
  }

  follow(userId: string, reason: 'manual' | 'presenter' = 'manual') {
    this.followingUserId = userId;
    this.followReason = reason;
    this.publishPresence({ following: userId });
    this.applyFollow();
    this.emit('follow');
  }

  stopFollowing() {
    if (!this.followingUserId) return;
    if (this.followReason === 'presenter') this.dismissedPresenter = this.followingUserId;
    this.followingUserId = null;
    this.followReason = null;
    this.publishPresence({ following: null });
    this.emit('follow');
  }

  private applyFollow() {
    if (!this.conn || !this.followingUserId) return;
    const target = peers(this.conn.awareness).find((p) => p.state.user?.id === this.followingUserId && p.state.viewport);
    if (!target?.state.viewport) return;
    this.setCamera(matchViewport(target.state.viewport, this.viewW, this.viewH), 'follow');
  }

  setPresenting(on: boolean) {
    this.presenting = on;
    if (on) this.stopFollowing();
    this.publishPresence({ presenting: on, viewport: this.visibleWorld() }, true);
    this.emit('follow');
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
    } else if (this.followingUserId) this.applyFollow();
    this.emit('camera');
  }

  /** Initial camera: the artifact page at the top, as wide as fits (100% on a desktop). */
  resetCamera() {
    const z = clampZoom(Math.min(1, (this.viewW - 24) / this.pageWidth));
    this.setCamera({ z, tx: (this.viewW - this.pageWidth * z) / 2, ty: this.viewW < 760 ? 112 : 70 }, 'system');
  }

  private applyPageWidth() {
    const w = this.doc.pageWidth(this.cfg.pageWidth);
    if (w === this.pageWidth) return;
    this.pageWidth = w;
    this.page.style.width = `${w}px`;
    this.frame.width = w;
    this.frame.el.style.width = `${w}px`;
    this.resetCamera();
  }

  /** source 'user' stops following; 'follow' and 'system' do not. */
  setCamera(c: Camera, source: 'user' | 'follow' | 'system' = 'user') {
    if (source === 'user' && this.followingUserId) this.stopFollowing();
    this.camera = { tx: c.tx, ty: c.ty, z: clampZoom(c.z) };
    this.world.style.transform = `translate(${this.camera.tx}px, ${this.camera.ty}px) scale(${this.camera.z})`;
    this.publishPresence({ viewport: this.visibleWorld() });
    if (this.editingId) this.positionTextarea();
    this.emit('camera');
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
    this.setCamera(zoomAt(this.camera, nextZoomStep(this.camera.z, dir), a));
  }

  zoomTo(z: number) {
    this.setCamera(zoomAt(this.camera, z, { x: this.viewW / 2, y: this.viewH / 2 }));
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

  panBy(dx: number, dy: number, source: 'user' | 'system' = 'user') {
    this.setCamera({ ...this.camera, tx: this.camera.tx + dx, ty: this.camera.ty + dy }, source);
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
    const idMap = new Map<string, string>();
    const groupMap = new Map<string, string>();
    for (const s of this.clipboard.shapes) idMap.set(s.id, newId());
    const created: string[] = [];
    this.doc.transact(() => {
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
    for (const [aid, url] of Object.entries(this.clipboard.assets)) if (url && !this.doc.assets.has(aid)) this.doc.setAsset(aid, url);
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
    ta.value = s.type === 'frame' ? s.name : s.text;
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
      fontSize = FONT_SIZE[s.size];
      w = Math.max(s.w + 40, 120);
    } else if (s.type === 'note') {
      fontSize = NOTE_FONT_SIZE[s.size];
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

  private onTextInput() {
    const id = this.editingId;
    const s = id ? this.doc.get(id) : undefined;
    if (!id || !s) return;
    const text = this.textarea.value;
    if (s.type === 'frame') {
      this.doc.update(id, { name: text.slice(0, 120) });
      return;
    }
    const patch: Record<string, unknown> = { text };
    if (s.type === 'text') {
      const lay = layoutText(text || ' ', s.font, FONT_SIZE[s.size], s.fixedWidth ? s.w : null);
      if (!s.fixedWidth) patch.w = Math.max(10, Math.ceil(lay.width) + 2);
      patch.h = Math.ceil(lay.height);
    } else if (s.type === 'note') {
      const lay = layoutText(text || ' ', s.font, NOTE_FONT_SIZE[s.size], s.w - 28);
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

  async insertImageFile(file: File, at?: Pt): Promise<void> {
    if (this.readOnly || !file.type.startsWith('image/')) return;
    const url = await readAsDataUrl(file);
    const img = await loadImage(url);
    let dataUrl = url;
    const max = this.cfg.maxImageBytes;
    if (dataUrl.length * 0.75 > max || img.naturalWidth > 2000 || img.naturalHeight > 2000) {
      dataUrl = downscale(img, 1600, file.type === 'image/png' ? 'image/png' : 'image/jpeg');
      if (dataUrl.length * 0.75 > max) dataUrl = downscale(img, 1600, 'image/jpeg', 0.8);
      if (dataUrl.length * 0.75 > max) {
        this.toast(t('image.tooLarge', { max: `${Math.round(max / 1024 / 1024)} MB` }));
        return;
      }
    }
    const assetId = newId('a');
    this.doc.setAsset(assetId, dataUrl);
    const scale = Math.min(1, 600 / img.naturalWidth, 600 / img.naturalHeight);
    const w = Math.max(20, img.naturalWidth * scale);
    const h = Math.max(20, img.naturalHeight * scale);
    const c = at ?? this.toWorld({ x: this.viewW / 2, y: this.viewH / 2 });
    const id = this.doc.create({ type: 'image', assetId, x: c.x - w / 2, y: c.y - h / 2, w, h, opacity: this.style.opacity } as Partial<Shape> & { type: 'image' });
    this.doc.endGesture();
    this.select([id]);
    this.setTool('select');
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

  toastFn: ((msg: string) => void) | null = null;
  toast(msg: string) {
    this.toastFn?.(msg);
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
      if (e.button === 1 || this.spaceDown || (e.button === 0 && this.tool === 'hand')) {
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
      this.activeTool.down(info);
    });
    st.addEventListener('pointermove', (e) => {
      const info = this.info(e);
      if (this.activePointers.has(e.pointerId)) this.activePointers.set(e.pointerId, info.screen);
      this.pointerWorld = info.world;
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
      this.pinch = null;
      this.panning = null;
      this.activeTool.cancel?.();
    });
    st.addEventListener('pointerleave', () => {
      this.publishPresence({ cursor: null });
      this.hideHover();
    });
    st.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = st.getBoundingClientRect();
        const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
        if (e.ctrlKey || e.metaKey) {
          const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * 4);
          this.setCamera(zoomAt(this.camera, this.camera.z * factor, anchor));
        } else {
          const k = e.deltaMode === 1 ? 16 : 1;
          const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
          const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
          this.panBy(-dx * k, -dy * k);
        }
      },
      { passive: false },
    );
    st.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    st.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      const at = this.info(e).world;
      files.forEach((f, i) => void this.insertImageFile(f, { x: at.x + i * 24, y: at.y + i * 24 }));
    });
    window.addEventListener('paste', (e) => {
      if (isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        void this.insertImageFile(files[0], this.pointerWorld ?? undefined);
        return;
      }
      if (this.paste()) e.preventDefault();
    });
    window.addEventListener('copy', (e) => {
      if (isTyping(e.target) || !this.selection.size) return;
      this.copy();
      e.preventDefault();
    });
    window.addEventListener('cut', (e) => {
      if (isTyping(e.target) || !this.selection.size) return;
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

  private onKeyDown(e: KeyboardEvent) {
    if (isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
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
      this.activeTool.cancel?.();
      if (this.tool !== 'select') this.setTool('select');
      else this.clearSelection();
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
      f: 'frame', k: 'laser',
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


function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
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

function downscale(img: HTMLImageElement, maxSide: number, type: string, q = 0.9): string {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d')!;
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, q);
}

function getComputedFontFamily(f: Style['font']): string {
  return FONT_FAMILY[f];
}
