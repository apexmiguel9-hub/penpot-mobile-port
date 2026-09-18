/*
 * penpot-touch-shim.js  (v2)
 *
 * Standalone gesture layer for UNPATCHED Penpot deployments.
 *
 * v2 design: Penpot's own pointer handlers already do the right thing for the
 * move tool (empty-canvas drag -> marquee select; object drag -> move; tap ->
 * select + resize handles), but on a touchscreen the raw events are a mess:
 * the marquee starts from the very first finger wriggle (so 2-finger pinch
 * zooms are polluted by a stray selection box), and the marquee can also get
 * re-anchored off the finger (nested marquee started on the previous marquee's
 * fat invisible stroke). We therefore SWALLOW every touch pointer event inside
 * the `.viewport` and re-emit our own SYNTHETIC pointer events with precise
 * coordinates to drive the exact same native handlers:
 *
 *   - single finger, moves < SLOP then up ......... tap  -> synthetic
 *     pointerdown/up at the true touch point + a click (select + handles).
 *   - two quick taps .................................. synthetic dblclick
 *     (enter text editing, as desktop).
 *   - single finger drag from EMPTY canvas ......... synthetic pointer
 *     events anchored EXACTLY at the touch-down point -> native marquee
 *     select, un-shifted.
 *   - single finger drag ON a shape ................ synthetic pointer
 *     events -> native object move.
 *   - second finger lands .......................... the pending single-finger
 *     gesture is discarded (marquee never starts) and 2-finger CANVAS
 *     NAVIGATION takes over (pinch zoom + pan, synthesized as ctrl-wheel).
 *
 * Nothing is ever re-emitted while two fingers are down, so zoom/pan is clean.
 *
 * Note: events are swallowed in the CAPTURE phase at window level, so we must
 * NOT swallow events targeting editable nodes (input/textarea/contenteditable
 * inside the canvas text editor) or anything outside the `.viewport`.
 */
