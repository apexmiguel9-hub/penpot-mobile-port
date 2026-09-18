#!/usr/bin/env node
//
// patch-main-activity.mjs <mode>
//
// Remote mode: the WebView loads a hosted Penpot (server.url). Two things that
// a plain WebView gets wrong are fixed here:
//
//   1. The patched CLJS gesture layer is NOT bundled in remote mode, so we
//      inject the standalone touch shim (www/penpot-touch-shim.js) into the
//      Penpot pages via WebViewClient.onPageFinished(). Auth pages (Google) are
//      skipped so our eval never touches their DOM or trips their heuristics.
//
//   2. Google OAuth hand-off. Penpot's frontend navigates to accounts.google.com
//      from INSIDE the WebView. Google detects the embedded WebView and escapes
//      to the system Chrome either via an `intent://` URL or by opening a new
//      window; the `penpot-session` Set-Cookie then lands in Chrome's cookie
//      jar and the app stays logged out. We:
//        - rewrite `intent://...` (honouring `browser_fallback_url`) and load
//          the resolved https URL in the SAME WebView (cancelling the hand-off),
//        - route window.open() popups into the main WebView,
//        - enable third-party cookies so Google's auth cookies survive.
//
// Local mode: no-op (the patched CLJS build owns touch input and CORS is the
// developer's problem on their own backend; the shim would double-register).

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

// Escape the shim exactly once: real newlines -> "\n" chars, backslashes and
// double quotes escaped. The wrapper only uses single quotes (and the shim is
// already escaped), so the concatenated result is plain valid Java.
const shimLiteral = javaEscape(shim);

// Inject the raw shim. It is self-guarding (window.__penpotTouchShim) and
// self-arming (readyState/DOMContentLoaded check), so evaluating it on every
// Penpot onPageFinished is safe and idempotent per document. We deliberately
// do NOT evaluate it at launch: the first-load document (about:blank) is torn
// down when the real page commits, killing any pending timers, and an eval
// against "about:blank" can throw.
const shimJava = shimLiteral;

