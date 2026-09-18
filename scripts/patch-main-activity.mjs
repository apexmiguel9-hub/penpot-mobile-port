#!/usr/bin/env node
//
// patch-main-activity.mjs <mode>
//
// Remote mode: the WebView talks to a hosted Penpot (server.url), so the
// bundled CLJS gesture layer is NOT the one running — we inject the standalone
// touch shim (www/penpot-touch-shim.js) straight into the page instead.
//
// This rewrites the Capacitor-generated MainActivity.java so that, as soon as
// the page finishes loading, it evaluates the shim. The shim is self-guarded
// (won't re-apply on resume/config-change) and only acts on touch pointers, so
// mouse/desktop behavior is untouched.
//
// Local mode: no-op (the patched CLJS build already owns touch input; loading
// the shim on top would duplicate the capture-phase gesture listeners).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode] = process.argv.slice(2);

if (mode !== "remote") {
  console.log("patch-main-activity: skipped (local mode)");
  process.exit(0);
}

const shimPath = "www/penpot-touch-shim.js";
if (!existsSync(shimPath)) {
  console.error(`patch-main-activity: ${shimPath} not found`);
  process.exit(1);
}

const shim = readFileSync(shimPath, "utf8");

// Java string literal escaping. Order matters: real newlines -> "\n" chars,
// then backslashes (incl. the ones just introduced) and double quotes.
const javaEscape = (s) =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

const shimLiteral = javaEscape(shim);

// Poll until the page is truly ready, then run the shim. The shim itself also
// waits on DOMContentLoaded, so evaluating against a not-yet-ready document is
// safe; the guard flag prevents a double install on onResume/config changes.
const bootstrap =
  "(function(){" +
  "var t=setInterval(function(){" +
  'if(document.readyState==="complete"){clearInterval(t);' +
  `${shimLiteral}` +
  "}},500);" +
  "setTimeout(function(){clearInterval(t);},60000);" +
  "})();";

function findMainActivity(dir) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const hit = findMainActivity(full);
      if (hit) return hit;
    } else if (entry === "MainActivity.java") {
      return full;
    }
  }
  return null;
}

const activity = findMainActivity("android/app/src/main/java");
if (!activity) {
  console.error("patch-main-activity: MainActivity.java not found under android/");
  process.exit(1);
}

const original = readFileSync(activity, "utf8");

const pkg = original.match(/^package\s+([\w.]+);/m)?.[1];
if (!pkg) {
  console.error("patch-main-activity: cannot detect package in " + activity);
  process.exit(1);
}

if (original.includes("TOUCH_SHIM")) {
  console.log(`patch-main-activity: already patched (${activity})`);
  process.exit(0);
}

const patched =
  `package ${pkg};\n\n` +
  `import android.webkit.WebView;\n` +
  `import com.getcapacitor.BridgeActivity;\n\n` +
  `public class MainActivity extends BridgeActivity {\n\n` +
  `    private static final String TOUCH_SHIM = "${bootstrap}";\n\n` +
  `    private boolean touchShimInjected = false;\n\n` +
  `    @Override\n` +
  `    public void onResume() {\n` +
  `        super.onResume();\n` +
  `        if (!touchShimInjected) {\n` +
  `            touchShimInjected = true;\n` +
  `            WebView webView = getBridge() != null ? getBridge().getWebView() : null;\n` +
  `            if (webView != null) {\n` +
  `                webView.evaluateJavascript(TOUCH_SHIM, null);\n` +
  `            }\n` +
  `        }\n` +
  `    }\n` +
  `}\n`;

writeFileSync(activity, patched);
console.log(`patch-main-activity: injected touch shim into ${activity} (${shimLiteral.length} chars embedded)`);