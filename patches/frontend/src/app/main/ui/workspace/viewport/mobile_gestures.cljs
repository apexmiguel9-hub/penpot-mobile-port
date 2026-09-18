;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.viewport.mobile-gestures
  "Touch gesture disambiguation layer for the workspace viewport.

  Penpot's desktop interaction model is built around pointer events designed
  for a mouse. On coarse pointer devices (Android WebView, tablets) we take
  over *touch* input inside the viewport to provide:

  1. Two-finger navigation reserved for the canvas: pan while both fingers
     move the midpoint, pinch-zoom mapped onto the exact same rAF-accumulator
     pipeline the mouse wheel uses (`actions/schedule-zoom!`/`schedule-scroll!`).
  2. A touch slop threshold (8px) before an object drag is committed, so tiny
     finger jitter never starts an unwanted move.
  3. Disambiguation between \"manipulate\" and \"navigate\":
       - Touches on selection gizmos, resize/rotate handles, toolbar buttons
         or active drawing/editing tools are passed through to Penpot
         untouched (`:external` stage) — and the single-finger pan is never
         started there, which keeps the pan/object-drag conflict away.
       - Touches on the canvas/shapes are owned by this machine (`:own`); the
         final object-vs-empty decision uses the same hover engine (quadtree
         + worker) the desktop pointer uses, fed through `move-stream`.
  4. An IME guard: when the Android soft keyboard opens (visualViewport
     resize) any in-flight gesture is gracefully finished so the canvas
     transform does not get desynchronized.

  Mouse input is never touched: every handler is gated to
  `pointerType = \"touch\"` and non-touch pointers are ignored.
  "
  (:require
   [app.common.data :as d]
   [app.common.geom.point :as gpt]
   [app.main.data.workspace :as dw]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.workspace.viewport.actions :as actions]
   [app.main.ui.workspace.viewport.viewport-ref :as uwvv]
   [app.util.dom :as dom]
   [app.util.mouse :as mse]
   [beicon.v2.core :as rx]
   [goog.events :as events]
   [rumext.v2 :as mf])
  (:import goog.events.EventType))

;; --------------------------------------------------------------------------
;; Constants
;; --------------------------------------------------------------------------

(def ^:const touch-slop
  "Pixels (client space) the finger may travel before a drag is committed."
  8)

(def ^:const double-tap-ms
  "Max gap (ms) between two taps that counts as a double tap."
  300)

(def ^:const min-pinch-dist
  "Minimum distance between two fingers (px) before pinch zoom arms. Keeps the
  ratio from jittering when fingers are almost on top of each other."
  24)

(def ^:private gizmo-selector
  ".resize-handler, .viewport-selrect, .controls, .rotate-handler, .grid-layout-editor")

(def ^:private reactive-ui-selector
  (str "button, a, input, select, textarea, [role=\"button\"], "
       ".viewport-actions-container, .viewport-actions-path"))

;; --------------------------------------------------------------------------
;; State
;; --------------------------------------------------------------------------

(defn- new-state
  []
  {:stage :idle
   :pointers {}                          ;; pointerId -> client point
   :anchor nil                           ;; client point of first finger
   :last nil                             ;; last client point we consumed
   :mode :unknown                        ;; :own | :external
   :muted-tap? false                     ;; survivor of a multipinch can't tap
   :pinch {:dist nil :cx 0 :cy 0}
   :tap-last-ts nil
   :tap-last-pos nil
   :nav-acc (actions/make-viewport-input-state)
   :zoom-acc (actions/make-viewport-input-state)})

(defn touch-capable?
  []
  (and (exists? js/navigator)
       (pos? (.-maxTouchPoints js/navigator))))

;; --------------------------------------------------------------------------
;; Small helpers
;; --------------------------------------------------------------------------

(defn- client-pos
  [^js event]
  (gpt/point (.-clientX event) (.-clientY event)))

(defn- distance [a b]
  (gpt/length (gpt/subtract a b)))

(defn- mid-point [pa pb]
  (gpt/point (/ (+ (:x pa) (:x pb)) 2)
             (/ (+ (:y pa) (:y pb)) 2)))

