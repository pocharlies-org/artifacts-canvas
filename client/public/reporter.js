/*
 * artifacts-canvas reporter. Injected by the server at the top of the artifact HTML that is
 * served to the canvas iframe (see docs/protocol.md "Frame"). It runs INSIDE the artifact's
 * sandboxed, opaque-origin iframe and only:
 *   - posts the content size and title to the parent (the canvas wrapper),
 *   - turns internal scrolling (anchor links) into a pan request for the parent,
 *   - renders a PNG snapshot of the page on the parent's request (export), and says whether
 *     part of it could not be captured (an image or a background that did not load),
 *   - when the page takes the pointer (the canvas's interact tool): stops the frame from
 *     navigating on a link click and tells the parent which URL was clicked (the parent decides
 *     what opens: docs/protocol.md §3 "Links"), scrolls to same-document anchors through the
 *     parent, and hands the parent the wheel that no element of the page scrolls,
 *   - on the parent's request, says whether there is a link under a point, or follows it,
 *   - posts the page's background colour (html, else body, else white) when it changes, so the
 *     canvas board can follow it (a theme toggle included),
 *   - in "native" mode (the canvas hidden: the page is shown as itself) lets the page scroll on
 *     its own, as the plain artifact does,
 *   - in canvas mode, resolves the page's `vh`-family lengths against a fixed reference screen
 *     (the frame's width, 16:9) instead of the page's own height, and lets an
 *     IntersectionObserver report the whole page as in view (sections that a script reveals on
 *     scroll): the whole page is on the board.
 * It reads no cookies or storage (it has none) and sends nothing anywhere else.
 * Copyright 2026 Daniel Ibáñez. Licensed under the Apache License, Version 2.0.
 */
