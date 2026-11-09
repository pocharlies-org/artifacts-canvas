/*
 * artifacts-canvas reporter. Injected by the server at the top of the artifact HTML that is
 * served to the canvas iframe (see docs/protocol.md "Frame"). It runs INSIDE the artifact's
 * sandboxed, opaque-origin iframe and only:
 *   - posts the content size and title to the parent (the canvas wrapper),
 *   - turns internal scrolling (anchor links) into a pan request for the parent,
 *   - renders a PNG snapshot of the page on the parent's request (export).
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

  function start() {
    var style = document.createElement('style');
    style.textContent = 'html,body{overflow:hidden !important;scrollbar-width:none}';
    (document.head || document.documentElement).appendChild(style);
    reportTitle();
    reportSize();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(reportSize);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    if (window.MutationObserver) new MutationObserver(reportSize).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setInterval(reportSize, 1000);
  }

  window.addEventListener('scroll', function () {
    var x = window.scrollX || 0;
    var y = window.scrollY || 0;
    if (x || y) {
      post({ type: 'scroll', x: x, y: y });
      window.scrollTo(0, 0);
    }
  });

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
    loadLib(lib).then(function (H) {
      return H.toCanvas(root, {
        width: fullW,
        height: fullH,
        pixelRatio: scale,
        skipFonts: true,
        cacheBust: false,
        backgroundColor: '#ffffff',
        filter: function (node) { return !(node.tagName === 'SCRIPT'); },
      });
    }).then(function (full) {
      var x = Math.max(0, Number(r.x) || 0);
      var y = Math.max(0, Number(r.y) || 0);
      var w = Math.max(1, Math.min(Number(r.w) || fullW, fullW - x));
      var h = Math.max(1, Math.min(Number(r.h) || fullH, fullH - y));
      var out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w * scale));
      out.height = Math.max(1, Math.round(h * scale));
      out.getContext('2d').drawImage(full, x * scale, y * scale, w * scale, h * scale, 0, 0, out.width, out.height);
      post({ type: 'snapshot', id: d.id, dataUrl: out.toDataURL('image/png') });
    }).catch(function () {
      post({ type: 'snapshot', id: d.id, dataUrl: null });
    });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.addEventListener('load', function () { reportTitle(); reportSize(); });
})();