(function () {
  'use strict';

  if (window.__penpotTouchShim) { return; }
  window.__penpotTouchShim = true;
  console.log("[penpot-touch-shim] v2 gesture layer installed");

  if (typeof window.PointerEvent !== 'function') { return; }

  var SLOP = 7;          // px of movement required to turn a touch into a drag
  var MIN_PINCH = 24;    // px between fingers before pinch arms
  var ZOOM_SENS   = 1100; // deltaY mapping: (scale-1)*-ZOOM_SENS
  var TAP_GRACE  = 300;   // ms window for double-tap detection
  var TAP_RADIUS = 26;    // px radius for double-tap detection

  var pointers = new Map();  // pointerId -> {x,y}
  var navActive = false;
  var pinchDist = null;
  var nav = { dx: 0, dy: 0, raf: 0, lastMid: null };

  var syn = null;            // pending/active synthetic gesture for pointer 1
  var lastTap = null;        // {x, y, t} of previous tap
  var synthActive = false;   // true while we dispatch synthetic events

  function viewportNode() {
    return document.querySelector('[class$="__viewport"]') || document.querySelector('.viewport');
  }

  function insideViewport(node) {
    var vp = viewportNode();
    return !!(node && vp && (node === vp || vp.contains(node)));
  }

  function isEditable(node) {
    if (!node || !node.matches) { return false; }
    if (node.matches('input, textarea, select')) { return true; }
    if (node.isContentEditable) { return true; }
    return !!node.closest('[contenteditable]');
  }

  function pos(e) { return { x: e.clientX, y: e.clientY }; }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

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

  function createPointer(kind, x, y, pointerId) {
    try {
      var ev = new PointerEvent(kind, {
        pointerId: pointerId || 1,
        pointerType: 'touch',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: (kind === 'move') ? 1 : 0,
        clientX: x,
        clientY: y
      });
      // Penpot (app/util/dom.cljs) decides mouse-buttons via `event.which`
      // (left-mouse? == (= 1 which)) and synthesized PointerEvents default to
      // which === 0, which Penpot reads as "not a click". Pin it to 1.
      Object.defineProperty(ev, 'which', { value: 1, configurable: true });
      Object.defineProperty(ev, 'detail', { value: 1, configurable: true });
      return ev;
    } catch (err) { return null; }
  }

  function dispatchAt(kind, x, y, pointerId) {
    var el = document.elementFromPoint(x, y);
    if (!el) { return null; }
    var ev = createPointer(kind, x, y, pointerId);
    if (!ev) { return null; }
    synthActive = true;
    try {
      el.dispatchEvent(ev);
    } finally {
      synthActive = false;
    }
    return el;
  }

  function dispatchMouse(kind, x, y, detail) {
    var el = document.elementFromPoint(x, y);
    if (!el) { return; }
    try {
      var ev = new MouseEvent(kind, {
        bubbles: true,
        cancelable: true,
        detail: detail || 1,
        button: 0,
        clientX: x,
        clientY: y
      });
      Object.defineProperty(ev, 'which', { value: 1, configurable: true });
      synthActive = true;
      try {
        el.dispatchEvent(ev);
      } finally {
        synthActive = false;
      }
    } catch (err) { /* non-fatal */ }
  }

  // Finish a pending or in-flight synthetic gesture.
  function tearDownSynthetic(endX, endY) {
    if (!syn) { return; }
    if (syn.active) {
      dispatchAt('pointerup', endX, endY, syn.id);
    } else {
      // No movement passed slop: it was a tap => select / show handles.
      var sx = syn.sx;
      var sy = syn.sy;
      dispatchAt('pointerdown', sx, sy, syn.id);
      dispatchAt('pointerup', endX, endY, syn.id);
      dispatchMouse('click', endX, endY, 1);
      var now = Date.now();
      if (lastTap && now - lastTap.t < TAP_GRACE && dist({ x: endX, y: endY }, lastTap) < TAP_RADIUS) {
        dispatchMouse('dblclick', endX, endY, 2);
        lastTap = null;
      } else {
        lastTap = { x: endX, y: endY, t: now };
      }
    }
    syn = null;
  }

  function onPointerDown(e) {
    if (synthActive) { return; } // never swallow our own re-emitted events
    if (e.pointerType !== 'touch' || !insideViewport(e.target) || isEditable(e.target)) { return; }

    // Swallow: Penpot's viewport handlers must not see the raw touch events.
    e.preventDefault();
    e.stopImmediatePropagation();

    pointers.set(e.pointerId, pos(e));

    if (pointers.size >= 2) {
      // Second finger lands: nav takes over; drop any pending single gesture.
      if (syn) {
        if (syn.active) {
          dispatchAt('pointerup', e.clientX, e.clientY, syn.id);
        }
        syn = null;
      }
      navActive = true;
      pinchDist = null;
      nav.dx = 0;
      nav.dy = 0;
      nav.lastMid = null;
      return;
    }

    syn = { id: e.pointerId, sx: e.clientX, sy: e.clientY, active: false };
  }

  function onPointerMove(e) {
    if (synthActive) { return; } // never swallow our own re-emitted events
    if (e.pointerType !== 'touch' || !insideViewport(e.target)) { return; }

    var tracked = pointers.has(e.pointerId);
    if (!tracked && !navActive && !syn) { return; }

    e.preventDefault();
    e.stopImmediatePropagation();

    if (tracked) { pointers.set(e.pointerId, pos(e)); }

    if (navActive && tracked) {
      if (pointers.size < 2) { return; }

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
        var deltaY = (1 - scale) * ZOOM_SENS;
        pinchDist = d;
        wheel(viewportNode() || e.target, { deltaY: deltaY, ctrlKey: true, clientX: m.x, clientY: m.y });
      }

      nav.dx += m.x - (nav.lastMid ? nav.lastMid.x : m.x);
      nav.dy += m.y - (nav.lastMid ? nav.lastMid.y : m.y);
      nav.lastMid = m;
      if (!nav.raf) { nav.raf = requestAnimationFrame(flushNav); }
      return;
    }

    if (!syn) { return; }

    var p = pos(e);
    if (!syn.active) {
      var moved = dist({ x: syn.sx, y: syn.sy }, p);
      if (moved < SLOP) { return; }
      // Awaits the native blur: emit the down AT the original touch point so
      // the marquee / object move is anchored exactly under the finger.
      dispatchAt('pointerdown', syn.sx, syn.sy, syn.id);
      syn.active = true;
    }
    dispatchAt('pointermove', p.x, p.y, syn.id);
  }

  function onPointerUp(e) {
    if (synthActive) { return; } // never swallow our own re-emitted events
    if (e.pointerType !== 'touch') { return; }

    if (insideViewport(e.target) && !isEditable(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    if (syn && e.pointerId === syn.id) {
      tearDownSynthetic(e.clientX, e.clientY);
    }

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
    if (synthActive) { return; }
    if (e.pointerType !== 'touch') { return; }
    if (syn && e.pointerId === syn.id && syn.active) {
      dispatchAt('pointercancel', e.clientX, e.clientY, syn.id);
    }
    onPointerUp(e);
  }

  // IME guard: if the soft keyboard opens (visualViewport resize) end any
  // in-flight two-finger navigation so canvas coordinates never desync.
  function onViewportResize() {
    if (navActive) { onPointerUp({ pointerType: 'touch', pointerId: -1 }); }
  }

  function onContextMenu(e) {
    if (insideViewport(e.target)) { e.preventDefault(); }
  }

  // Inject the touch hitbox + tap-highlight CSS overrides.
  // NOTE: never widen the `.viewport-selrect` (the marquee itself): giving it
  // an invisible stroke lets it re-catch pointers and spawn nested marquees
  // anchored off the finger.
  function injectCss() {
    var css = [
      '@media (pointer: coarse) {',
      '  .viewport, [class$="__viewport"], [class$="__viewport"] * { -webkit-tap-highlight-color: transparent; }',
      '  .viewport, [class$="__viewport"] { touch-action: none; }',
      '  rect[data-position], circle[data-position] {',
      '    pointer-events: stroke; stroke: transparent;',
      '    stroke-width: 20px; vector-effect: non-scaling-stroke;',
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

  // The canvas may not be mounted yet when we run (injected on page load).
  // Some files take a while to open; keep polling for up to 30s.
  function whenViewportReady() {
    var tries = 0;
    (function poll() {
      if (viewportNode()) {
        install();
      } else if (tries++ < 100) {
        setTimeout(poll, 300);
      }
    })();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    whenViewportReady();
  } else {
    document.addEventListener('DOMContentLoaded', whenViewportReady);
  }
})();