(function () {
  'use strict';
  if (window.__artifactsCanvasReporter) return;
  window.__artifactsCanvasReporter = true;
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  var SOURCE = 'artifacts-canvas-reporter';
  var target = '*';
  try {
    // The parent's origin where the browser says it. Firefox masks it as "null" (the frame's
    // no-referrer policy), and postMessage throws on "null": every message was dropped there.
    var ao = location.ancestorOrigins;
    if (ao && ao.length && /^https?:\/\/[^/]+$/.test(String(ao[0]))) target = String(ao[0]);
  } catch (e) { /* ignore */ }

  function post(msg) {
    msg.source = SOURCE;
    try { parentWin.postMessage(msg, target); } catch (e) { /* ignore */ }
  }

  var lastH = -1;
  function reportSize() {
    var d = document.documentElement;
    var b = document.body;
    var h = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0, d ? d.offsetHeight : 0);
    var w = Math.max(d ? d.scrollWidth : 0, b ? b.scrollWidth : 0);
    if (Math.abs(h - lastH) < 1) return;
    lastH = h;
    // the mode it was measured in: the wrapper drops a size of the other mode (a mode change on its way)
    post({ type: 'size', w: w, h: h, native: native });
  }

  function reportTitle() {
    if (document.title) post({ type: 'title', title: String(document.title).slice(0, 200) });
  }

  // The canvas lays the page out at its full height and pans it: the page itself must not scroll.
  // In native mode (canvas hidden) the page scrolls as the plain artifact does. Scroll snapping
  // on the root is off too: a "deck" of full-screen sections asks for it, and the browser would
  // re-snap the (unscrollable) page after every layout change, which the reporter would then
  // pass on to the camera as a pan.
  var noScroll = document.createElement('style');
  noScroll.textContent = 'html,body{overflow:hidden !important;scrollbar-width:none;scroll-snap-type:none !important}';
  var native = false;
  var started = false;

  // ---- viewport units (docs/protocol.md §3 "Viewport units and reveal scripts") ----
  // In canvas mode the frame is as tall as the page, so `vh` would be a share of the page's own
  // height: a section of `min-height:100vh` (or a font sized from `vh`) grows with the page, which
  // grows with it, and so on. In canvas mode every `vh`-family length (vh, svh, lvh, dvh, and
  // vmin/vmax, which depend on it) is resolved against a reference screen instead: as wide as the
  // frame (the room's pageWidth, the same for every participant) and 9/16 of that high, a 16:9
  // screen. Every viewer, presenter and followers alike, gets the same layout. `vw` is left alone:
  // it already follows the frame's width. The page's own CSS is rewritten once, in place:
  // `100vh` becomes `calc(100 * var(--artifacts-canvas-vh, 1vh))`. The variables are set on
  // <html> in canvas mode and removed in native mode, where the fallback gives the real unit back.
  // Covered: the page's <style> sheets (rules inside @media, @supports, @layer, @container,
  // nesting, @keyframes, @import), constructed and adopted sheets, rules added later (a new
  // <style>, insertRule, replace/replaceSync, a stylesheet <link> once loaded) and inline `style`
  // attributes, as they are set. Not covered: a stylesheet loaded with <link> (from this opaque
  // origin every such file is another origin, its rules cannot be read; only a data: URL can),
  // media queries on the height, the vb family, and `innerHeight` in scripts. The page's scripts
  // read the rewritten form back (`el.style.height` is the calc() form).
  var UNIT_VAR = '--artifacts-canvas-';
  var UNIT_RE = /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|url\(\s*(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|[^)]*)\s*\)|var\(\s*--artifacts-canvas-v[a-z]+\s*,[^)]*\))|(^|[^\w.\-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)((?:s|l|d)?v(?:h|min|max))(?![\w-])/gi;
  var UNIT_QUICK = /\d[sld]?v(?:h|min|max)/i;

  /** The CSS text with every vh-family length turned into the variable form (strings and url() untouched). */
  function rewriteUnits(text) {
    return text.replace(UNIT_RE, function (m, skip, pre, num, unit) {
      if (skip !== undefined) return m;
      var u = unit.toLowerCase();
      var kind = /min$/.test(u) ? 'vmin' : /max$/.test(u) ? 'vmax' : 'vh';
      return pre + 'calc(' + num + ' * var(' + UNIT_VAR + kind + ', 1' + u + '))';
    });
  }

  /** One declaration rewritten in place, with its priority; nothing else of the block is touched. */
  function fixProp(style, prop) {
    var v = style.getPropertyValue(prop);
    if (!v || !UNIT_QUICK.test(v)) return;
    var n = rewriteUnits(v);
    if (n !== v) style.setProperty(prop, n, style.getPropertyPriority(prop));
  }

  /**
   * Rewrite a declaration block declaration by declaration. Never by assigning cssText back: a
   * shorthand set from var() and overridden by one of its longhands serialises its other longhands
   * as empty ("pending substitution"), and assigning that text drops the shorthand for good.
   */
  function fixDecl(style) {
    if (!style) return;
    var t = style.cssText;
    if (!t || !UNIT_QUICK.test(t)) return;
    var props = [];
    for (var i = 0; i < style.length; i++) props.push(style[i]);
    for (var j = 0; j < props.length; j++) fixProp(style, props[j]);
    // a unit inside a shorthand set from var(): its longhands read empty, only the shorthand has it
    t = style.cssText;
    if (rewriteUnits(t) === t) return;
    var re = /(?:^|;)\s*(--[\w-]+|-?[a-zA-Z][\w-]*)\s*:/g;
    var m;
    while ((m = re.exec(t))) if (props.indexOf(m[1]) < 0) fixProp(style, m[1]);
  }

  function fixRules(rules, depth) {
    if (!rules || depth > 32) return;
    for (var i = 0; i < rules.length; i++) fixRule(rules[i], depth);
  }

  function fixRule(r, depth) {
    if (!r) return;
    try {
      if (r.style) fixDecl(r.style);
      if (r.cssRules) fixRules(r.cssRules, (depth || 0) + 1);
      if (r.styleSheet) fixSheet(r.styleSheet, (depth || 0) + 1);
    } catch (e) { /* ignore */ }
  }

  function fixSheet(sheet, depth) {
    if (!sheet) return;
    var rules;
    try { rules = sheet.cssRules; } catch (e) { return; } // another origin: not readable from here
    fixRules(rules, depth || 0);
  }

  var sheetCount = -1;
  function fixAllSheets() {
    var list = document.styleSheets || [];
    sheetCount = list.length;
    for (var i = 0; i < list.length; i++) fixSheet(list[i], 0);
    var adopted = document.adoptedStyleSheets;
    if (adopted) for (var j = 0; j < adopted.length; j++) fixSheet(adopted[j], 0);
  }

  function isStyle(n) { return n && n.nodeType === 1 && String(n.localName).toLowerCase() === 'style'; }
  function isSheetLink(n) {
    return n && n.nodeType === 1 && String(n.localName).toLowerCase() === 'link' && /(^|\s)stylesheet(\s|$)/i.test(n.getAttribute('rel') || '');
  }

  var linksSeen = typeof WeakSet === 'function' ? new WeakSet() : null;
  function fixElement(n) {
    if (isStyle(n)) fixSheet(n.sheet, 0);
    else if (isSheetLink(n)) {
      if (n.sheet) fixSheet(n.sheet, 0);
      if (linksSeen && !linksSeen.has(n)) {
        linksSeen.add(n);
        n.addEventListener('load', function () { fixSheet(n.sheet, 0); });
      }
    }
    if (n.style && n.hasAttribute && n.hasAttribute('style')) fixDecl(n.style);
  }

  function fixTree(n) {
    if (!n || n.nodeType !== 1) return;
    fixElement(n);
    if (!n.querySelectorAll) return;
    var all = n.querySelectorAll('style,link,[style]');
    for (var i = 0; i < all.length; i++) fixElement(all[i]);
  }

  var docEl = document.documentElement;
  function setUnitVar(name, value) {
    if (docEl.style.getPropertyValue(name) !== value) docEl.style.setProperty(name, value);
  }
  /** The reference screen's units on <html> (canvas mode), or none (native mode: the real units). */
  function applyUnits() {
    if (!docEl || !docEl.style) return;
    var w = window.innerWidth || docEl.clientWidth || 0;
    if (native || !(w > 0)) {
      ['vh', 'vmin', 'vmax'].forEach(function (k) { docEl.style.removeProperty(UNIT_VAR + k); });
      return;
    }
    var h = (w * 9) / 16;
    var px = function (v) { return Math.round(v * 10000) / 10000 + 'px'; };
    setUnitVar(UNIT_VAR + 'vh', px(h / 100));
    setUnitVar(UNIT_VAR + 'vmin', px(Math.min(w, h) / 100));
    setUnitVar(UNIT_VAR + 'vmax', px(Math.max(w, h) / 100));
  }

  function onStyleMutations(list) {
    var changed = []; // <style> elements whose text changed: each sheet is walked once per batch
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var t = r.target;
      if (r.type === 'attributes') {
        if (t === docEl) applyUnits(); // the page rewrote <html style>: put the variables back
        if (t.style && UNIT_QUICK.test(t.getAttribute('style') || '')) fixDecl(t.style);
        continue;
      }
      // text of a <style> changed (characterData on its text, or a child added/removed)
      var host = t && t.nodeType === 3 ? t.parentNode : t;
      if (isStyle(host) && changed.indexOf(host) < 0) changed.push(host);
      if (r.type === 'childList') for (var j = 0; j < r.addedNodes.length; j++) fixTree(r.addedNodes[j]);
    }
    for (var k = 0; k < changed.length; k++) fixSheet(changed[k].sheet, 0);
  }

  function wrapAfter(proto, name, after) {
    if (!proto || typeof proto[name] !== 'function') return;
    var orig = proto[name];
    proto[name] = function () {
      var out = orig.apply(this, arguments);
      try { after(this, out); } catch (e) { /* ignore */ }
      return out;
    };
  }

  function installUnits() {
    applyUnits();
    window.addEventListener('resize', applyUnits);
    // CSS-in-JS libraries add rules through the CSSOM, which no mutation reports
    var inserted = function (owner, index) {
      var rules = owner.cssRules;
      if (rules && typeof index === 'number') fixRule(rules[index], 0);
    };
    wrapAfter(window.CSSStyleSheet && CSSStyleSheet.prototype, 'insertRule', inserted);
    wrapAfter(window.CSSGroupingRule && CSSGroupingRule.prototype, 'insertRule', inserted);
    wrapAfter(window.CSSKeyframesRule && CSSKeyframesRule.prototype, 'appendRule', function (owner) {
      fixRule(owner.cssRules[owner.cssRules.length - 1], 0);
    });
    wrapAfter(window.CSSStyleSheet && CSSStyleSheet.prototype, 'replaceSync', function (sheet) { fixSheet(sheet, 0); });
    // replace(): the page gets a promise that settles as the browser's does (a rejection stays the
    // page's to handle), once the new rules are rewritten
    var CSS = window.CSSStyleSheet && CSSStyleSheet.prototype;
    if (CSS && typeof CSS.replace === 'function') {
      var origReplace = CSS.replace;
      CSS.replace = function () {
        var sheet = this;
        var p = origReplace.apply(this, arguments);
        return p && typeof p.then === 'function' ? p.then(function (r) { fixSheet(sheet, 0); return r; }) : p;
      };
    }
    if (window.MutationObserver && docEl) {
      // installed before the page's own markup is parsed: each <style> is rewritten before the
      // next script of the page runs (the parser delivers mutations before it runs a script)
      new MutationObserver(onStyleMutations).observe(docEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
    }
    fixTree(docEl);
  }

  // ---- reveal scripts: IntersectionObserver (docs/protocol.md §3) ----
  // Pages that fade their sections in as they scroll into view hide them until an
  // IntersectionObserver reports them. In the canvas the frame is a cross-origin child of a
  // transformed board: with the implicit root the browser measures each section against the
  // wrapper's viewport, so most of the page never "intersects", and it stays hidden on the board,
  // in exports and for followers. In canvas mode the whole page is on the board, so an observer
  // with the implicit root reports every target as fully intersecting as soon as it is observed.
  // In native mode (canvas hidden) the page scrolls as itself and the browser's own observer
  // reports, re-observing every target so the page gets the real state at once. An observer with
  // an explicit root (an element or the document) measures inside the page, so it is the browser's.
  // The browser's constructor stays here, in the reporter; the page sees the stand-in.
  var RealIO = window.IntersectionObserver;
  var ioLive = [];
  var ioState = typeof WeakMap === 'function' ? new WeakMap() : null;

  function rectOf(x, y, w, h) {
    try { return new DOMRectReadOnly(x, y, w, h); } catch (e) { return { x: x, y: y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h }; }
  }

  function fullEntry(target) {
    var b = target.getBoundingClientRect();
    var proto = window.IntersectionObserverEntry && IntersectionObserverEntry.prototype;
    var e = Object.create(proto || Object.prototype);
    var fields = {
      time: window.performance && performance.now ? performance.now() : Date.now(),
      target: target,
      rootBounds: rectOf(0, 0, window.innerWidth || 0, window.innerHeight || 0),
      boundingClientRect: b,
      intersectionRect: b,
      isIntersecting: true,
      isVisible: true,
      intersectionRatio: 1,
    };
    for (var k in fields) Object.defineProperty(e, k, { value: fields[k], enumerable: true });
    return e;
  }

  function ioFlush(s) {
    s.scheduled = false;
    if (native || !s.queue.size) {
      s.queue.clear();
      return;
    }
    var entries = Array.from(s.queue, fullEntry);
    s.queue.forEach(function (t) { s.reported.add(t); });
    s.queue.clear();
    try { s.callback.call(s.self, entries, s.self); } catch (err) {
      setTimeout(function () { throw err; }); // reported like an error in a real observer's callback
    }
  }

  /**
   * Report `target` in view, once per canvas-mode period: a callback that observes its target again
   * (an infinite-scroll sentinel) would otherwise be told again at once, for ever. Delivered after
   * the current task, as the browser's observer does after a rendering step.
   */
  function ioQueue(s, target) {
    if (s.reported.has(target)) return;
    s.queue.add(target);
    if (s.scheduled) return;
    s.scheduled = true;
    setTimeout(function () { ioFlush(s); }, 0);
  }

  /** Mode changed: canvas mode reports every target again; native mode re-observes for the real state. */
  function ioMode() {
    ioLive.forEach(function (s) {
      if (native) {
        s.queue.clear();
        s.targets.forEach(function (t) { s.real.unobserve(t); s.real.observe(t); });
      } else {
        s.reported = new WeakSet(); // a new canvas-mode period: every target is reported once more
        s.targets.forEach(function (t) { ioQueue(s, t); });
      }
    });
  }

  function installIO() {
    if (typeof RealIO !== 'function' || !ioState || typeof Set !== 'function' || typeof WeakSet !== 'function') return;
    var stateOf = function (o) {
      var s = ioState.get(o);
      if (!s) throw new TypeError('Illegal invocation');
      return s;
    };
    var IntersectionObserver = function IntersectionObserver(callback, options) {
      if (!(this instanceof IntersectionObserver)) throw new TypeError("Failed to construct 'IntersectionObserver': Please use the 'new' operator.");
      if (typeof callback !== 'function') throw new TypeError("Failed to construct 'IntersectionObserver': The callback provided as parameter 1 is not a function.");
      // an explicit root: the geometry is inside the page, the browser's observer is right
      if (options && options.root) return new RealIO(callback, options);
      var self = this;
      // targets in the order observed; queue: observed, not reported yet
      var s = { self: self, callback: callback, targets: new Set(), queue: new Set(), reported: new WeakSet(), scheduled: false, real: null };
      s.real = new RealIO(function (entries) {
        if (native) callback.call(self, entries, self);
      }, options);
      ioState.set(self, s);
    };
    // the live list (mode changes) holds an observer only while it observes something
    var unlist = function (s) {
      var i = ioLive.indexOf(s);
      if (i >= 0) ioLive.splice(i, 1);
    };
    var P = IntersectionObserver.prototype;
    P.observe = function (target) {
      var s = stateOf(this);
      s.real.observe(target); // throws as the browser does for a target that is not an Element
      if (s.targets.has(target)) return;
      s.targets.add(target);
      if (s.targets.size === 1) ioLive.push(s);
      if (!native) ioQueue(s, target);
    };
    P.unobserve = function (target) {
      var s = stateOf(this);
      s.real.unobserve(target);
      if (s.targets.delete(target) && !s.targets.size) unlist(s);
      s.queue.delete(target);
    };
    P.disconnect = function () {
      var s = stateOf(this);
      s.real.disconnect();
      s.targets.clear();
      s.queue.clear();
      unlist(s);
    };
    P.takeRecords = function () {
      var s = stateOf(this);
      var real = s.real.takeRecords();
      if (native) return real;
      var out = Array.from(s.queue, fullEntry);
      s.queue.forEach(function (t) { s.reported.add(t); });
      s.queue.clear();
      return out;
    };
    ['root', 'rootMargin', 'thresholds', 'scrollMargin', 'delay', 'trackVisibility'].forEach(function (k) {
      if (!(k in RealIO.prototype)) return;
      Object.defineProperty(P, k, {
        configurable: true,
        enumerable: true,
        get: function () { return stateOf(this).real[k]; },
      });
    });
    try { Object.defineProperty(P, Symbol.toStringTag, { value: 'IntersectionObserver', configurable: true }); } catch (e) { /* ignore */ }
    window.IntersectionObserver = IntersectionObserver;
  }

  try { installIO(); } catch (e) { /* the page keeps the browser's observer */ }
  try { installUnits(); } catch (e) { /* the page keeps the real units */ }

  function setNative(on) {
    var was = native;
    native = !!on;
    if (was !== native) {
      try { applyUnits(); } catch (e) { /* ignore */ }
      try { ioMode(); } catch (e) { /* ignore */ }
    }
    if (!started) return;
    if (native) {
      if (noScroll.parentNode) noScroll.parentNode.removeChild(noScroll);
    } else if (!noScroll.parentNode) {
      (document.head || document.documentElement).appendChild(noScroll);
      window.scrollTo(0, 0);
    }
    lastH = -1;
    reportSize();
  }

  function start() {
    started = true;
    if (!native) (document.head || document.documentElement).appendChild(noScroll);
    try { fixAllSheets(); } catch (e) { /* ignore */ }
    reportTitle();
    reportSize();
    checkBg();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(reportSize);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    if (window.MutationObserver) {
      new MutationObserver(function () { reportSize(); checkBg(); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    }
    try {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', checkBg);
      else if (mq.addListener) mq.addListener(checkBg);
    } catch (e) { /* ignore */ }
    // also catches a background that changes by a CSS transition or a late stylesheet
    setInterval(function () {
      // a sheet no mutation reported (the count is cheap; the scan runs only when it moved)
      try { if ((document.styleSheets || []).length !== sheetCount) fixAllSheets(); } catch (e) { /* ignore */ }
      reportSize();
      checkBg();
    }, 1000);
  }

  // ---- background colour: html's, else body's, else white; posted only when it changes ----
  var lastBg = null;
  var bgTimer = 0;
  var bgAt = 0;
  var BG_EVERY = 250; // at most 4 checks a second
  function clear(c) {
    return !c || c === 'transparent' || /^rgba\(.*,\s*0(\.0+)?\s*\)$/.test(c) || /\/\s*0(\.0+)?%?\s*\)$/.test(c);
  }
  /** A colour in rgb()/rgba() (what computed styles give); other forms go through a 1x1 canvas. */
  function rgbOf(c) {
    if (/^rgba?\(/.test(c)) return c;
    try {
      var cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      var g = cv.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillStyle = c;
      g.fillRect(0, 0, 1, 1);
      var d = g.getImageData(0, 0, 1, 1).data;
      return 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + Math.round((d[3] / 255) * 1000) / 1000 + ')';
    } catch (e) {
      return 'rgb(255, 255, 255)';
    }
  }
  function effectiveBg() {
    var c = '';
    try {
      c = window.getComputedStyle(document.documentElement).backgroundColor;
      if (clear(c) && document.body) c = window.getComputedStyle(document.body).backgroundColor;
    } catch (e) { c = ''; }
    return clear(c) ? 'rgb(255, 255, 255)' : rgbOf(c);
  }
  function checkBg() {
    if (bgTimer) return;
    var wait = Math.max(0, bgAt + BG_EVERY - Date.now());
    bgTimer = setTimeout(function () {
      bgTimer = 0;
      bgAt = Date.now();
      var c = effectiveBg();
      if (c !== lastBg) {
        lastBg = c;
        post({ type: 'bg', color: c.slice(0, 64) });
      }
    }, wait);
  }

  window.addEventListener('scroll', function () {
    if (native) return; // the page scrolls itself
    var x = window.scrollX || 0;
    var y = window.scrollY || 0;
    if (x || y) {
      post({ type: 'scroll', x: x, y: y });
      window.scrollTo(0, 0);
    }
  });

  // A 1x1 transparent PNG. It stands in for an image the snapshot cannot read: without it, one
  // image that failed to load (a relative image of a gated artifact, a dead link) made
  // html-to-image reject, and the export came out with no artifact at all.
  var PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
  // Resources of this page a snapshot could not read. Kept across snapshots: html-to-image caches
  // the placeholder it used, so a later snapshot does not fetch (or fail) the same URL again.
  var missed = 0;

  /** Images of the page that are broken in the page itself (they render as nothing in a snapshot). */
  function brokenImages() {
    var n = 0;
    var imgs = document.images || [];
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if ((im.currentSrc || im.getAttribute('src')) && im.complete && im.naturalWidth === 0) n++;
    }
    return n;
  }

  /** window.fetch that counts the requests that fail, for the time of one snapshot. */
  function countingFetch(real) {
    return function () {
      return real.apply(this, arguments).then(function (res) {
        if (!res || !res.ok) missed++;
        return res;
      }, function (err) {
        missed++;
        throw err;
      });
    };
  }

  /** An image the snapshot could not decode: count it and put the placeholder in its place. */
  function onImageError(ev) {
    missed++;
    var t = ev && ev.target;
    if (!t) return;
    try {
      if (t.href && t.href.baseVal !== undefined) t.href.baseVal = PLACEHOLDER;
      else if (t.src !== PLACEHOLDER) t.src = PLACEHOLDER;
    } catch (e) { /* ignore */ }
  }

  var libPromise = null;
  function loadLib(url) {
    if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
    if (libPromise) return libPromise;
    libPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { window.htmlToImage ? resolve(window.htmlToImage) : reject(new Error('html-to-image missing')); };
      s.onerror = function () { reject(new Error('cannot load ' + url)); };
      (document.head || document.documentElement).appendChild(s);
    });
    return libPromise;
  }

  // Snapshot: render the whole page (SVG foreignObject via html-to-image; it needs no extra
  // iframe, so it works inside this opaque-origin sandbox), then crop the requested rectangle.
  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var d = e.data;
    if (!d || d.source !== 'artifacts-canvas' || d.type !== 'snapshot') return;
    var r = d.rect || {};
    var lib = String(d.lib || '');
    if (!/^(https?:)?\/\//.test(lib) && lib.charAt(0) !== '/') lib = '';
    var root = document.documentElement;
    var fullW = Math.max(root.scrollWidth, 1);
    var fullH = Math.max(root.scrollHeight, 1);
    var scale = Math.max(0.1, Math.min(4, Number(d.scale) || 1, 16000 / fullH, 16000 / fullW));
    var broken = brokenImages();
    var realFetch = window.fetch;
    var restore = function () {
      if (realFetch && window.fetch !== realFetch) window.fetch = realFetch;
    };
    loadLib(lib).then(function (H) {
      if (realFetch) window.fetch = countingFetch(realFetch);
      return H.toCanvas(root, {
        width: fullW,
        height: fullH,
        pixelRatio: scale,
        skipFonts: true,
        cacheBust: false,
        // the page's own background: html-to-image paints this over the root, so a fixed white
        // turned a dark page white in the export (and hid what was drawn light on it)
        backgroundColor: effectiveBg(),
        imagePlaceholder: PLACEHOLDER,
        onImageErrorHandler: onImageError,
        filter: function (node) { return !(node.tagName === 'SCRIPT'); },
      });
    }).then(function (full) {
      restore();
      var x = Math.max(0, Number(r.x) || 0);
      var y = Math.max(0, Number(r.y) || 0);
      var w = Math.max(1, Math.min(Number(r.w) || fullW, fullW - x));
      var h = Math.max(1, Math.min(Number(r.h) || fullH, fullH - y));
      var out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w * scale));
      out.height = Math.max(1, Math.round(h * scale));
      out.getContext('2d').drawImage(full, x * scale, y * scale, w * scale, h * scale, 0, 0, out.width, out.height);
      post({ type: 'snapshot', id: d.id, dataUrl: out.toDataURL('image/png'), partial: broken > 0 || missed > 0 });
    }).catch(function () {
      restore();
      post({ type: 'snapshot', id: d.id, dataUrl: null });
    });
  });

  // ---- links, anchors, wheel and Escape (docs/protocol.md §3 "Links") ----
  var MAX_LINK = 4096;

  /** The link (<a href>, <area href>, SVG <a>) at or around `node`, or null. */
  function linkOf(node) {
    for (var n = node; n && n.nodeType !== 9; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      var tag = String(n.localName || '').toLowerCase();
      if (tag !== 'a' && tag !== 'area') continue;
      var raw = n.getAttribute('href');
      if (raw === null && n.getAttributeNS) raw = n.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (raw === null) return null;
      var url;
      try { url = new URL(raw, document.baseURI); } catch (e) { return { el: n, url: null }; }
      return { el: n, url: url };
    }
    return null;
  }

  /** The URL of this document without its fragment. */
  function base(u) {
    var i = u.indexOf('#');
    return i < 0 ? u : u.slice(0, i);
  }

  /** Position (document px) of the target of `#hash`, or null; '#' and '#top' are the top. */
  function anchorTarget(hash) {
    var id = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    try { id = decodeURIComponent(id); } catch (e) { /* keep it */ }
    var el = id ? document.getElementById(id) : null;
    if (!el && id) {
      var named = document.getElementsByName(id);
      for (var i = 0; i < named.length; i++) if (String(named[i].localName).toLowerCase() === 'a') { el = named[i]; break; }
    }
    if (el) {
      var r = el.getBoundingClientRect();
      return { x: r.left + (window.scrollX || 0), y: r.top + (window.scrollY || 0) };
    }
    if (!id || id.toLowerCase() === 'top') return { x: 0, y: 0 };
    return null;
  }

  /**
   * A click on link `ln`. Returns true when the reporter took it over (the frame must not
   * navigate): a same-document anchor scrolls through the parent, every other URL goes to the
   * parent as a `link` message. `javascript:` links stay with the page's own script.
   */
  function follow(ln, newTab) {
    if (!ln.url) return true; // an unparsable href: nothing opens
    var href = ln.url.href;
    if (ln.url.protocol === 'javascript:') return false;
    if ((ln.url.protocol === 'http:' || ln.url.protocol === 'https:') && href.indexOf('#') >= 0 && base(href) === base(location.href) && !newTab) {
      if (native) return false; // the page scrolls to it itself
      var p = anchorTarget(ln.url.hash || '#');
      if (p) post({ type: 'anchor', x: p.x, y: p.y });
      return true;
    }
    post({ type: 'link', href: href.length <= MAX_LINK ? href : '', newTab: !!newTab });
    return true;
  }

  function wantsNewTab(e, ln) {
    var target = ln && ln.el.getAttribute ? String(ln.el.getAttribute('target') || '').toLowerCase() : '';
    return !!(e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1 || (target && target !== '_self' && target !== '_top' && target !== '_parent'));
  }

  function onClick(e) {
    if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return; // the page handled it
    var ln = linkOf(e.target);
    if (ln && follow(ln, wantsNewTab(e, ln))) e.preventDefault();
  }
  window.addEventListener('click', onClick);
  window.addEventListener('auxclick', onClick);

  /** Can `node` or an element around it scroll by (dx, dy)? Then the wheel is the page's own. */
  function scrollsInside(node, dx, dy) {
    for (var n = node; n && n.nodeType === 1 && n !== document.documentElement && n !== document.body; n = n.parentNode) {
      var cs = window.getComputedStyle(n);
      if (dy && /(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        if ((dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1) || (dy < 0 && n.scrollTop > 0)) return true;
      }
      if (dx && /(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) {
        if ((dx > 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1) || (dx < 0 && n.scrollLeft > 0)) return true;
      }
    }
    return false;
  }

  window.addEventListener('wheel', function (e) {
    if (native || e.defaultPrevented) return; // the page scrolls itself, or its own widget took it
    var zoom = e.ctrlKey || e.metaKey;
    if (!zoom && scrollsInside(e.target, e.deltaX, e.deltaY)) return;
    e.preventDefault();
    post({ type: 'wheel', dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, zoom: zoom, shift: e.shiftKey, x: e.clientX + (window.scrollX || 0), y: e.clientY + (window.scrollY || 0) });
  }, { passive: false });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.defaultPrevented) post({ type: 'key', key: 'Escape' });
  });

  // The parent's select tool: a link under a point (probe), and following it (click).
  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var d = e.data;
    if (d && d.source === 'artifacts-canvas' && d.type === 'mode') {
      setNative(d.native === true);
      return;
    }
    if (!d || d.source !== 'artifacts-canvas' || (d.type !== 'probe' && d.type !== 'click')) return;
    var x = Number(d.x);
    var y = Number(d.y);
    var ln = isFinite(x) && isFinite(y) ? linkOf(document.elementFromPoint(x - (window.scrollX || 0), y - (window.scrollY || 0))) : null;
    if (d.type === 'probe') {
      post({ type: 'probe', id: String(d.id || '').slice(0, 32), link: !!(ln && ln.url && ln.url.protocol !== 'javascript:') });
      return;
    }
    if (ln) follow(ln, d.newTab === true);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.addEventListener('load', function () { reportTitle(); reportSize(); checkBg(); });
})();
