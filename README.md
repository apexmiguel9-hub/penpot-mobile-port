# Penpot Mobile — POC de shell Android con gestos táctiles

Empaqueta el **frontend 100% web de Penpot** en un WebView Android, igual que
VS Code lo es para Chromium, y añade la capa de gestos que Penpot no tiene.

Dos vías para los gestos:

| Vía | Dónde vive | Alcance | Coste |
|---|---|---|---|
| **Parche CLJS integrado** (recomendado) | `frontend/src/.../mobile_gestures.cljs` en el repo Penpot | Slop de 8px, drag de objetos, pan 1 dedo en lienzo vacío, pinch 2 dedos, doble-tap para editar, hitboxes expandidos, guarda IME | Rebuild del frontend |
| **Shim JS inyectable** | `www/penpot-touch-shim.js` | Pinch 2 dedos, pan 2 dedos, hitboxes expandidos, guarda IME | Sin rebuild (despliegue sin parchar) |

---

## 1. Qué resuelve el módulo CLJS (`mobile_gestures.cljs`)

La máquina de estados de entrada táctil atiende exactamente los 4 problemas
que fallan en Android real:

1. **Disambiguación calculada por la propia máquina de Penpot**
   - Toque en gizmos de selección (`.resize-handler`, `.viewport-selrect`,
     `.rotate-handler`), botones de toolbar o herramientas activas (pencil,
     texto, path) → **passthrough**: Penpot conserva su comportamiento de
     resize/move/draw, y el pan 1-dedo nunca se activa ahí (regla del usuario:
     *si el toque cae en el objeto seleccionado o sus handles, no hay pan*).
   - Toque en lienzo/shape → lo toma la máquina y decide con el **mismo
     hover del quadtree** que usa el ratón (alimentado por `move-stream`).
2. **Touch slop de 8px** antes de confirmar el drag de un objeto (los temblores
   del dedo no mueven nada).
3. **Navegación reservada a dos dedos**: pinch-zoom y pan se mapean al pipeline
   de `schedule-zoom!`/`schedule-scroll!` (los mismos acumuladores rAF que usa
   el wheel del ratón) vía `st/emit!` de `mse/PointerEvent`. No se sintetiza
   ningún evento DOM; se reutiliza el pipeline de datos de Penpot.
4. **Hitboxes invisibles de 24px+** (`stroke: transparent` +
   `vector-effect: non-scaling-stroke`) sobre los handles de ~8px
   (`mobile_gestures.scss`, scope `@media (pointer: coarse)`).
5. **Guarda IME**: `visualViewport.onresize` (teclado Android) aborta limpiamente
   cualquier gesto en vuelo para que las coordenadas del canvas no se descalibren.

El ratón no se toca: todo está filtrado por `pointerType === "touch"` y la
máquina se monta solo si `navigator.maxTouchPoints > 0`.

## 2. El parche: `patches/`

Este repo **no** contiene un fork del monorepo de Penpot: guarda solo el parche
(módulo CLJS + 3 archivos integrados) y lo aplica sobre un upstream *pineado*
(`patches/PENPOT_COMMIT`):

```
patches/
  PENPOT_COMMIT                              # commit upstream verificado
  apply.sh <penpot-checkout-dir>             # copia los archivos + sanity-checks
  frontend/src/app/main/ui/workspace/viewport/
    mobile_gestures.cljs   (nuevo)
    mobile_gestures.scss   (nuevo)
    actions.cljs           (+make-viewport-input-state, schedulers públicos)
    hooks.cljs             (+setup-mobile-gestures)
  frontend/src/app/main/ui/workspace/viewport.cljs       (pasa move-stream)
  frontend/src/app/main/ui/workspace/viewport_wasm.cljs  (pasa move-stream)
  frontend/src/app/main/ui/workspace/viewport.scss / viewport_wasm.scss (@use mobile_gestures)
```

## 3. Build (local)