(defn- gizmo-ancestor?
  "True when the touch landed on (or inside) a selection gizmo. Those are
  Penpot-owned interactive elements (resize handles, rotation, selrect) that
  already implement their own pointer logic — we must let them through."
  [target]
  (some-> (.closest ^js target gizmo-selector) boolean))

(defn- reactive-ui-target?
  "True when the touch landed on a toolbar button / input / gereric clickable
  element that renders on top of the viewport. Passes through."
  [target]
  (some-> (.closest ^js target reactive-ui-selector) boolean))

(defn- should-pass-through?
  "Active drawing tool, text edition or path edition are single-finger flows
  that Penpot already owns. Leave them alone."
  [drawing-tool drawing-path?]
  (or (some? drawing-tool)
      drawing-path?
      (some? (deref refs/selected-drawing-tool))
      (some? (deref refs/selected-edition))))

;; --------------------------------------------------------------------------
;; Gesture events fed back into Penpot's data pipeline
;; --------------------------------------------------------------------------

(defn- push-hover!
  [move-stream vp-pt]
  ;; Feeds the same stream `actions/on-pointer-move` uses, so the quadtree
  ;; hover keeps working while we own the touch sequence.
  (rx/push! move-stream vp-pt))

(defn- push-pointer!
  [vp-pt movement]
  (st/emit! (mse/->PointerEvent :viewport vp-pt false false false false movement)))

;; --------------------------------------------------------------------------
;; Machine transitions
;; --------------------------------------------------------------------------

(defn- begin-own-gesture!
  [st* event move-stream]
  (let [pt    (client-pos event)
        vp-pt (uwvv/point->viewport pt)]
    (swap! st* assoc :stage :pending
                   :mode :own
                   :pointers {(.-pointerId event) pt}
                   :anchor pt
                   :last pt
                   :muted-tap? false)
    (push-hover! move-stream vp-pt)
    (push-pointer! vp-pt (gpt/point 0 0))))

