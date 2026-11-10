import type { Editor } from '../editor/editor';
import { t, type MessageKey } from '../i18n';
import { COLORS, COLOR_ORDER } from '../model/colors';
import { describeHistory, displayUser, formatTime, initials, shortName } from '../model/people';
import { GEO_KINDS, type Arrowheads, type Dash, type Fill, type Font, type GeoKind, type Size } from '../model/types';
import { people, peers } from '../collab/presence';
import type { ToolId } from '../tools/tools';
import { Minimap } from '../render/minimap';
import { download, exportCanvas, type ExportFormat, type ExportScope } from '../export/export';
import { geoOutline } from '../geometry/geo';
import { polyPath } from '../render/shapeSvg';
import { clear, h, installPopoverDismiss } from './dom';

/** Builds the panels of the approved mockup around the canvas and keeps them in sync. */
export function buildChrome(ed: Editor, root: HTMLElement) {
  installPopoverDismiss();
  const toastEl = h('div', { class: 'toast', 'data-testid': 'toast', role: 'status' });
  root.append(toastEl);
  let toastTimer = 0;
  ed.toastFn = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
  };

  // The three bottom panels share one flex row (zoom | toolbar | minimap) so they can
  // never overlap at narrow desktop widths (1280): the centered toolbar used to collide
  // with the zoom panel there.
  const bottomRow = h('div', { class: 'bottomrow' });
  bottomRow.append(bottomLeft(ed), toolbar(ed), minimapPanel(ed));

  root.append(
    topLeft(ed),
    topRight(ed),
    peoplePanel(ed),
    stylePanel(ed),
    bottomRow,
    banner(ed),
  );
}

// ------------------------------------------------------------------ top left: title, live, annotations

function topLeft(ed: Editor): HTMLElement {
  const title = h('span', { class: 'title', 'data-testid': 'title' });
  const live = h('span', { class: 'pill', 'data-testid': 'live' });
  const annBtn = h('button', { class: 'pill pill-btn', id: 'ann-toggle', 'data-testid': 'annotations-toggle', 'aria-haspopup': 'true' });
  const menu = h('div', { class: 'popover', 'data-owner': 'ann-toggle', role: 'menu' });
  const panelsBtn = h('button', { class: 'pill pill-btn panels-btn', title: t('app.panels.people'), 'aria-label': t('app.panels.people'), onclick: () => document.body.classList.toggle('panels-open') }, '☰');
  const renderMenu = () => {
    clear(menu);
    menu.append(
      h('button', { class: 'menu-item', 'data-testid': 'annotations-show', onclick: () => { ed.setAnnotationsVisible(true); menu.classList.remove('open'); } }, t('app.annotations.show')),
      h('button', { class: 'menu-item', 'data-testid': 'annotations-hide', onclick: () => { ed.setAnnotationsVisible(false); menu.classList.remove('open'); } }, t('app.annotations.hide')),
    );
  };
  annBtn.addEventListener('click', () => {
    renderMenu();
    menu.classList.toggle('open');
  });
  const update = () => {
    title.textContent = ed.frame.title || ed.cfg.title || ed.cfg.artifactPath || 'artifact';
    document.title = `${title.textContent} · canvas`;
    const s = ed.status;
    live.className = 'pill' + (s === 'synced' || s === 'connected' ? ' live' : ' off');
    live.textContent = ed.readOnly && ed.me ? t('app.readonly') : s === 'synced' || s === 'connected' ? t('app.live') : s === 'connecting' ? t('app.connecting') : t('app.offline');
    live.dataset.status = s;
    annBtn.textContent = `${ed.annotationsVisible ? t('app.annotations.visible') : t('app.annotations.hidden')} ▾`;
  };
  ed.on('status', update);
  ed.on('visibility', update);
  ed.on('identity', update);
  ed.on('notice', update);
  update();
  return h('div', { class: 'panel topleft' }, panelsBtn, title, live, h('span', { class: 'anchor' }, annBtn, menu));
}