```bash
git clone --depth 1 --branch <branch> https://github.com/penpot/penpot.git
git -C penpot fetch --depth 1 origin "$(cat patches/PENPOT_COMMIT)"
git -C penpot checkout "$(cat patches/PENPOT_COMMIT)"
./patches/apply.sh penpot

# El frontend se compila igual que upstream: dentro de penpotapp/devenv
# (Node/pnpm + JDK + Clojure CLI + Rust wasm32-emscripten + emsdk).
docker run --rm \
  --mount source=$PWD/penpot,type=bind,target=/home/penpot/penpot \
  -e EXTERNAL_UID=$(id -u) -e BUILD_WASM=yes \
  -w /home/penpot/penpot/frontend \
  penpotapp/devenv:latest sudo -EH -u penpot ./scripts/build develop
# Bundle estático: penpot/frontend/target/dist
```

## 4. Build (CI/CD)

`.github/workflows/build-apk.yml` hace exactamente esto en GitHub Actions y deja
el APK de debug como artefacto (`penpot-mobile-debug`):

1. Fija el commit de Penpot desde `patches/PENPOT_COMMIT` y aplica `apply.sh`.
2. Compila el frontend dentro de `penpotapp/devenv` (frío: ~40-60 min; pnpm,
   maven y cargo se cachean entre runs con `actions/cache`).
3. `scripts/package-www.mjs` copia `frontend/target/dist` → `www/` y escribe
   `www/js/config.js` con `window.penpotPublicURI = <backend>`.
4. `npx cap add android && cap sync android` y `gradlew assembleDebug`.

Dispara manualmente con **workflow_dispatch**, o en cada push a `main`. Input
`backend_uri`: la URI del backend de Penpot (el app habla con él vía
`publicURI`; el bundle/UI viaja **local** en el APK).

## 5. Shell Android (este proyecto)

Prerrequisitos: Node ≥ 20, JDK 17+, Android SDK con `ANDROID_HOME` y build-tools.

```bash
npm install
npx cap add android
npx cap sync android
npm run build:apk   # → android/app/build/outputs/apk/debug/app-debug.apk
```

`capacitor.config.json` apunta a **local** (sin `server.url`): el WebView carga
el bundle empaquetado en `www/`. El backend se configura en tiempo de build en
`www/js/config.js` (`window.penpotPublicURI`).

> CORS: la WebView sirve desde `https://localhost`, así que el backend debe
> devolver cabeceras CORS para ese origen. En un deploy self-hosted:
> `PENPOT_FLAGS=enable-login-with-password ... --allow-origin https://localhost`
> (los flags equivalentes según tu versión).

1. Asegura el IME correcto en
   `android/app/src/main/AndroidManifest.xml`
   (dentro de `<activity>`):
   ```xml
   android:windowSoftInputMode="adjustResize"
   ```
2. Para **despliegue sin parchar** (modo remoto: `server.url` apuntando a un
   host Penpot sin parchear), inyecta el shim con `evaluateJavascript`
   en `MainActivity`:

   ```java
   import android.webkit.WebView;
   import android.webkit.WebViewClient;

   // dentro de MainActivity.onCreate, tras super.loadUrl(...):
   final String shim = "fetch('https://YOUR_HOST/penpot-touch-shim.js')"
         + ".then(r => r.text())"
         + ".then(t => webView.evaluateJavascript(t, null))"
         + ".catch(() => {});";
   WebView web = (WebView) findViewById(R.id.webview); // si usas hook directo
   ```

   Si compilas el frontend **con el parche CLJS**, el shim no hace falta y se
   recomienda NO inyectarlo (duplicaría los listeners de captura).

## 6. Limitaciones honestas (v1)

- El drag con 1 dedo sobre un objeto respeta slop solo en la vía CLJS. El shim
  deja el drag de objeto nativo de Penpot (sin slop).
- No hay pan con 1 dedo en la vía shim (la vía CLJS sí: toque en lienzo vacío).
- El doble-tap para editar texto existe en la vía CLJS, no en el shim.
- La UI sigue "de escritorio" (layout no responsive); la legibilidad se escala
  con CSS zoom sobre `:root` si se quiere (fuera del alcance de este POC).