(defn- abort-own-gesture!
  [st*]
  (let [stage (:stage @st*)]
    (when (contains? #{:drag :pan :external} stage)
      (st/emit! (mse/->MouseEvent :up false false false false)))
    (st/emit! (dw/finish-panning) (dw/finish-zooming))))

(defn- resolve-pending!
  [st* move-stream event workspace-read-only?]
  (let [pt    (client-pos event)
        vp-pt (uwvv/point->viewport pt)
        prev  (:last @st*)
        hover (deref refs/current-hover)]
    (push-hover! move-stream vp-pt)
    (if (and (some? hover) (not workspace-read-only?))
      ;; Over a shape: select-and-move (exactly what the desktop pointer does
      ;; on left-button down over an id, but deferred until the slop passes).
      (do
        (st/emit! (mse/->MouseEvent :down false false false false)
                  (dw/start-move-selected (:id hover) false))
        (push-pointer! vp-pt (if prev (gpt/subtract pt prev) (gpt/point 0 0)))
        (swap! st* assoc :stage :drag :last pt))
      ;; Empty canvas (or read-only): single-finger pan.
      (do
        (st/emit! (mse/->MouseEvent :down false false false false)
                  (dw/start-panning))
        (push-pointer! vp-pt (if prev (gpt/subtract pt prev) (gpt/point 0 0)))
        (swap! st* assoc :stage :pan :last pt)))))

(defn- advance-pending!
  [st* move-stream event workspace-read-only?]
  (let [pt    (client-pos event)
        vp-pt (uwvv/point->viewport pt)
        dist  (distance pt (:anchor @st*))]
    (push-hover! move-stream vp-pt)
    (if (>= dist touch-slop)
      (resolve-pending! st* move-stream event workspace-read-only?)
      (swap! st* assoc :last pt))))

(defn- advance-own-move!
  [st* move-stream event]
  (let [pt       (client-pos event)
        vp-pt    (uwvv/point->viewport pt)
        prev     (:last @st*)
        movement (if prev (gpt/subtract pt prev) (gpt/point 0 0))]
    (swap! st* assoc :last pt)
    (push-hover! move-stream vp-pt)
    (push-pointer! vp-pt movement)))

(defn- advance-navigation!
  [st* event]
  (let [id   (.-pointerId event)
        pt   (client-pos event)
        pts  (assoc (:pointers @st*) id pt)]
    (if (< (count pts) 2)
      ;; Degenerate case (survivor already released): track only.
      (swap! st* assoc :pointers pts)
      (let [[pa pb] (vals pts)]
        (swap! st* assoc :pointers pts)
        (let [pdist     (distance pa pb)
              pmid      (mid-point pa pb)
              {:keys [dist cx cy]} (:pinch @st*)]
          (if (or (nil? dist) (< pdist min-pinch-dist))
            ;; Not armed yet: keep updating the pinch baseline only.
            (swap! st* assoc :pinch {:dist pdist :cx (:x pmid) :cy (:y pmid)})
            (let [scale (/ pdist dist)
                  vp-pt (uwvv/point->viewport pmid)
                  ddx   (- (:x pmid) cx)
                  ddy   (- (:y pmid) cy)]
              (swap! st* assoc :pinch {:dist pdist :cx (:x pmid) :cy (:y pmid)})
              (actions/schedule-zoom! (:zoom-acc @st*) scale vp-pt)
              (actions/schedule-scroll! (:nav-acc @st*)
                                        (d/nilv (deref refs/selected-zoom) 1)
                                        #js {} ddx ddy))))))))

(defn- finish-tap!
  [st*]
  (let [{:keys [anchor muted-tap? tap-last-ts tap-last-pos]} @st*
        hover (some-> (deref refs/current-hover))
        now   (js/Date.now)
        double-tap? (and (some? tap-last-ts)
                         (< (- now tap-last-ts) double-tap-ms)
                         (some? tap-last-pos)
                         (<= (distance anchor tap-last-pos) (* 2 touch-slop)))]
    (cond
      muted-tap?
      nil

      (and double-tap? (some? hover))
      (st/emit! (mse/->MouseEvent :click false false false false)
                (dw/select-shape (:id hover))
                (dw/start-editing-selected))

      (some? hover)
      (do (swap! st* assoc :tap-last-ts now :tap-last-pos anchor)
          (st/emit! (mse/->MouseEvent :click false false false false)
                    (dw/select-shape (:id hover))))

      :else
      ;; Tap on the empty canvas: click + deselect all. We deliberately avoid
      ;; the area-selection marquee here: it is a WatchEvent that needs a real
      ;; mouse-up after its subscription lands, and a tap fires :up within the
      ;; same synchronous emit batch, which the watcher never observes.
      (do (swap! st* assoc :tap-last-ts now :tap-last-pos anchor)
          (st/emit! (mse/->MouseEvent :click false false false false)
                    (dw/deselect-all))))))

;; --------------------------------------------------------------------------
;; Event handlers (attached at window, capture phase)
;; --------------------------------------------------------------------------

(defn- on-touch-down
  [st* move-stream workspace-read-only? drawing-tool drawing-path?]
  (fn [event]
    (let [target (dom/get-target event)]
      (when (and (= (.-pointerType event) "touch")
                 (uwvv/inside-viewport? target))
        (case (:stage @st*)
          :idle
          (if (or (reactive-ui-target? target)
                  (gizmo-ancestor? target)
                  (should-pass-through? drawing-tool drawing-path?))
            ;; Penpot owns this one (gizmo resize, toolbar button, drawing,
            ;; text edition...). Register it for pinch upgrade but pass the
            ;; single-finger events through untouched.
            (swap! st* assoc :stage :external
                           :pointers {(.-pointerId event) (client-pos event)})
            (do
              (dom/stop-propagation event)
              (dom/prevent-default event)
              (begin-own-gesture! st* event move-stream)))

          (:pending :drag :pan :external)
          ;; A second finger always upgrades to canvas navigation.
          (do
            (dom/stop-propagation event)
            (dom/prevent-default event)
            (abort-own-gesture! st*)
            (swap! st* assoc :stage :navigate
                           :mode :own
                           :muted-tap? true
                           :pointers (assoc (:pointers @st*)
                                            (.-pointerId event) (client-pos event))
                           :pinch {:dist nil :cx 0 :cy 0}))

          :navigate
          ;; Third+ finger: just track it, do not start new semantics.
          (swap! st* assoc :pointers
                         (assoc (:pointers @st*) (.-pointerId event) (client-pos event)))

          nil)))))

(defn- on-touch-move
  [st* move-stream workspace-read-only?]
  (fn [event]
    (when (= (.-pointerType event) "touch")
      (case (:stage @st*)
        :pending
        (let [id (.-pointerId event)]
          (when (contains? (:pointers @st*) id)
            (dom/stop-propagation event)
            (dom/prevent-default event)
            (advance-pending! st* move-stream event workspace-read-only?)))

        (:drag :pan)
        (let [id (.-pointerId event)]
          (when (contains? (:pointers @st*) id)
            (dom/stop-propagation event)
            (dom/prevent-default event)
            (advance-own-move! st* move-stream event)))

        :navigate
        (let [id (.-pointerId event)]
          (when (contains? (:pointers @st*) id)
            (dom/stop-propagation event)
            (dom/prevent-default event)
            (advance-navigation! st* event)))

        :external
        nil

        :idle
        nil))))

(defn- on-touch-up
  [st* move-stream workspace-read-only?]
  (fn [event]
    (when (= (.-pointerType event) "touch")
      (case (:stage @st*)
        :pending
        (let [id (.-pointerId event)]
          (when (contains? (:pointers @st*) id)
            (dom/stop-propagation event)
            (dom/prevent-default event)
            (finish-tap! st*)
            (reset! st* (new-state))))

        (:drag :pan)
        (let [id (.-pointerId event)]
          (when (contains? (:pointers @st*) id)
            (dom/stop-propagation event)
            (dom/prevent-default event)
            (st/emit! (mse/->MouseEvent :up false false false false)
                      (dw/finish-panning)
                      (dw/finish-zooming))
            (reset! st* (new-state))))

        :navigate
        (do
          (dom/stop-propagation event)
          (dom/prevent-default event)
          (let [pointers (dissoc (:pointers @st*) (.-pointerId event))]
            (if (seq pointers)
              ;; One finger lifted: keep the survivor, but do not let it tap.
              (let [survivor (-> pointers vals first)]
                (swap! st* assoc :pointers pointers
                               :stage :pending
                               :muted-tap? true
                               :anchor survivor
                               :last survivor))
              (do
                (st/emit! (dw/finish-panning)
                          (dw/finish-zooming))
                (reset! st* (new-state))))))

        :external
        (let [id (.-pointerId event)]
          (when (contains? (:pointers @st*) id)
            (reset! st* (new-state))))

        :idle
        nil))))

(defn- on-touch-cancel
  [st*]
  (fn [event]
    (when (and (= (.-pointerType event) "touch")
               (contains? #{:pending :drag :pan :navigate :external} (:stage @st*)))
      (dom/stop-propagation event)
      (abort-own-gesture! st*)
      (reset! st* (new-state)))))

(defn- setup-ime-guard
  [st*]
  (let [vv (.-visualViewport js/window)]
    (when vv
      (let [handler (fn []
                      (when (contains? #{:pending :drag :pan :navigate :external}
                                       (:stage @st*))
                        (abort-own-gesture! st*)
                        (reset! st* (new-state))))]
        (.addEventListener vv "resize" handler)
        (fn [] (.removeEventListener vv "resize" handler))))))

(defn setup-mobile-gestures
  "Hook that wires the touch gesture machine. Call it from a component that
  renders the viewport (guarded by `touch-capable?` internally). Mouse users
  are completely unaffected."
  [workspace-read-only? drawing-tool drawing-path? move-stream]
  (let [st* (mf/use-ref (new-state))]
    (mf/with-effect []
      (when (touch-capable?)
        (let [down   (on-touch-down st* move-stream workspace-read-only? drawing-tool drawing-path?)
              move   (on-touch-move st* move-stream workspace-read-only?)
              up     (on-touch-up st* move-stream workspace-read-only?)
              cancel (on-touch-cancel st*)
              keys   [(events/listen js/window EventType.POINTERDOWN down
                                     #js {:capture true :passive false})
                      (events/listen js/window EventType.POINTERMOVE move
                                     #js {:capture true :passive false})
                      (events/listen js/window EventType.POINTERUP up
                                     #js {:capture true :passive false})
                      (events/listen js/window EventType.POINTERCANCEL cancel
                                     #js {:capture true :passive false})]
              ime    (setup-ime-guard st*)]
          (fn []
            (doseq [key keys]
              (events/unlistenByKey key))
            (when ime (ime))))))))