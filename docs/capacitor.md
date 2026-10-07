---
title: Capacitor
description: defineCapacitorPreset, the merge rules, and the Android version scaffold.
---

`defineCapacitorPreset({ appId, appName, ... })` returns a plain `CapacitorConfig`-shaped object.
Import the real `CapacitorConfig` type from `@capacitor/cli` in your project; this package takes no
dependency on it.

The defaults are `webDir: "dist"`, `server.androidScheme: "https"`, `android.path: "android"`,
`android.allowMixedContent: false`, and `android.webContentsDebuggingEnabled` derived from the
`CAP_DEBUG` environment variable (`debugEnvVar` renames it).

## Merge rules

`overrides` is merged over the defaults by `mergeCapacitorConfig`:

- `server`, `android` and `ios` merge one level deep, so
  `overrides: { server: { hostname: "game.local" } }` keeps `server.androidScheme`.
- `plugins` merges per plugin: each plugin's options object merges one level deep, and plugins named
  on only one side pass through.
- Inside a merged object the override wins per key. To unset a preset key, pass it explicitly as
  `undefined`.
- Every other key (`appId`, `webDir`, `backgroundColor`) is replaced wholesale, as are arrays and
  anything below the merged level.

```ts
import { defineCapacitorPreset } from "build-preset/capacitor";

export default defineCapacitorPreset({
  appId: "com.example.game",
  appName: "Game",
  overrides: {
    server: { hostname: "game.local" }, // androidScheme: "https" is kept
    android: { allowMixedContent: true }, // wins over the preset's false
  },
});
```

Neither input of `mergeCapacitorConfig(base, overrides)` is mutated, so it also layers
environment-specific config on top of any config object.

## Android version scaffold

`npx build-preset init-android` prints the block to paste into `android/app/build.gradle`'s
`defaultConfig`, replacing the hardcoded `versionCode 1` and `versionName "1.0"`. Build with
`./gradlew bundleRelease -PversionName=$npm_package_version -PversionCode=${ANDROID_VERSION_CODE:-1}`.
The same text is available as `androidVersionGradleSnippet()`.

Release workflow YAML is not part of this package: signing identity, ABI policy and release
verification are application-specific and must fail closed, and a release job must never substitute
a debug APK when production signing material is missing.
