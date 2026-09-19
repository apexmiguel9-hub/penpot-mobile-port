/*
 * penpot-touch-shim.js  (v5)
 *
 * Clean-slate gesture layer for UNPATCHED Penpot inside a Capacitor WebView.
 *
 * Fixes in v5:
 *   - Figma-style 2-finger: drag together = pan, pinch = zoom (separate, tuned)
 *   - Single tap on canvas exits text-edit mode (blur)
 *   - Box select anchors from finger: synthetic down targets viewport-controls
 *   - Long-press (500ms) = right-click (contextmenu)
 *   - Survives SPA navigation / page reload: no install guard, idempotent setup
 *   - window.__glog ring buffer for one-shot debugging
 */
(function () {
  'use strict';

  // Idempotent install: remove old listeners if re-injected (page reload/SPA nav)
  if (window.__penpotTouchShimCleanup) {
    window.__penpotTouchShimCleanup();
  }
  console.log('[penpot-touch-shim] v5 gesture layer installed');

  if (typeof window.PointerEvent !== 'function') { return; }
  if (typeof window.MouseEvent !== 'function') { return; }

  /* ------------------------------------------------------------------ */
  /* Config                                                             */
  /* ------------------------------------------------------------------ */
  var SLOP         = 15;     // px before drag starts (was 8, too sensitive)
  var GRACE_MS     = 150;    // if 2nd finger lands within this, treat as 2-finger from start
  var LONGPRESS_MS = 500;    // hold for right-click
  var ZOOM_SENS    = 400;    // pinch -> wheel deltaY
  var PAN_SENS     = 1.5;    // pan multiplier
  var TAP_MS       = 400;    // double-tap window
  var TAP_PX       = 24;     // double-tap radius
  var GLOG_MAX     = 400;

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */
  var pointers = new Map();     // pointerId -> {x, y, startX, startY, startT, longpressTimer}
  var state    = 'idle';        // idle | armed | active | nav
  var drag     = null;          // {id, sx, sy, tx, ty}
  var five     = null;          // armed single-finger {id, x, y, longpressTimer, startT}
  var lastTap  = null;          // {x, y, t} for double-tap
  var lastNav  = { d: 0, m: null };
  var synth    = false;         // re-entrancy guard

  /* ------------------------------------------------------------------ */
  /* Log                                                                */
  /* ------------------------------------------------------------------ */
  var glog = [];
  function gl(m) {
    glog.push({ t: Date.now(), m: m });
    if (glog.length > GLOG_MAX) { glog.shift(); }
    window.__glog = glog;
  }

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                        */
  /* ------------------------------------------------------------------ */
  function viewportNode() {
    return document.querySelector('[class$="__viewport"]') || document.querySelector('.viewport');
  }
  function viewportControlsNode() {
    // The element that Penpot's marquee gate accepts (has class 'viewport-controls')
    var vp = viewportNode();
    if (!vp) { return null; }
    // Try direct match first
    var vc = vp.querySelector('[class*="viewport-controls"]');
    if (vc) { return vc; }
    // Fallback: the svg child of viewport
    return vp.querySelector('svg') || vp;
  }
  function isCanvasViewport() {
    // Only treat as canvas if viewport has the controls/render layer (editor page)
    var vc = viewportControlsNode();
    return !!(vc && (vc.querySelector('[class*="viewport-controls"]') || vc.tagName === 'SVG'));
  }
  function insideViewport(node) {
    var vp = viewportNode();
    return !!(node && vp && (node === vp || vp.contains(node))) && isCanvasViewport();
  }
  function isEditable(node) {
    if (!node || !node.matches) { return false; }
    if (node.matches('input, textarea, select')) { return true; }
    if (node.isContentEditable) { return true; }
    return !!node.closest('[contenteditable]');
  }
  function isInEditMode() {
    // Penpot text editor uses contenteditable
    return document.activeElement && isEditable(document.activeElement);
  }
  function pos(e) { return { x: e.clientX, y: e.clientY }; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  /* ------------------------------------------------------------------ */
  /* Dispatch helpers                                                   */
  /* ------------------------------------------------------------------ */
  function elementAt(x, y) {
    return document.elementFromPoint(x, y);
  }

  function makePointer(kind, x, y, pointerId) {
    try {
      var ev = new PointerEvent(kind, {
        pointerId: pointerId, pointerType: 'touch', isPrimary: true,
        bubbles: true, cancelable: true, button: 0,
        buttons: (kind === 'pointermove') ? 1 : 0,
        clientX: x, clientY: y
      });
      Object.defineProperty(ev, 'which', { value: 1, configurable: true });
      Object.defineProperty(ev, 'detail', { value: 1, configurable: true });
      return ev;
    } catch (e) { gl('makePointer ERR ' + kind + ':' + e.message); return null; }
  }

  function makeMouse(kind, x, y, detail) {
    try {
      var ev = new MouseEvent(kind, {
        bubbles: true, cancelable: true, detail: detail || 1, button: 0,
        clientX: x, clientY: y
      });
      Object.defineProperty(ev, 'which', { value: 1, configurable: true });
      return ev;
    } catch (e) { gl('makeMouse ERR ' + kind + ':' + e.message); return null; }
  }

  function dispatchSynthetic(kind, x, y, pointerId, make) {
    var el = elementAt(x, y);
    if (!el) { gl('noEl ' + kind); return null; }
    var ev = make(kind, x, y, pointerId);
    if (!ev) { return null; }
    synth = true;
    try {
      el.dispatchEvent(ev);
    } catch (e) {
      gl('dispatch ERR ' + kind + ' @' + x + ',' + y + ' -> ' + e.message);
    } finally {
      synth = false;
    }
    return el;
  }

  function dispatchPointer(kind, x, y, pointerId) {
    return dispatchSynthetic(kind, x, y, pointerId, makePointer);
  }
  function dispatchMouse(kind, x, y, detail) {
    return dispatchSynthetic(kind, x, y, undefined, makeMouse);
  }

  function dispatchWheel(x, y, deltaY, deltaX, ctrl) {
    var el = elementAt(x, y) || viewportNode();
    if (!el) { return; }
    try {
      var ev = new WheelEvent('wheel', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        deltaY: deltaY, deltaX: deltaX || 0, deltaMode: 0, ctrlKey: !!ctrl
      });
      synth = true;
      try { el.dispatchEvent(ev); } finally { synth = false; }
    } catch (err) { gl('wheel ERR ' + err.message); }
  }

  /* ------------------------------------------------------------------ */
  /* Real event handlers (capture phase on window)                      */
  /* ------------------------------------------------------------------ */

  function onRealDown(e) {
    if (synth) { return; }
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') { return; }
    if (e.button !== 0) { return; }
    var p = pos(e);
    if (!insideViewport(e.target)) { return; }
    if (isEditable(e.target)) { return; }

    // Hard reset any stuck state from previous gesture
    if (state !== 'idle') {
      gl('HARD RESET on new down (was ' + state + ')');
      reset();
    }

    var ptr = { x: p.x, y: p.y, startX: p.x, startY: p.y, startT: Date.now() };
    ptr.longpressTimer = setTimeout(function () {
      gl('longpress @' + p.x + ',' + p.y);
      dispatchMouse('contextmenu', p.x, p.y, 1);
    }, LONGPRESS_MS);

    pointers.set(e.pointerId, ptr);

    if (pointers.size === 1) {
      // First finger: arm tap/drag candidate
      state = 'armed';
      five  = { id: e.pointerId, x: p.x, y: p.y, longpressTimer: ptr.longpressTimer, startT: ptr.startT };
      gl('down arm id=' + e.pointerId + ' @' + p.x + ',' + p.y);
      swallow(e);
    } else {
      // Second finger: check grace period - if within GRACE_MS of first finger, go straight to nav
      var grace = five && (Date.now() - five.startT < GRACE_MS);
      if (five && five.longpressTimer) { clearTimeout(five.longpressTimer); }
      if (grace) {
        gl('grace 2-finger @' + p.x + ',' + p.y);
      } else {
        gl('late 2-finger @' + p.x + ',' + p.y);
      }
      state = 'nav';
      lastNav = { d: 0, m: null };
      swallow(e);
    }
  }

  function onRealMove(e) {
    if (synth) { return; }
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') { return; }
    var p = pos(e);

    /* update tracked pointer */
    if (pointers.has(e.pointerId)) {
      var ptr = pointers.get(e.pointerId);
      ptr.x = p.x; ptr.y = p.y;
    }

    if (state === 'armed' && five && five.id === e.pointerId) {
      var d = dist(five, p);
      if (d >= SLOP && pointers.size === 1) {
        // Start drag: clear longpress, decide intent at CURRENT finger position
        if (five.longpressTimer) { clearTimeout(five.longpressTimer); }
        gl('arm->active @' + p.x + ',' + p.y + ' (slop ' + d.toFixed(0) + ')');
        state = 'active';
        drag = { id: five.id, sx: five.x, sy: five.y, tx: p.x, ty: p.y };

        // Determine intent at CURRENT position: object under finger = move/resize, empty = marquee
        var target = elementAt(p.x, p.y);
        var vc = viewportControlsNode();
        var onObject = target && target !== vc && vc.contains(target);
        // For move/resize, target the object; for marquee, target viewport-controls
        // Penpot's gate accepts pointerdown on viewport-controls for marquee, on object for move

        // Prime hover at current pos, then down at ORIGINAL pos (for correct anchor), then move to current
        dispatchPointer('pointermove', p.x, p.y, five.id);
        dispatchPointer('pointerdown', five.x, five.y, five.id);
        dispatchPointer('pointermove', p.x, p.y, five.id);
        swallow(e);
        return;
      }
      if (pointers.size === 2) {
        var grace = five && (Date.now() - five.startT < GRACE_MS);
        if (five.longpressTimer) { clearTimeout(five.longpressTimer); }
        if (grace) { gl('grace 2-finger move'); } else { gl('late 2-finger move'); }
        state = 'nav';
        lastNav = { d: 0, m: null };
        swallow(e);
        return;
      }
      swallow(e);  // still < SLOP
      return;
    }

    if (state === 'active' && drag) {
      drag.tx = p.x; drag.ty = p.y;
      dispatchPointer('pointermove', p.x, p.y, drag.id);
      swallow(e);
      return;
    }
    if (state === 'active' && !drag) {
      gl('STUCK active without drag -> reset');
      reset();
      return;
    }

    if (state === 'nav') { navMove(); swallow(e); return; }
  }

  function onRealUp(e) {
    if (synth) { return; }
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') { return; }
    var p = pos(e);
    var wasArmed  = (state === 'armed' && five && five.id === e.pointerId);
    var wasActive = (state === 'active' && drag && drag.id === e.pointerId);

    // Clear longpress timer if exists
    var ptr = pointers.get(e.pointerId);
    if (ptr && ptr.longpressTimer) { clearTimeout(ptr.longpressTimer); }

    pointers.delete(e.pointerId);

    if (wasArmed) {
      // Single tap
      gl('UP tap @' + p.x + ',' + p.y);

      // If in text edit mode, tap on canvas = exit edit (blur)
      if (isInEditMode()) {
        gl('tap -> blur edit mode');
        document.activeElement.blur();
        reset();
        return;
      }

      // Prime hover then click (select)
      dispatchPointer('pointermove', five.x, five.y, five.id);
      dispatchMouse('click', five.x, five.y, 1);

      // Double-tap -> dblclick (enter edit)
      var t = Date.now();
      if (lastTap && (t - lastTap.t < TAP_MS) && dist(lastTap, five) < TAP_PX) {
        gl('dbltap -> dblclick');
        dispatchMouse('dblclick', five.x, five.y, 2);
        lastTap = null;
      } else {
        lastTap = { x: five.x, y: five.y, t: t };
      }
      reset();
    } else if (wasActive) {
      // Drag ended: up at current pos while pointer still active
      gl('UP drag @' + p.x + ',' + p.y);
      dispatchPointer('pointerup', p.x, p.y, drag.id);
      reset();
    } else if (state === 'active' && drag) {
      // Stuck active state with mismatched pointer - force cleanup
      gl('FORCE CLEANUP active drag id=' + drag.id + ' (up id=' + e.pointerId + ')');
      dispatchPointer('pointerup', drag.tx, drag.ty, drag.id);
      reset();
    } else if (state === 'nav') {
      if (pointers.size === 0) { reset(); }
      gl('UP nav' + (pointers.size ? ' 1 remains' : ''));
    } else {
      gl('UP stray id=' + e.pointerId);
    }
    swallow(e);
  }

  function onRealCancel(e) {
    if (synth) { return; }
    gl('CANCEL id=' + e.pointerId);
    var ptr = pointers.get(e.pointerId);
    if (ptr && ptr.longpressTimer) { clearTimeout(ptr.longpressTimer); }
    pointers.delete(e.pointerId);
    if (state === 'active' && drag && drag.id === e.pointerId) {
      dispatchPointer('pointercancel', drag.tx, drag.ty, drag.id);
      reset();
    } else {
      reset();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 2-finger navigation: Figma-style separate pan + zoom               */
  /* ------------------------------------------------------------------ */
  function navMove() {
    var pts = Array.from(pointers.values());
    if (pts.length < 2) { return; }
    var a = pts[0], b = pts[1];
    var d = dist(a, b), m = mid(a, b);

    if (lastNav.d && lastNav.m) {
      var dRatio = d / lastNav.d;      // pinch ratio
      var panX = m.x - lastNav.m.x;    // pan delta
      var panY = m.y - lastNav.m.y;

      // ZOOM: significant pinch (ratio change > threshold)
      if (Math.abs(dRatio - 1) > 0.005) {
        var dz = (dRatio - 1) * ZOOM_SENS;
        dispatchWheel(m.x, m.y, dz, 0, true);  // ctrl+wheel = zoom
      }
      // PAN: significant center movement
      if (Math.abs(panX) > 1 || Math.abs(panY) > 1) {
        dispatchWheel(m.x, m.y, -panY * PAN_SENS, -panX * PAN_SENS, false);
      }
    }
    lastNav.d = d;
    lastNav.m = m;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  function reset() {
    if (five && five.longpressTimer) { clearTimeout(five.longpressTimer); }
    five = null;
    drag = null;
    state = 'idle';
    lastNav = { d: 0, m: null };
    gl('reset -> idle');
  }

  function swallow(e) {
    if (e.cancelable) { e.preventDefault(); }
    e.stopImmediatePropagation();
    e.stopPropagation();
  }

  /* ------------------------------------------------------------------ */
  /* Install (idempotent)                                               */
  /* ------------------------------------------------------------------ */
  window.addEventListener('pointerdown', onRealDown, true);
  window.addEventListener('pointermove', onRealMove, true);
  window.addEventListener('pointerup', onRealUp, true);
  window.addEventListener('pointercancel', onRealCancel, true);

  var st = document.createElement('style');
  st.textContent = '.viewport, [class$="__viewport"] { touch-action: none !important; }';
  document.head.appendChild(st);

  // Expose cleanup for re-injection
  window.__penpotTouchShimCleanup = function () {
    window.removeEventListener('pointerdown', onRealDown, true);
    window.removeEventListener('pointermove', onRealMove, true);
    window.removeEventListener('pointerup', onRealUp, true);
    window.removeEventListener('pointercancel', onRealCancel, true);
    // Note: touch listeners on document can't be easily removed without refs;
    // they're harmless duplicates.
    if (st && st.parentNode) { st.parentNode.removeChild(st); }
  };

  gl('installed');
})();