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
 *     its own, as the plain artifact does.
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
    if (location.ancestorOrigins && location.ancestorOrigins.length) target = location.ancestorOrigins[0];
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
    post({ type: 'size', w: w, h: h });
  }

  function reportTitle() {
    if (document.title) post({ type: 'title', title: String(document.title).slice(0, 200) });
  }

  // The canvas lays the page out at its full height and pans it: the page itself must not scroll.
  // In native mode (canvas hidden) the page scrolls as the plain artifact does.
  var noScroll = document.createElement('style');
  noScroll.textContent = 'html,body{overflow:hidden !important;scrollbar-width:none}';
  var native = false;
  var started = false;

  function setNative(on) {
    native = !!on;
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
    setInterval(function () { reportSize(); checkBg(); }, 1000);
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
