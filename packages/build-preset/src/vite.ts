import type { PluginOption, UserConfig } from "vite";

/**
 * Known-gotcha heavy dependencies that need co-chunking / optimizeDeps care.
 * Toggling one of these on wires in the fix the fleet has already rediscovered
 * per-repo (see blobolines' vite.config.ts for the three.js/Rapier war story
 * and little-legends' vitest.browser.config.ts for the declarative-hex-worlds
 * mid-run re-bundle fix this preset generalizes).
 */
export interface HeavyDepsOptions {
  /** three.js: dedupe + its own manualChunks bucket + optimizeDeps.include. */
  three?: boolean;
  /**
   * Rapier (WASM physics): optimizeDeps.exclude (async WASM init can't be
   * pre-bundled) + co-chunked with three so both land in the same async
   * boundary instead of racing two separate dynamic imports.
   */
  rapier?: boolean;
  /** Phaser: its own manualChunks bucket (it's large and rarely changes). */
  phaser?: boolean;
}

export interface DefineGamePresetOptions {
  /**
   * Drives the default GitHub Pages base ("/<appName>/") and the Capacitor
   * hostname convention. Required — every derived default keys off this.
   */
  appName: string;
  /**
   * Explicit base override. When omitted, derived from env in this order:
   * VITE_BASE env var > CAPACITOR=true (base "/") > GITHUB_PAGES=true
   * (base "/<appName>/") > "/".
   */
  base?: string;
  /** Framework plugins the caller supplies (react(), tailwindcss(), ...). */
  plugins?: PluginOption[];
  /** Known-gotcha heavy deps needing co-chunking / optimizeDeps care. */
  heavyDeps?: HeavyDepsOptions;
  /**
   * Extra HMR-storm avoidance globs, merged with the preset's own default
   * ignore list (dist, android, ios, test-results).
   */
  watchIgnore?: string[];
  /** Extra module ids to dedupe beyond the preset's own react/react-dom set. */
  dedupe?: string[];
  /**
   * Path alias target for "@/*" (defaults to "./src"). Pass an ABSOLUTE path
   * (e.g. `path.resolve(__dirname, "./src")`) — Vite/Rolldown only resolves
   * bare relative alias targets against its own cwd, not the caller's config
   * file location, which silently duplicates modules under different ids.
   */
  srcDir?: string;
  /** Merged last, after every preset-derived field — the escape hatch. */
  overrides?: UserConfig;
}

function deriveBase(appName: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  if (process.env.VITE_BASE) return process.env.VITE_BASE;
  if (process.env.CAPACITOR === "true") return "/";
  if (process.env.GITHUB_PAGES === "true") return `/${appName}/`;
  return "/";
}

function buildManualChunks(
  heavyDeps: HeavyDepsOptions,
): ((id: string) => string | undefined) | undefined {
  const { three, rapier, phaser } = heavyDeps;
  if (!three && !rapier && !phaser) return undefined;

  // vite 8 (rolldown) requires manualChunks to be a function, not a plain
  // object map — a real vite 7->8 migration gotcha (documented in
  // blobolines' vite.config.ts) baked in here so callers never hit it.
  return (id: string) => {
    if ((three || rapier) && id.includes("node_modules")) {
      if (id.includes("node_modules/three") || (rapier && id.includes("rapier"))) {
        return "three-vendor";
      }
    }
    if (phaser && id.includes("node_modules/phaser")) {
      return "phaser-vendor";
    }
    return undefined;
  };
}

/**
 * Base Vite config factory encoding the fleet's shared build conventions:
 * env-switched `base`, heavy-dep co-chunking fixes, and HMR watch-ignore
 * globs — merging caller overrides last so any repo can fully escape-hatch.
 */
export function defineGamePreset(options: DefineGamePresetOptions): UserConfig {
  const {
    appName,
    base,
    plugins = [],
    heavyDeps = {},
    watchIgnore = [],
    dedupe = [],
    srcDir = "./src",
    overrides = {},
  } = options;

  const manualChunks = buildManualChunks(heavyDeps);
  const optimizeDepsInclude: string[] = [];
  const optimizeDepsExclude: string[] = [];

  if (heavyDeps.three) optimizeDepsInclude.push("three");
  if (heavyDeps.rapier) optimizeDepsExclude.push("@dimforge/rapier3d-compat");

  const preset: UserConfig = {
    base: deriveBase(appName, base),
    plugins,
    resolve: {
      dedupe: ["react", "react-dom", ...dedupe],
    },
    ...(optimizeDepsInclude.length || optimizeDepsExclude.length
      ? {
          optimizeDeps: {
            ...(optimizeDepsInclude.length ? { include: optimizeDepsInclude } : {}),
            ...(optimizeDepsExclude.length ? { exclude: optimizeDepsExclude } : {}),
          },
        }
      : {}),
    ...(manualChunks ? { build: { rollupOptions: { output: { manualChunks } } } } : {}),
    server: {
      watch: {
        ignored: [
          "**/diagnostics/**",
          "**/test-results/**",
          "**/dist/**",
          "**/android/**",
          "**/ios/**",
          ...watchIgnore,
        ],
      },
    },
  };

  return mergeConfig(preset, {
    ...overrides,
    resolve: {
      alias: {
        "@": srcDir,
        ...(overrides.resolve as { alias?: Record<string, string> } | undefined)?.alias,
      },
    },
  });
}

/** Shallow-merges two Vite UserConfig objects, one level deep on known keys. */
function mergeConfig(base: UserConfig, overrides: UserConfig): UserConfig {
  return {
    ...base,
    ...overrides,
    plugins: [...(base.plugins ?? []), ...(overrides.plugins ?? [])],
    resolve: {
      ...base.resolve,
      ...overrides.resolve,
      alias: {
        ...(base.resolve as { alias?: Record<string, string> } | undefined)?.alias,
        ...(overrides.resolve as { alias?: Record<string, string> } | undefined)?.alias,
      },
      dedupe: [
        ...((base.resolve as { dedupe?: string[] } | undefined)?.dedupe ?? []),
        ...((overrides.resolve as { dedupe?: string[] } | undefined)?.dedupe ?? []),
      ],
    },
    ...(base.build || overrides.build ? { build: { ...base.build, ...overrides.build } } : {}),
    ...(base.server || overrides.server ? { server: { ...base.server, ...overrides.server } } : {}),
    ...(base.optimizeDeps || overrides.optimizeDeps
      ? { optimizeDeps: { ...base.optimizeDeps, ...overrides.optimizeDeps } }
      : {}),
  };
}
