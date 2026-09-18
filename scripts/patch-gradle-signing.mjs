#!/usr/bin/env node
//
// patch-gradle-signing.mjs
//
// Pin the DEBUG signingConfig to the committed keystore (android-keys/debug.keystore)
// so every CI build produces an APK signed by the SAME certificate. Otherwise
// each run ships a freshly-generated debug key and `adb install -r` upgrades
// fail with INSTALL_FAILED_UPDATE_INCOMPATIBLE (signatures do not match).
//
// Appended as an extra `android { }` block, which the Gradle Kotlin DSL allows;
// it is template-shape agnostic. getByName("debug") resolves AGP's default
// debug signer, whose fields we then overwrite.

import { readFileSync, writeFileSync } from "node:fs";

const gradlePath = "android/app/build.gradle.kts";
let kts = readFileSync(gradlePath, "utf8");

if (kts.includes("../android-keys/debug.keystore")) {
  console.log("patch-gradle-signing: already deterministic");
  process.exit(0);
}

const block = `
// Deterministic debug signing: reuse the committed keystore so every build is
// signed with the same certificate and adb install -r works across builds.
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
`;

writeFileSync(gradlePath, kts + block);
console.log("patch-gradle-signing: pinned debug signingConfig to android-keys/debug.keystore");