// ------------------------------------------------------------------ top right: avatars, follow, present, share, export

function topRight(ed: Editor): HTMLElement {
  const avatars = h('div', { class: 'avatars', 'data-testid': 'avatars' });
  const followBtn = h('button', { class: 'btn', id: 'follow-btn', 'data-testid': 'follow' });
  const followMenu = h('div', { class: 'popover', 'data-owner': 'follow-btn', role: 'menu' });
  const presentBtn = h('button', { class: 'btn primary', 'data-testid': 'present' });
  const shareBtn = h('button', { class: 'btn', 'data-testid': 'share', 'aria-label': t('app.share') },
    h('span', { class: 'lbl-full' }, t('app.share')), h('span', { class: 'lbl-short' }, '⤴'));
  const exportBtn = h('button', { class: 'btn', id: 'export-btn', 'data-testid': 'export', 'aria-label': t('app.export') },
    h('span', { class: 'lbl-full' }, t('app.export')), h('span', { class: 'lbl-short' }, '⤓'));
  const exportMenu = h('div', { class: 'popover right', 'data-owner': 'export-btn', role: 'menu' });

  const others = () => {
    if (!ed.conn) return [];
    const seen = new Map<string, { id: string; name: string; anonymous: boolean; color: string }>();
    for (const p of peers(ed.conn.awareness)) {
      const u = p.state.user!;
      if (u.id !== ed.me?.id && !seen.has(u.id)) seen.set(u.id, u);
    }
    return [...seen.values()];
  };

  const update = () => {
    clear(avatars);
    const ppl = ed.conn ? people(ed.conn.awareness) : [];
    for (const p of ppl.slice(0, 6)) {
      const av = h('button', { class: 'av', style: `background:${p.color}`, title: p.name + (p.id === ed.me?.id ? ` ${t('app.you')}` : ''), 'data-user': p.name },
        initials(p.name, p.anonymous));
      if (p.id !== ed.me?.id) av.addEventListener('click', () => ed.follow(p.id));
      avatars.append(av);
    }
    if (ppl.length > 6) avatars.append(h('span', { class: 'av more' }, `+${ppl.length - 6}`));
    const o = others();
    const following = ed.followingUserId ? displayUser((u) => ed.doc.user(u), ed.followingUserId) : null;
    const followingName = following ? o.find((x) => x.id === ed.followingUserId)?.name ?? following.name : null;
    if (ed.followingUserId) {
      followBtn.textContent = t('app.follow.stop');
      followBtn.classList.add('on');
      followBtn.title = t('app.following', { name: followingName ?? '' });
    } else {
      followBtn.classList.remove('on');
      followBtn.textContent = o.length === 1 ? t('app.follow', { name: o[0].name.split(' ')[0] }) : t('app.follow.none');
      followBtn.title = '';
    }
    followBtn.disabled = !o.length && !ed.followingUserId;
    presentBtn.textContent = ed.presenting ? t('app.present.stop') : t('app.present');
    presentBtn.classList.toggle('on', ed.presenting);
  };
  followBtn.addEventListener('click', () => {
    if (ed.followingUserId) {
      ed.stopFollowing();
      return;
    }
    const o = others();
    if (o.length === 1) {
      ed.follow(o[0].id);
      return;
    }
    clear(followMenu);
    for (const p of o) {
      followMenu.append(h('button', { class: 'menu-item', onclick: () => { ed.follow(p.id); followMenu.classList.remove('open'); } },
        h('span', { class: 'dot', style: `background:${p.color}` }), ` ${p.name}`));
    }
    followMenu.classList.toggle('open');
  });
  presentBtn.addEventListener('click', () => ed.setPresenting(!ed.presenting));
  shareBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ed.cfg.shareUrl);
    } catch {
      /* clipboard may be unavailable (http); still show the link */
    }
    ed.toast(`${t('app.share.copied')}: ${ed.cfg.shareUrl}`);
  });
  const items: [MessageKey, ExportFormat, ExportScope][] = [
    ['app.export.pngView', 'png', 'view'],
    ['app.export.pngFull', 'png', 'full'],
    ['app.export.pdfView', 'pdf', 'view'],
    ['app.export.pdfFull', 'pdf', 'full'],
  ];
  for (const [key, fmt, scope] of items) {
    exportMenu.append(h('button', {
      class: 'menu-item', 'data-testid': `export-${fmt}-${scope}`,
      onclick: async () => {
        exportMenu.classList.remove('open');
        ed.toast(t('app.export.working'));
        try {
          const { blob, filename } = await exportCanvas(ed, fmt, scope);
          download(blob, filename);
        } catch (err) {
          ed.toast(t('app.export.failed', { error: String((err as Error)?.message ?? err) }));
        }
      },
    }, t(key)));
  }
  exportBtn.addEventListener('click', () => exportMenu.classList.toggle('open'));
  ed.on('presence', update);
  ed.on('follow', update);
  ed.on('identity', update);
  update();
  return h('div', { class: 'panel topright' }, avatars,
    h('span', { class: 'anchor' }, followBtn, followMenu), presentBtn, shareBtn,
    h('span', { class: 'anchor' }, exportBtn, exportMenu));
}

