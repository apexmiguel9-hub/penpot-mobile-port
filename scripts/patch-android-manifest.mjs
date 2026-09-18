#!/usr/bin/env node
//
// patch-android-manifest.mjs
//
// The AndroidManifest.xml is generated fresh by `npx cap add android` on every
// CI run, so the storage permissions that MainActivity.maybeRequestStoragePermission()
// asks for at runtime must be (re)declared here. Applies to both modes.
//
//   - READ_MEDIA_IMAGES      : Android 13+ (API 33) media read permission.
//   - READ_EXTERNAL_STORAGE  : API 32 and below (maxSdkVersion=32; replaced by
//                              READ_MEDIA_* on 33+).
//   - requestLegacyExternalStorage : bypass scoped storage on API 29-30 so the
//                              WebView can read picked files.

import { readFileSync, writeFileSync } from "node:fs";

const manifestPath = "android/app/src/main/AndroidManifest.xml";
let xml = readFileSync(manifestPath, "utf8");

if (xml.includes("READ_MEDIA_IMAGES")) {
  console.log("patch-android-manifest: permissions already present");
  process.exit(0);
}

const perms =
  '    <uses-permission android:name="android.permission.INTERNET" />\n' +
  '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n' +
  '    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />\n';

if (xml.includes('<uses-permission android:name="android.permission.INTERNET"')) {
  xml = xml.replace(
    '<uses-permission android:name="android.permission.INTERNET" />\n',
    perms
  );
} else {
  xml = xml.replace("<application", perms + "<application");
}

if (!xml.includes("requestLegacyExternalStorage")) {
  xml = xml.replace("<application", '<application android:requestLegacyExternalStorage="true"');
}

writeFileSync(manifestPath, xml);
console.log("patch-android-manifest: permissions injected");