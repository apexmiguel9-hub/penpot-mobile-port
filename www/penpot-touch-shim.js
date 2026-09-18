/*
 * penpot-touch-shim.js
 *
 * Standalone gesture layer for UNPATCHED Penpot deployments. Use this when you
 * cannot (or do not want to) rebuild Penpot's frontend — drop it into the
 * static bundle (frontend/resources/public/) and reference it from the main
 * template, OR inject it via the WebView onPageFinished hook (see README).
 *
 * What it provides on top of stock Penpot:
 *   1. Two-finger pinch-zoom  -> synthesized WheelEvent(ctrlKey) -> feeds the
 *      exact same rAF-zoom pipeline the mouse wheel uses.
 *   2. Two-finger pan         -> synthesized WheelEvent (no ctrl).
 *   3. Single-finger object drag passes through (stock Penpot behavior).
 *   4. Hitbox expansion for selection gizmos (CSS injection) when the coarse
 *      pointer media query is active.
 *   5. IME guard: a soft-keyboard visualViewport resize aborts in-flight
 *      two-finger gestures so the canvas transform never desyncs.
 *
 * NOTE: the full disambiguation (touch slop before object drags, single-finger
 * pan on empty canvas, double-tap to edit) lives in the CLJS module
 * `mobile_gestures.cljs`. Build Penpot with that patch for the complete
 * experience.
 */
(function () {
  'use strict';

  if (window.__penpotTouchShim) { return; }
  window.__penpotTouchShim = true;

  if (typeof window.PointerEvent !== 'function') { return; }

  var MIN_PINCH = 24;   // px between fingers before pinch arms
  var ZOOM_SENS   = 1100; // deltaY mapping: (scale-1)*-ZOOM_SENS

  var pointers = new Map();   // pointerId -> {x, y}
  var navActive = false;
  var pinchDist = null;
  var nav = { dx: 0, dy: 0, raf: 0 };

  function viewportNode() {
    return document.querySelector('.viewport');
  }

  function insideViewport(node) {
    var vp = viewportNode();
    return !!(node && vp && (node === vp || vp.contains(node)));
  }

  function pos(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function wheel(target, opts) {
    try {
      var ev = new WheelEvent('wheel', {
        deltaX: opts.deltaX || 0,
        deltaY: opts.deltaY || 0,
        clientX: opts.clientX || 0,
        clientY: opts.clientY || 0,
        ctrlKey: !!opts.ctrlKey,
        bubbles: true,
        cancelable: true
      });
      target.dispatchEvent(ev);
    } catch (err) { /* non-fatal */ }
  }

  function flushNav() {
    nav.raf = 0;
    var vp = viewportNode();
    if (!vp || !navActive) { nav.dx = 0; nav.dy = 0; return; }
    wheel(vp, { deltaX: nav.dx, deltaY: nav.dy });
    nav.dx = 0;
    nav.dy = 0;
  }

  function onPointerDown(e) {
    if (e.pointerType !== 'touch' || !insideViewport(e.target)) { return; }
    pointers.set(e.pointerId, pos(e));
    if (pointers.size === 2) {
      // Second finger: take over as canvas navigation.
      e.preventDefault();
      e.stopPropagation();
      navActive = true;
      pinchDist = null;
    }
  }

  function onPointerMove(e) {
    if (e.pointerType !== 'touch' || !pointers.has(e.pointerId)) { return; }
    pointers.set(e.pointerId, pos(e));
    if (!navActive || pointers.size < 2) { return; }

    e.preventDefault();
    e.stopPropagation();

    var it = pointers.values();
    var a = it.next().value;
    var b = it.next().value;
    var d = dist(a, b);
    var m = mid(a, b);

    if (pinchDist === null) {
      if (d < MIN_PINCH) { return; }
      pinchDist = d;
      nav.dx = 0;
      nav.dy = 0;
      return;
    }

    var scale = d / pinchDist;
    if (Math.abs(scale - 1) > 0.0001) {
      // Zoom: ctrl+wheel in Penpot's pipeline = zoom around cursor point.
      var deltaY = (1 - scale) * ZOOM_SENS;
      pinchDist = d;
      wheel(viewportNode() || e.target, { deltaY: deltaY, ctrlKey: true, clientX: m.x, clientY: m.y });
    }

    // Pan: accumulate midpoint displacement, flush at next frame.
    nav.dx += m.x - (nav.lastMid ? nav.lastMid.x : m.x);
    nav.dy += m.y - (nav.lastMid ? nav.lastMid.y : m.y);
    nav.lastMid = m;
    if (!nav.raf) { nav.raf = requestAnimationFrame(flushNav); }
  }

  function onPointerUp(e) {
    if (e.pointerType !== 'touch') { return; }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      navActive = false;
      nav.lastMid = null;
      if (nav.raf) { cancelAnimationFrame(nav.raf); nav.raf = 0; }
      nav.dx = 0;
      nav.dy = 0;
      pinchDist = null;
    }
  }

  function onPointerCancel(e) {
    if (e.pointerType !== 'touch') { return; }
    onPointerUp(e);
  }

  // IME guard: when the soft keyboard opens (visualViewport resize) any
  // in-flight navigation is finished so coordinates never desync.
  function onViewportResize() {
    if (navActive) { onPointerUp({ pointerType: 'touch', pointerId: -1 }); }
  }

  // Long-press context menu / text selection emulation on canvas is noise.
  function onContextMenu(e) {
    if (insideViewport(e.target)) { e.preventDefault(); }
  }

  // Inject the touch hitbox + tap-highlight CSS overrides.
  function injectCss() {
    var css = [
      '@media (pointer: coarse) {',
      '  .viewport, .viewport * { -webkit-tap-highlight-color: transparent; }',
      '  .resize-handler > rect[data-position],',
      '  .resize-handler > circle[data-position] {',
      '    pointer-events: stroke; stroke: transparent;',
      '    stroke-width: 24px; vector-effect: non-scaling-stroke;',
      '  }',
      '  .resize-handler > rect:not([data-position]) {',
      '    pointer-events: stroke; stroke: transparent;',
      '    stroke-width: 24px; vector-effect: non-scaling-stroke;',
      '  }',
      '  .viewport-selrect {',
      '    pointer-events: stroke; stroke: transparent;',
      '    stroke-width: 24px; vector-effect: non-scaling-stroke;',
      '  }',
      '}'
    ].join('\n');
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function install() {
    var opts = { capture: true, passive: false };
    window.addEventListener('pointerdown', onPointerDown, opts);
    window.addEventListener('pointermove', onPointerMove, opts);
    window.addEventListener('pointerup', onPointerUp, opts);
    window.addEventListener('pointercancel', onPointerCancel, opts);
    window.addEventListener('contextmenu', onContextMenu, true);
    var vv = window.visualViewport;
    if (vv) { vv.addEventListener('resize', onViewportResize); }
    injectCss();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    install();
  } else {
    document.addEventListener('DOMContentLoaded', install);
  }
})();