// ------------------------------------------------------------------ left: who drew + history

function peoplePanel(ed: Editor): HTMLElement {
  const rows = h('div', { class: 'rows', 'data-testid': 'authors' });
  const hist = h('div', { class: 'history-list', 'data-testid': 'history' });
  let frame = 0;
  const update = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };
  const render = () => {
    clear(rows);
    const counts = ed.doc.countsByAuthor();
    const hidden = ed.renderer.hiddenAuthors;
    const ids = [...counts.keys()].filter((k) => k).sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b));
    for (const id of hidden) if (!ids.includes(id)) ids.push(id);
    if (!ids.length) rows.append(h('div', { class: 'empty' }, t('people.empty')));
    for (const id of ids) {
      const u = displayUser((x) => ed.doc.user(x), id);
      const isHidden = hidden.has(id);
      rows.append(h('div', { class: 'prow' + (isHidden ? ' hidden' : ''), 'data-author-id': id, 'data-testid': 'author-row' },
        h('span', { class: 'dot', style: `background:${u.color}` }),
        h('span', { class: 'n' }, u.name + (id === ed.me?.id ? ` ${t('app.you')}` : '')),
        h('span', { class: 'c', 'data-testid': 'author-count' }, String(counts.get(id) ?? 0)),
        h('button', { class: 'eye', title: t('people.toggle'), 'aria-pressed': String(!isHidden), 'data-testid': 'author-eye', onclick: () => ed.setAuthorHidden(id, !isHidden) }, isHidden ? '🙈' : '👁'),
      ));
    }
    clear(hist);
    const entries = ed.doc.historyEntries().slice(-8).reverse();
    if (!entries.length) hist.append(h('div', { class: 'empty' }, t('history.empty')));
    for (const e of entries) {
      hist.append(h('div', { 'data-testid': 'history-entry' }, h('span', { class: 't' }, formatTime(e.t)), ' ', describeHistory(e, (x) => ed.doc.user(x))));
    }
  };
  ed.on('history', update);
  ed.on('visibility', update);
  ed.on('identity', update);
  render();
  return h('div', { class: 'panel people side' }, h('h4', {}, t('people.title')), rows,
    h('div', { class: 'history' }, h('h4', { style: 'margin-top:10px' }, t('history.title')), hist));
}

// ------------------------------------------------------------------ right: style panel

