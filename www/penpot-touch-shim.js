/*
 * penpot-touch-shim.js  (v4)
 *
 * Clean-slate gesture layer for UNPATCHED Penpot inside a Capacitor WebView.
 *
 * WHY a rewrite: Penpot's move/marquee/resize/zoom logic lives in the web page
 * (React pointer handlers + a hover/move-stream). A Kotlin app layer cannot
 * drive it because the state lives on the page; all we can control from the
 * outside is WHAT event stream reaches the page. The old shim accumulated
 * dead state and wedged after 1-2 gestures overnight, so this version is a
 * small explicit state machine with no stuck states:
 *
 *   state: idle -> armed -> active -> (teardown) -> idle
 *
 * One gesture = one closed down/moves/up cycle, always ending in idle, always
 * releasing the pointer, fresh pointerId per cycle, small SLOP, and a roaming
 * ring-buffer log (window.__glog) so we can debug a pure-touch session from
 * the debugger in ONE round instead of guessing.
 *
 * Event strategy (whitelisted by Chromium's active-pointer rules):
 *   - A synthetic pointer event may only be dispatched for a pointerId that is
 *     CURRENTLY ACTIVE (a real pointer still on screen). So every synthetic
 *     down/move/up is emitted INSIDE the matching real pointer handler for the
 *     SAME pointerId (down emits while finger is down, moves while moving, up
 *     while the real up is being processed -- all legal).
 *   - Taps do NOT need pointer events: Penpot selects on a plain `click`
 *     MouseEvent (it also uses the hover/move-stream for details), and edit on
 *     `dblclick` -- both MouseEvents, which Chrome emits with zero fuss.
 *
 * Installed by setting window.__penpotTouchShim; re-injection just returns.
 */
