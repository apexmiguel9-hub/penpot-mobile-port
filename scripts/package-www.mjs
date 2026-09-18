#!/usr/bin/env node
//
// package-www.mjs <bundle-dist> <backend-uri>
//
// Rebuilds ./www from a freshly built Penpot frontend bundle:
//   1. clears ./www and copies every file from <bundle-dist> into it
//   2. drops in js/config.js pointing the app at <backend-uri>
//
// The patched CLJS gesture layer is already compiled inside the bundle, so the
// standalone touch shim (penpot-touch-shim.js, for unpatched/remote hosts) is
// intentionally NOT referenced here. Add it back yourself if you switch to a
// remote (unpatched) server.url in capacitor.config.json.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [dist, backend] = process.argv.slice(2);

if (!dist || !backend) {
  console.error("usage: node scripts/package-www.mjs <bundle-dist> <backend-uri>");
  process.exit(1);
}

const www = resolve("www");
const distDir = resolve(dist);

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(distDir, www, { recursive: true });

// Penpot's runtime config is a global that the bundle's index.html loads as
// `./js/config.js`. Everything else (auth, media assets, websockets, export)
// is derived from penpotPublicURI, so a single global is enough for the POC.
const ucBackend = (backend ?? "").replace(/\/+$/, "") + "/";
const config = `window.penpotPublicURI = "${ucBackend}";\nwindow.penpotThemes = ["default"];\nwindow.penpotFlags = {};\n`;
mkdirSync(join(www, "js"), { recursive: true });
writeFileSync(join(www, "js", "config.js"), config);

console.log(`www ready (${www}) — backend: ${ucBackend}`);
console.log("  index.html:", readMaybe(join(www, "index.html")));
  console.log("  config.js :", readMaybe(join(www, "js", "config.js")));

  function readMaybe(p) {
    try {
      return readFileSync(p, "utf8").split("\n")[0].slice(0, 80);
    } catch {
      return "(missing)";
    }
  }