function seg<T extends string>(name: string, values: T[], label: (v: T) => string, get: () => T, set: (v: T) => void) {
  const wrap = h('div', { class: 'seg', 'data-testid': `seg-${name}`, role: 'radiogroup' });
  const spans = values.map((v) => {
    const b = h('button', { 'data-value': v, role: 'radio', onclick: () => set(v) }, label(v));
    wrap.append(b);
    return b;
  });
  const sync = () => spans.forEach((b, i) => {
    const on = values[i] === get();
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  return { el: wrap, sync };
}

function stylePanel(ed: Editor): HTMLElement {
  const swatches = h('div', { class: 'swatches', 'data-testid': 'swatches' });
  const sw = COLOR_ORDER.map((c) => {
    const b = h('button', { class: 'sw', style: `background:${COLORS[c]}${c === 'white' ? ';border:1px solid #ccc' : ''}`, title: c, 'data-color': c, onclick: () => ed.applyStyle({ color: c }) });
    swatches.append(b);
    return b;
  });
  const fill = seg<Fill>('fill', ['none', 'semi', 'solid', 'pattern'], (v) => t(`style.fill.${v}`), () => ed.style.fill, (v) => ed.applyStyle({ fill: v }));
  const dash = seg<Dash>('dash', ['solid', 'dashed', 'dotted', 'draw'], (v) => t(`style.dash.${v}`), () => ed.style.dash, (v) => ed.applyStyle({ dash: v }));
  const size = seg<Size>('size', ['s', 'm', 'l', 'xl'], (v) => v.toUpperCase(), () => ed.style.size, (v) => ed.applyStyle({ size: v }));
  const font = seg<Font>('font', ['draw', 'sans', 'serif', 'mono'], (v) => t(`style.font.${v}`), () => ed.style.font, (v) => ed.applyStyle({ font: v }));
  const heads = seg<Arrowheads>('arrowheads', ['none', 'end', 'both', 'dot'], (v) => ({ none: '—', end: '→', both: '↔', dot: '●' })[v], () => ed.style.arrowheads, (v) => ed.applyStyle({ arrowheads: v }));
  const opacity = h('input', { type: 'range', min: 10, max: 100, step: 5, 'data-testid': 'opacity', 'aria-label': t('style.opacity') });
  opacity.addEventListener('input', () => ed.applyStyle({ opacity: Number(opacity.value) / 100 }));
  const front = h('button', { class: 'btn', onclick: () => ed.bringToFront() }, t('style.front'));
  const back = h('button', { class: 'btn', onclick: () => ed.sendToBack() }, t('style.back'));
  const group = h('button', { class: 'btn', 'data-testid': 'group', onclick: () => ed.toggleGroup() });
  const lock = h('button', { class: 'btn', 'data-testid': 'lock', onclick: () => ed.toggleLock() });
  const sync = () => {
    sw.forEach((b, i) => b.classList.toggle('on', COLOR_ORDER[i] === ed.style.color));
    for (const s of [fill, dash, size, font, heads]) s.sync();
    opacity.value = String(Math.round(ed.style.opacity * 100));
    group.textContent = ed.isGrouped() ? t('style.ungroup') : t('style.group');
    const sel = ed.selected();
    lock.textContent = sel.length && sel.every((s) => s.locked) ? t('style.unlock') : t('style.lock');
    const none = !sel.length;
    for (const b of [front, back, group, lock]) b.disabled = none;
  };
  ed.on('style', sync);
  ed.on('selection', sync);
  sync();
  return h('div', { class: 'panel stylepanel side', 'data-testid': 'style-panel' },
    h('h4', {}, t('style.color')), swatches,
    h('h4', {}, t('style.fill')), fill.el,
    h('h4', {}, t('style.dash')), dash.el,
    h('h4', {}, t('style.size')), size.el,
    h('h4', {}, t('style.font')), font.el,
    h('h4', {}, t('style.arrowheads')), heads.el,
    h('h4', {}, t('style.opacity')), opacity,
    h('div', { class: 'row', style: 'margin-top:10px' }, front, back),
    h('div', { class: 'row', style: 'margin-top:6px' }, group, lock),
  );
}

// ------------------------------------------------------------------ bottom left: undo/redo/zoom

function bottomLeft(ed: Editor): HTMLElement {
  const undo = h('button', { class: 'tool', 'data-tip': t('ctl.undo'), 'aria-label': t('ctl.undo'), 'data-testid': 'undo', onclick: () => ed.undo() }, '↶');
  const redo = h('button', { class: 'tool', 'data-tip': t('ctl.redo'), 'aria-label': t('ctl.redo'), 'data-testid': 'redo', onclick: () => ed.redo() }, '↷');
  const pct = h('button', { class: 'zoom-pct', 'data-testid': 'zoom-pct', title: '100%', onclick: () => ed.zoomTo(1) });
  const update = () => {
    pct.textContent = `${Math.round(ed.camera.z * 100)}%`;
    undo.disabled = !ed.doc.canUndo();
    redo.disabled = !ed.doc.canRedo();
  };
  ed.on('camera', update);
  ed.on('doc', update);
  ed.on('history', update);
  ed.doc.undoManager.on('stack-item-added', update);
  ed.doc.undoManager.on('stack-item-popped', update);
  update();
  return h('div', { class: 'panel bottomleft' }, undo, redo, h('div', { class: 'sep' }),
    h('button', { class: 'tool', 'data-tip': t('ctl.zoomOut'), 'aria-label': t('ctl.zoomOut'), 'data-testid': 'zoom-out', onclick: () => ed.zoomBy(-1) }, '−'),
    pct,
    h('button', { class: 'tool', 'data-tip': t('ctl.zoomIn'), 'aria-label': t('ctl.zoomIn'), 'data-testid': 'zoom-in', onclick: () => ed.zoomBy(1) }, '+'),
    h('button', { class: 'tool', 'data-tip': t('ctl.fit'), 'aria-label': t('ctl.fit'), 'data-testid': 'zoom-fit', onclick: () => ed.zoomToFit() }, '⤢'),
  );
}

function minimapPanel(ed: Editor): HTMLElement {
  const panel = h('div', { class: 'panel bottomright', title: t('ctl.minimap') });
  const inner = h('div', { class: 'mini' });
  panel.append(inner);
  new Minimap(ed, inner);
  return panel;
}

// ------------------------------------------------------------------ toolbar

const GEO_ICON_SIZE = 18;
function geoIcon(kind: GeoKind): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('viewBox', `-2 -2 ${GEO_ICON_SIZE + 4} ${GEO_ICON_SIZE + 4}`);
  const pts = geoOutline(kind, GEO_ICON_SIZE, kind.startsWith('arrow-') || kind === 'oval' || kind === 'rhombus' || kind === 'trapezoid' ? GEO_ICON_SIZE * 0.75 : GEO_ICON_SIZE);
  let d = polyPath(pts, true);
  if (kind === 'check-box') d += 'M4 9.5L7.5 13L14 5';
  if (kind === 'x-box') d += 'M4 4L14 14M14 4L4 14';
  svg.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`;
  return svg;
}

function toolbar(ed: Editor): HTMLElement {
  type Item = { id: ToolId; icon: string; key?: string; tip: MessageKey; geo?: GeoKind } | 'sep';
  const items: Item[] = [
    { id: 'select', icon: '⬉', key: 'V', tip: 'tool.select' },
    { id: 'hand', icon: '✋', key: 'H', tip: 'tool.hand' },
    'sep',
    { id: 'draw', icon: '✎', key: 'D', tip: 'tool.draw' },
    { id: 'highlight', icon: '🖍', key: '⇧D', tip: 'tool.highlight' },
    { id: 'eraser', icon: '⌫', key: 'E', tip: 'tool.eraser' },
    'sep',
    { id: 'arrow', icon: '↗', key: 'A', tip: 'tool.arrow' },
    { id: 'line', icon: '╱', key: 'L', tip: 'tool.line' },
    { id: 'text', icon: 'T', key: 'T', tip: 'tool.text' },
    { id: 'note', icon: '🗒', key: 'N', tip: 'tool.note' },
    'sep',
    { id: 'geo', icon: '▭', key: 'R', tip: 'tool.rectangle', geo: 'rectangle' },
    { id: 'geo', icon: '◯', key: 'O', tip: 'tool.ellipse', geo: 'ellipse' },
  ];
  const bar = h('div', { class: 'panel toolbar', role: 'toolbar', 'data-testid': 'toolbar' });
  const buttons: { b: HTMLButtonElement; item: Exclude<Item, 'sep'> }[] = [];
  const add = (item: Item) => {
    if (item === 'sep') {
      bar.append(h('div', { class: 'sep' }));
      return;
    }
    const b = h('button', {
      class: 'tool', 'data-tip': t(item.tip), 'aria-label': t(item.tip),
      'data-testid': `tool-${item.geo ?? item.id}`,
      onclick: () => (item.geo ? ed.setGeo(item.geo) : ed.setTool(item.id)),
    }, item.icon, item.key ? h('span', { class: 'k' }, item.key) : null);
    buttons.push({ b, item });
    bar.append(b);
  };
  items.forEach(add);
  // more shapes
  const more = h('button', { class: 'tool', id: 'more-shapes', 'data-tip': t('tool.more'), 'aria-label': t('tool.more'), 'data-testid': 'tool-more' }, '◇▾');
  const pop = h('div', { class: 'popover up geo-grid', 'data-owner': 'more-shapes', 'data-testid': 'geo-menu' });
  for (const k of GEO_KINDS) {
    if (k === 'rectangle' || k === 'ellipse') continue;
    pop.append(h('button', { class: 'tool', title: t(`geo.${k}` as MessageKey), 'aria-label': t(`geo.${k}` as MessageKey), 'data-testid': `geo-${k}`, onclick: () => { ed.setGeo(k); pop.classList.remove('open'); } }, geoIcon(k)));
  }
  more.addEventListener('click', () => pop.classList.toggle('open'));
  bar.append(h('span', { class: 'anchor' }, more, pop));
  add({ id: 'frame', icon: '⬚', key: 'F', tip: 'tool.frame' });
  bar.append(h('div', { class: 'sep' }));
  add({ id: 'image', icon: '🖼', tip: 'tool.image' });
  add({ id: 'laser', icon: '✦', key: 'K', tip: 'tool.laser' });

  const sync = () => {
    for (const { b, item } of buttons) {
      const on = item.geo ? ed.tool === 'geo' && ed.geoKind === item.geo : ed.tool === item.id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const moreOn = ed.tool === 'geo' && ed.geoKind !== 'rectangle' && ed.geoKind !== 'ellipse';
    more.classList.toggle('on', moreOn);
    if (moreOn) {
      clear(more);
      more.append(geoIcon(ed.geoKind), '▾');
    } else if (more.textContent !== '◇▾') {
      clear(more);
      more.append('◇▾');
    }
  };
  ed.on('tool', sync);
  sync();
  return bar;
}

// ------------------------------------------------------------------ banner: presenting / following / notices

function banner(ed: Editor): HTMLElement {
  const el = h('div', { class: 'banner', 'data-testid': 'banner' });
  const update = () => {
    clear(el);
    let text = '';
    if (ed.notice) text = t(`app.notice.${ed.notice.kind}` as MessageKey);
    else if (ed.status === 'closed') text = t('app.notice.closed', { code: ed.conn?.closeCode ?? 0 });
    else if (ed.followingUserId) {
      const pres = ed.presenterName();
      const u = displayUser((x) => ed.doc.user(x), ed.followingUserId);
      const name = (ed.conn && peers(ed.conn.awareness).find((p) => p.state.user?.id === ed.followingUserId)?.state.user?.name) || u.name;
      text = pres && pres === name ? t('app.presenting', { name: shortName(name) }) : t('app.following', { name: shortName(name) });
      el.append(text, ' ', h('button', { class: 'btn small', onclick: () => ed.stopFollowing() }, t('app.follow.stop')));
      el.classList.add('show');
      return;
    }
    el.textContent = text;
    el.classList.toggle('show', !!text);
  };
  ed.on('follow', update);
  ed.on('notice', update);
  ed.on('status', update);
  ed.on('presence', update);
  update();
  return el;
}