(function () {
  'use strict';

  if (window.__penpotTouchShim) { return; }
  window.__penpotTouchShim = true;
  console.log('[penpot-touch-shim] v4 gesture layer installed');

  if (typeof window.PointerEvent !== 'function') { return; }
  if (typeof window.MouseEvent !== 'function') { return; }

  /* ------------------------------------------------------------------ */
  /* Config                                                             */
  /* ------------------------------------------------------------------ */
  var SLOP      = 9;    // px of real movement before we start a synthetic drag
  var PINCH_IN  = 24;   // min px between two fingers before pinch arms
  var ZOOM_SENS = 1200; // pinch-delta -> wheel.deltaY multiplier
  var TAP_MS    = 500;  // double-tap window (delay between two taps)
  var TAP_PX    = 28;   // double-tap radius

  var GLOG_MAX  = 400;

  var pointers = new Map();  // pointerId -> {x, y} (real tracked pointers)
  var state    = 'idle';     // idle | armed | active | nav
  var mode     = null;       // null | tap | drag | pinch
  var scx = 0, scy = 0;      // current synthetic point
  var lastTap = null;        // {x, y, t}

  var five = null;           // pending gesture: {id, x, y} of the armed pointer
  var drag = null;           // active drag: {id, sx, sy, tx, ty}
  var synth = false;         // true while we are dispatching synthetic events

  var lastNav = { dx: 0, dy: 0, z: 1 };

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

  /* Dispatch a synthetic event on the element currently under (x,y). */
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

  /* ------------------------------------------------------------------ */
  /* Real event handlers (capture phase on window)                      */
  /* ------------------------------------------------------------------ */

  /* A real touch pointer went down. If it's on the canvas, take over.   */
  function onRealDown(e) {
    if (synth) { return; }
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') { return; }
    if (e.button !== 0) { return; }
    var p = pos(e);
    if (!insideViewport(e.target) && !nodeUnder(e.target, p)) { return; }
    if (isEditable(e.target)) { return; }  // let inputs/toolbars work

    pointers.set(e.pointerId, { x: p.x, y: p.y });

    if (pointers.size === 1) {
      // First finger: arm a candidate gesture, do NOT emit anything yet.
      state = 'armed';
      mode  = null;
      five  = { id: e.pointerId, x: p.x, y: p.y };
      gl('down arm id=' + e.pointerId + ' @' + p.x + ',' + p.y);
      swallow(e);
    } else {
      // Second finger: cancel the armed tap and switch to 2-finger nav.
      cancelArmed('twof');
      state = 'nav';
      gl('down nav +id=' + e.pointerId);
      swallow(e);
    }
  }

  function nodeUnder(ignore, p) { return insideViewport(ignore); }

  function onRealMove(e) {
    if (synth) { return; }
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') { return; }
    var p = pos(e);

    /* update tracked pointer */
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: p.x, y: p.y });
    }

    if (state === 'armed' && five && five.id === e.pointerId) {
      var d = dist(five, p);
      if (d >= SLOP && pointers.size === 1) {
        gl('arm->active @' + p.x + ',' + p.y + ' (slop ' + d.toFixed(0) + ')');
        state = 'active';
        mode  = 'drag';
        drag = { id: five.id, sx: five.x, sy: five.y, tx: p.x, ty: p.y };
        /* Start the synthetic drag AT the orig finger point so the marquee /
           or the object-move anchors under the finger, not at slop-cross. */
        dispatchPointer('pointermove', five.x, five.y, five.id);
        dispatchPointer('pointerdown', five.x, five.y, five.id);
        dispatchPointer('pointermove', p.x, p.y, five.id);
        swallow(e);
        return;
      }
      if (pointers.size === 2) {
        cancelArmed('twof');
        state = 'nav';
        swallow(e);
        return;
      }
      swallow(e);         // keep tracking; still < SLOP
      return;
    }

    if (state === 'active' && drag) {
      drag.tx = p.x;
      drag.ty = p.y;
      dispatchPointer('pointermove', p.x, p.y, drag.id);
      swallow(e);
      return;
    }

    if (state === 'nav') { navMove(); swallow(e); return; }
  }

  function onRealUp(e) {
    if (synth) { return; }
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') { return; }
    var p = pos(e);
    var wasArmed = (state === 'armed' && five && five.id === e.pointerId);
    var wasActive = (state === 'active' && drag && drag.id === e.pointerId);

    pointers.delete(e.pointerId);

    if (wasArmed) {
      /* Tap: Penpot selects on a plain click. Prime hover (pointermove at
         the exact point while the pointer is still active), then click. */
      gl('UP tap @' + p.x + ',' + p.y);
      dispatchPointer('pointermove', five.x, five.y, five.id);
      dispatchMouse('click', five.x, five.y, 1);

      /* double-tap -> double-click -> edit */
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
      /* Drag ended: send the up while the real pointer is still active. */
      gl('UP drag @' + p.x + ',' + p.y);
      dispatchPointer('pointerup', p.x, p.y, drag.id);
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
    pointers.delete(e.pointerId);
    if (state === 'active' && drag && drag.id === e.pointerId) {
      dispatchPointer('pointercancel', drag.tx, drag.ty, drag.id);
      reset();
    } else {
      reset();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 2-finger navigation (pinch zoom + pan)                              */
  /* ------------------------------------------------------------------ */
  function navMove() {
    var pts = Array.from(pointers.values());
    if (pts.length < 2) { return; }
    var a = pts[0], b = pts[1];
    var d = dist(a, b), m = mid(a, b);

    /* pinch */
    if (lastNav.d) {
      var ratio = d / lastNav.d;
      var dz = (ratio - 1) * ZOOM_SENS;
      if (Math.abs(dz) > 0.5) {
        dispatchMouseWheel(m.x, m.y, dz, 0, true);
      }
    }
    /* pan (two fingers) */
    if (lastNav.m) {
      dispatchMouseWheel(m.x, m.y, -(m.x - lastNav.m.x) * 2, -(m.y - lastNav.m.y) * 2, false);
    }
    lastNav.d = d;
    lastNav.m = m;
  }

  function dispatchMouseWheel(x, y, deltaY, deltaX, ctrl) {
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
  /* Helpers                                                               */
  /* ------------------------------------------------------------------ */
  function cancelArmed(why) {
    if (five) { gl('cancel armed (' + why + ')'); five = null; }
    state = 'idle';
  }

  function reset() {
    five = null;
    drag = null;
    mode = null;
    state = 'idle';
    lastNav = {};
    gl('reset -> idle');
  }

  function swallow(e) {
    if (e.cancelable) { e.preventDefault(); }
    e.stopImmediatePropagation();
    e.stopPropagation();
  }

  /* ------------------------------------------------------------------ */
  /* Install                                                            */
  /* ------------------------------------------------------------------ */
  window.addEventListener('pointerdown', onRealDown, true);
  window.addEventListener('pointermove', onRealMove, true);
  window.addEventListener('pointerup', onRealUp, true);
  window.addEventListener('pointercancel', onRealCancel, true);

  /* Block native browser gestures (scroll/zoom/refresh-bounce) so every
     event we care about is ours. */
  document.addEventListener('touchstart', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false, capture: true });
  document.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false, capture: true });
  document.addEventListener('touchend', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false, capture: true });

  var st = document.createElement('style');
  st.textContent = 'html, body { touch-action: none !important; } .viewport, [class$="__viewport"] { touch-action: none !important; }';
  document.head.appendChild(st);

  gl('installed');
})();