const activityTemplate = (pkg) =>
  `package ${pkg};

import android.os.Message;
import android.net.Uri;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.BridgeActivity;

import java.net.URLDecoder;

public class MainActivity extends BridgeActivity {

    private static final String TOUCH_SHIM = "${shimJava}";

    private boolean interceptorsInstalled = false;

    @Override
    public void onResume() {
        super.onResume();
        maybeRequestStoragePermission();
        if (!interceptorsInstalled) {
            interceptorsInstalled = true;
            WebView webView = getBridge() != null ? getBridge().getWebView() : null;
            if (webView != null) {
                installLoginInterceptors(webView);
            }
        }
    }

    /**
     * Image imports go through onShowFileChooser (system picker, SAF content
     * URIs) which does not need any manifest permission, but stock Penpot can
     * touch the media store directly on some API levels. Ask once, up-front.
     */
    private void maybeRequestStoragePermission() {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                if (checkSelfPermission(android.Manifest.permission.READ_MEDIA_IMAGES)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{android.Manifest.permission.READ_MEDIA_IMAGES}, 9101);
                }
            } else if (android.os.Build.VERSION.SDK_INT >= 23) {
                if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{android.Manifest.permission.READ_EXTERNAL_STORAGE}, 9102);
                }
            }
        } catch (Exception ignored) { }
    }

    /**
     * Keep sign-in flows (Google OAuth) entirely inside this WebView so the
     * session cookie lands in OUR cookie jar, not in the external Chrome's.
     */
    private static void installLoginInterceptors(final WebView webView) {
        final WebViewClient originalClient = webView.getWebViewClient();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return intercept(view, url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return intercept(view, request.getUrl().toString());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (originalClient != null) {
                    originalClient.onPageFinished(view, url);
                }
                if (shouldInjectTouchShim(url)) {
                    android.util.Log.d("PenpotMobile", "injecting touch shim on " + url);
                    view.evaluateJavascript(TOUCH_SHIM, null);
                }
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (originalClient != null) {
                    originalClient.onPageStarted(view, url, favicon);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (originalClient != null) {
                    originalClient.onReceivedError(view, request, error);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse errorResponse) {
                if (originalClient != null) {
                    originalClient.onReceivedHttpError(view, request, errorResponse);
                }
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                if (originalClient != null) {
                    originalClient.doUpdateVisitedHistory(view, url, isReload);
                }
            }

            private boolean intercept(WebView view, String url) {
                android.util.Log.d("PenpotMobile", "shouldOverrideUrlLoading: scheme=" + (url != null ? url + "" : "NULL"));
                if (url == null) {
                    return false;
                }
                if (url.startsWith("intent://")) {
                    String resolved = resolveIntentUrl(url);
                    android.util.Log.d("PenpotMobile", "intent:// -> " + resolved);
                    view.loadUrl(resolved);
                    return true;
                }
                if (url.startsWith("http:") || url.startsWith("https:")) {
                    android.util.Log.d("PenpotMobile", "internal https navigation");
                    return false;
                }
                android.util.Log.d("PenpotMobile", "scheme " + url.substring(0, Math.min(20, url.length())) + " -> original client");
                return originalClient != null && originalClient.shouldOverrideUrlLoading(view, url);
            }
        });

        final WebChromeClient originalChrome = webView.getWebChromeClient();

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                android.util.Log.d("PenpotMobile", "onCreateWindow (popup) isDialog=" + isDialog);
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(webView);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (originalChrome != null) {
                    return originalChrome.onShowFileChooser(view, filePathCallback, fileChooserParams);
                }
                return super.onShowFileChooser(view, filePathCallback, fileChooserParams);
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                if (originalChrome != null) return originalChrome.onJsAlert(view, url, message, result);
                return super.onJsAlert(view, url, message, result);
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                if (originalChrome != null) return originalChrome.onJsConfirm(view, url, message, result);
                return super.onJsConfirm(view, url, message, result);
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
                if (originalChrome != null) return originalChrome.onJsPrompt(view, url, message, defaultValue, result);
                return super.onJsPrompt(view, url, message, defaultValue, result);
            }
        });

        // Google's auth cookies must survive the redirect chain back to Penpot.
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
    }

    /**
     * Only inject the shim into Penpot app pages. Auth pages (accounts.google.*,
     * cloud storage providers, etc.) must never receive our eval — both to avoid
     * noise and to not trip Google's embedded-WebView heuristics.
     */
    private static boolean shouldInjectTouchShim(String url) {
        if (url == null) return false;
        try {
            String host = android.net.Uri.parse(url).getHost();
            if (host == null) return false;
            host = host.toLowerCase();
            if (host.startsWith("accounts.google.") || host.startsWith("myaccount.google.")) return false;
            if (host.endsWith(".googleusercontent.com") || host.endsWith("gstatic.com")) return false;
            if (host.endsWith(".googleapis.com") || host.endsWith("google.com")) return false;
            if (host.endsWith(".youtube.com")) return false;
            if (host.endsWith(".github.com")) return false;
            return true;
        } catch (Exception ex) {
            return false;
        }
    }

    /**
     * intent://host/path#Intent;scheme=https;package=...;S.browser_fallback_url=...;end
     * resolves to the equivalent https URL so nothing leaves the WebView.
     */
    private static String resolveIntentUrl(String url) {
        try {
            int fb = url.indexOf("browser_fallback_url=");
            if (fb >= 0) {
                String raw = url.substring(fb + "browser_fallback_url=".length());
                int end = raw.indexOf(';');
                if (end > 0) raw = raw.substring(0, end);
                String decoded = URLDecoder.decode(raw, "UTF-8");
                android.util.Log.d("PenpotMobile", "resolveIntentUrl fallback=" + decoded);
                return decoded;
            }
            String path = url.substring("intent://".length());
            int hash = path.indexOf("#Intent;");
            if (hash > 0) path = path.substring(0, hash);
            String scheme = "https";
            int sc = url.indexOf("scheme=");
            if (sc >= 0) {
                String s = url.substring(sc + "scheme=".length());
                int e = s.indexOf(';');
                if (e > 0) s = s.substring(0, e);
                if (!s.isEmpty()) scheme = s;
            }
            if (path.isEmpty()) return url;
            return scheme + "://" + path;
        } catch (Exception ex) {
            return url;
        }
    }
}
`;

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

writeFileSync(activity, activityTemplate(pkg));
console.log(
  `patch-main-activity: injected shim + OAuth interceptors into ${activity} (${shimJava.length} chars embedded)`
);