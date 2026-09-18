#!/usr/bin/env node
//
// patch-gradle-signing.mjs
//
// Pin the DEBUG signingConfig to the committed keystore (android-keys/debug.keystore)
// so every CI build produces an APK signed by the SAME certificate. Otherwise
// each run ships a freshly-generated debug key and `adb install -r` upgrades
// fail with INSTALL_FAILED_UPDATE_INCOMPATIBLE (signatures do not match).
//
// Appended as an extra `android { }` block, which is allowed in both the Groovy
// and Kotlin DSL; it is template-shape agnostic. `debug` resolves AGP's default
// debug signer, whose fields we then overwrite.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const candidates = ["android/app/build.gradle.kts", "android/app/build.gradle"];
const gradlePath = candidates.find((p) => existsSync(p));
if (!gradlePath) {
  console.error("patch-gradle-signing: no build.gradle(.kts) under android/app");
  process.exit(1);
}

let kts = readFileSync(gradlePath, "utf8");

if (kts.includes("../android-keys/debug.keystore")) {
  console.log("patch-gradle-signing: already deterministic");
  process.exit(0);
}

const isKotlin = gradlePath.endsWith(".kts");

const block = isKotlin
  ? `
android {
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("../android-keys/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
}
`
  : `
android {
    signingConfigs {
        debug {
            storeFile rootProject.file("../android-keys/debug.keystore")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }
}
`;

writeFileSync(gradlePath, kts + block);
console.log(
  `patch-gradle-signing: pinned debug signingConfig in ${gradlePath} to ../android-keys/debug.keystore`
);