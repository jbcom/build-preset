export interface DefineCapacitorPresetOptions {
  /** Reverse-DNS app id, e.g. "com.example.game". */
  appId: string;
  /** Human-readable app name shown on the device. */
  appName: string;
  /**
   * Env var name gating WebView debugging. Reads
   * `process.env[debugEnvVar] === "true"`.
   * Defaults to "CAP_DEBUG".
   */
  debugEnvVar?: string;
  /** Splash/background color, e.g. "#141b2e". */
  backgroundColor?: string;
  /** webDir Capacitor packages from a build output — defaults to "dist". */
  webDir?: string;
  /** Native android project path — defaults to "android". */
  androidPath?: string;
  /**
   * Merged last — the escape hatch for anything preset-specific. `server`,
   * `android`, `ios` and `plugins` merge into the preset's values (see
   * `mergeCapacitorConfig`); every other key replaces the preset's.
   */
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

  return mergeCapacitorConfig(preset, overrides);
}

type ConfigObject = Record<string, unknown>;

/** Platform sections merged one level deep: `{ ...preset.server, ...overrides.server }`. */
const SECTION_KEYS = ["server", "android", "ios"] as const;

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges Capacitor config layers without silently discarding preset defaults.
 *
 * - `server`, `android` and `ios` merge one level deep, so overriding
 *   `server.hostname` keeps the preset's `server.androidScheme`.
 * - `plugins` merges per plugin: each plugin's options object merges one level
 *   deep, and plugins present on only one side pass through.
 * - Within a merged object the override wins per key, including an explicit
 *   `undefined`, which is how a preset key is unset.
 * - Every other key (`appId`, `webDir`, ...) is replaced wholesale, as are
 *   arrays and any section whose override is not a plain object. An override of
 *   `undefined` for a merged section is ignored and leaves the preset's section.
 *
 * Neither input is mutated.
 */
export function mergeCapacitorConfig(preset: ConfigObject, overrides: ConfigObject): ConfigObject {
  const merged: ConfigObject = { ...preset, ...overrides };

  for (const key of SECTION_KEYS) {
    merged[key] = mergeSection(preset[key], overrides[key]);
    if (merged[key] === undefined) delete merged[key];
  }

  const plugins = mergePlugins(preset.plugins, overrides.plugins);
  if (plugins === undefined) delete merged.plugins;
  else merged.plugins = plugins;

  return merged;
}

function mergeSection(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) return { ...base, ...override };
  return override;
}

function mergePlugins(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: ConfigObject = { ...base };
  for (const [name, options] of Object.entries(override)) {
    merged[name] = mergeSection(base[name], options);
  }
  return merged;
}

/**
 * Generates the CI-parameterized versionName/versionCode override block
 * consumers should apply to their `android/app/build.gradle` `defaultConfig`
 * after running `cap add android` / `cap sync android`. It follows the
 * `-PversionName=$npm_package_version -PversionCode=${ANDROID_VERSION_CODE:-1}`
 * convention, which the generated build.gradle lacks (it hardcodes
 * `versionCode 1` / `versionName "1.0"`).
 */
export function androidVersionGradleSnippet(): string {
  return [
    "        // Parameterized by CI: pnpm android:bundle passes",
    "        // -PversionName=$npm_package_version -PversionCode=$" + "{ANDROID_VERSION_CODE:-1}",
    "        versionCode (project.hasProperty('versionCode') ? project.property('versionCode').toInteger() : 1)",
    "        versionName (project.hasProperty('versionName') ? project.property('versionName') : \"1.0\")",
  ].join("\n");
}
