#!/usr/bin/env node
//
// patch-capacitor-config.mjs <mode> [backend-uri]
//
// Rewrites capacitor.config.json for the desired serve mode:
//   remote  -> server.url = <backend-uri> (WebView opens the hosted Penpot:
//              same-origin, no CORS. Gestures come from the shim injected into
//              MainActivity by patch-main-activity.mjs).
//   local   -> no server.url (bundled www/ is served from https://localhost;
//              requires a self-hosted backend that sends CORS headers for that
//              origin). Patched CLJS gesture layer is compiled into the bundle.

import { readFileSync, writeFileSync } from "node:fs";

const [mode, backend] = process.argv.slice(2);

if (!["remote", "local"].includes(mode)) {
  console.error("usage: node scripts/patch-capacitor-config.mjs <remote|local> [backend-uri]");
  process.exit(1);
}

const path = "capacitor.config.json";
const cfg = JSON.parse(readFileSync(path, "utf8"));

if (mode === "remote") {
  if (!backend) {
    console.error("remote mode requires a backend-uri");
    process.exit(1);
  }
  cfg.server = {
    url: backend.replace(/\/+$/, ""),
    cleartext: true,
    androidScheme: "https",
  };
  cfg.android = { allowMixedContent: true };
  console.log(`capacitor.config.json → remote (${cfg.server.url})`);
} else {
  delete cfg.server;
  cfg.android = { allowMixedContent: true };
  console.log("capacitor.config.json → local bundle (no server.url)");
}

writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");