export interface DefineCapacitorPresetOptions {
  /** Reverse-DNS app id, e.g. "com.jbcom.littlelegends". */
  appId: string;
  /** Human-readable app name shown on the device. */
  appName: string;
  /**
   * Env var name gating WebView debugging (little-legends pattern,
   * generalized). Reads `process.env[debugEnvVar] === "true"`.
   * Defaults to "CAP_DEBUG".
   */
  debugEnvVar?: string;
  /** Splash/background color, e.g. "#141b2e". */
  backgroundColor?: string;
  /** webDir Capacitor packages from a build output — defaults to "dist". */
  webDir?: string;
  /** Native android project path — defaults to "android". */
  androidPath?: string;
  /** Merged last — the escape hatch for anything preset-specific. */
  overrides?: Record<string, unknown>;
}

/**
 * Capacitor config factory. Returns a plain object shaped like
 * `CapacitorConfig` (the caller imports the real type from `@capacitor/cli`
 * to avoid this package taking a hard dependency on it).
 */
export function defineCapacitorPreset(
  options: DefineCapacitorPresetOptions,
): Record<string, unknown> {
  const {
    appId,
    appName,
    debugEnvVar = "CAP_DEBUG",
    backgroundColor,
    webDir = "dist",
    androidPath = "android",
    overrides = {},
  } = options;

  const debuggable = process.env[debugEnvVar] === "true";

  const preset: Record<string, unknown> = {
    appId,
    appName,
    webDir,
    ...(backgroundColor ? { backgroundColor } : {}),
    server: {
      androidScheme: "https",
    },
    android: {
      path: androidPath,
      allowMixedContent: false,
      webContentsDebuggingEnabled: debuggable,
    },
  };

  return { ...preset, ...overrides };
}

export interface InitAndroidOptions {
  /** Target directory to scaffold android/ into. Defaults to cwd. */
  cwd?: string;
  /** Reverse-DNS app id used to seed applicationId/namespace. */
  appId: string;
  /** Human-readable app name (used in comments only; Capacitor CLI drives the actual native project name). */
  appName?: string;
}

/**
 * Generates the CI-parameterized versionName/versionCode override block
 * consumers should apply to their `android/app/build.gradle` `defaultConfig`
 * after running `cap add android` / `cap sync android`. Ported from the
 * legacy arcade-cabinet shell's
 * `-PversionName=$npm_package_version -PversionCode=${ANDROID_VERSION_CODE:-1}`
 * convention, which little-legends's own android/app/build.gradle lacked
 * (hardcoded `versionCode 1` / `versionName "1.0"`).
 */
export function androidVersionGradleSnippet(): string {
  return [
    "        // Parameterized by CI: pnpm android:bundle passes",
    "        // -PversionName=$npm_package_version -PversionCode=${ANDROID_VERSION_CODE:-1}",
    "        versionCode (project.hasProperty('versionCode') ? project.property('versionCode').toInteger() : 1)",
    "        versionName (project.hasProperty('versionName') ? project.property('versionName') : \"1.0\")",
  ].join("\n");
}

/** Signed-if-secret-else-debug release.yml Android job body, little-legends's pattern, as a reusable template string. */
export function androidReleaseWorkflowSnippet(appSlug: string): string {
  return `      - name: Build release APK
        working-directory: android
        env:
          ANDROID_KEYSTORE_BASE64: \${{ secrets.ANDROID_KEYSTORE_BASE64 }}
          ANDROID_KEYSTORE_PASSWORD: \${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          ANDROID_KEY_ALIAS: \${{ secrets.ANDROID_KEY_ALIAS }}
          ANDROID_KEY_PASSWORD: \${{ secrets.ANDROID_KEY_PASSWORD }}
        run: |
          if [ -n "\${ANDROID_KEYSTORE_BASE64}" ]; then
            echo "\${ANDROID_KEYSTORE_BASE64}" | base64 --decode > release.keystore
            ./gradlew clean assembleRelease \\
              -Pandroid.injected.signing.store.file="$PWD/release.keystore" \\
              -Pandroid.injected.signing.store.password="\${ANDROID_KEYSTORE_PASSWORD}" \\
              -Pandroid.injected.signing.key.alias="\${ANDROID_KEY_ALIAS}" \\
              -Pandroid.injected.signing.key.password="\${ANDROID_KEY_PASSWORD}"
          else
            echo "No signing keystore secret — building debug APK"
            ./gradlew clean assembleDebug
          fi

      - name: Shred decoded keystore
        if: always()
        working-directory: android
        run: rm -f release.keystore

      - name: Attach APK to release
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          apk=$(find android/app/build/outputs/apk -name '*.apk' | head -1)
          cp "$apk" "${appSlug}-\${TARGET_REF}.apk"
          gh release upload "\${TARGET_REF}" "${appSlug}-\${TARGET_REF}.apk" --clobber
`;
}
