import path from "node:path";
import { mergeConfig, type PluginOption, type UserConfig } from "vite";

/**
 * One pattern that claims modules for a vendor chunk.
 *
 * - A `string` is an npm package name (`"three"`, `"@react-three/fiber"`). It claims every module
 *   under that package's `node_modules/<name>/` directory, on POSIX and Windows paths alike. It
 *   never claims a different package whose name merely contains it: `"postprocessing"` does not
 *   claim `@react-three/postprocessing`.
 * - A `RegExp` is tested against the whole module id as Rolldown reports it. Prefer `[\\/]` over
 *   `/` for path separators so the pattern also works on Windows. The `g` and `y` flags are
 *   rejected: they make `RegExp#test` stateful, so the same module id could match differently
 *   from one call to the next.
 */
export type ChunkPattern = string | RegExp;

/**
 * Vendor chunks by name. Each key is the emitted chunk's name and each value lists the patterns
 * that claim modules for it.
 *
 * Order is precedence. The first chunk (in declaration order) with a matching pattern takes the
 * module; later chunks never see it. Declare the most specific chunk first.
 */
export type VendorChunks = Readonly<Record<string, readonly ChunkPattern[]>>;

/**
 * Known-gotcha heavy dependencies that need co-chunking / optimizeDeps care.
 * Toggling one of these on wires in the fix that browser games otherwise
 * rediscover one repository at a time (the three.js and Rapier chunking
 * boundary, and the mid-run dependency re-bundle).
 */
export interface HeavyDepsOptions {
  /** three.js: dedupe + its own Rolldown code-splitting group + optimizeDeps.include. */
  three?: boolean;
  /**
   * Rapier (WASM physics): optimizeDeps.exclude (async WASM init can't be
   * pre-bundled) + co-chunked with three so both land in the same async
   * boundary instead of racing two separate dynamic imports.
   */
  rapier?: boolean;
  /** Phaser: its own Rolldown code-splitting group (it's large and rarely changes). */
  phaser?: boolean;
  /** Tone.js (audio): its own `tone-vendor` Rolldown code-splitting group. */
  tone?: boolean;
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
   * Vendor chunks split by when they load, for games whose split `heavyDeps` cannot express.
   * Each key is an emitted chunk's name; each value lists package names and/or RegExps that
   * claim modules for it (see {@link ChunkPattern}).
   *
   * Precedence, in full:
   *
   * 1. Chunks are matched in declaration order and the first chunk with a matching pattern takes
   *    the module. Declare the most specific chunk first.
   * 2. `chunks` outrank `heavyDeps`: a module a chunk claims never reaches a `heavyDeps` group.
   *    A `heavyDeps` group whose name equals a chunk's name (`three-vendor`, `phaser-vendor`,
   *    `tone-vendor`) is dropped in favour of the chunk.
   * 3. Groups from `overrides` come last (see `overrides`).
   *
   * A package named in two chunks, a chunk with no patterns, and a RegExp with the `g` or `y`
   * flag throw a `TypeError`. `chunks` never touches `optimizeDeps`; `heavyDeps` still owns that.
   */
  chunks?: VendorChunks;
  /**
   * Extra HMR-storm avoidance globs, merged with the preset's own default
   * ignore list (dist, android, ios, test-results).
   */
  watchIgnore?: string[];
  /** Extra module ids to dedupe beyond the preset's own react/react-dom set. */
  dedupe?: string[];
  /**
   * Absolute filesystem target for the optional "@/*" alias. When omitted,
   * the preset creates no alias. Relative replacements are rejected because
   * Vite resolves them from its process context rather than the consumer's
   * config file. POSIX and Windows absolute paths are accepted and normalized
   * to Vite's forward-slash convention.
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

interface CodeSplittingGroup {
  name: string;
  test: RegExp;
}

/** A Rolldown `codeSplitting.groups` entry whose `test` is a function. */
interface ChunkGroup {
  name: string;
  test: (id: string) => boolean;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function packagePattern(packageName: string): RegExp {
  const body = packageName.replace(REGEXP_SPECIALS, "\\$&").replaceAll("/", "[\\\\/]");
  return new RegExp(`[\\\\/]node_modules[\\\\/]${body}(?:[\\\\/]|$)`);
}

function chunkPatternToRegExp(
  chunkName: string,
  pattern: ChunkPattern,
  claimedBy: Map<string, string>,
): RegExp {
  if (typeof pattern !== "string") {
    if (pattern.global || pattern.sticky) {
      throw new TypeError(
        `defineGamePreset chunks.${chunkName} has a RegExp with the g or y flag (${pattern}); remove it, those flags make RegExp#test stateful`,
      );
    }
    return pattern;
  }
  if (pattern.trim() === "") {
    throw new TypeError(
      `defineGamePreset chunks.${chunkName} has an empty package name; a string pattern is an npm package name`,
    );
  }
  const owner = claimedBy.get(pattern);
  if (owner !== undefined) {
    throw new TypeError(
      owner === chunkName
        ? `defineGamePreset chunks.${chunkName} lists package ${JSON.stringify(pattern)} twice`
        : `defineGamePreset package ${JSON.stringify(pattern)} is claimed by both chunks.${owner} and chunks.${chunkName}; a package belongs to one chunk`,
    );
  }
  claimedBy.set(pattern, chunkName);
  return packagePattern(pattern);
}

/**
 * Turns `chunks` into Rolldown groups, one per chunk, in declaration order. Rolldown resolves a
 * module that several groups match in favour of the group with the smaller index (all groups
 * share the default priority), so declaration order is precedence.
 */
function buildChunkGroups(chunks: VendorChunks): ChunkGroup[] {
  const claimedBy = new Map<string, string>();
  return Object.entries(chunks).map(([name, patterns]) => {
    // JavaScript visits integer-like keys first, ahead of declaration order, which would
    // silently reorder the precedence.
    if (name.trim() === "" || /^\d+$/.test(name)) {
      throw new TypeError(
        `defineGamePreset chunks has the invalid chunk name ${JSON.stringify(name)}; a name must be non-empty and not purely numeric`,
      );
    }
    if (patterns.length === 0) {
      throw new TypeError(`defineGamePreset chunks.${name} lists no patterns`);
    }
    const tests = patterns.map((pattern) => chunkPatternToRegExp(name, pattern, claimedBy));
    return { name, test: (id: string) => tests.some((test) => test.test(id)) };
  });
}

function buildCodeSplittingGroups(heavyDeps: HeavyDepsOptions): CodeSplittingGroup[] {
  const { three, rapier, phaser, tone } = heavyDeps;
  const groups: CodeSplittingGroup[] = [];

  if (three || rapier) {
    const packages = [three ? "three" : undefined, rapier ? "@dimforge/rapier3d-compat" : undefined]
      .filter((name): name is string => name !== undefined)
      .map((name) => name.replace("/", "[\\\\/]"));
    groups.push({
      name: "three-vendor",
      test: new RegExp(`[\\\\/]node_modules[\\\\/](?:${packages.join("|")})(?:[\\\\/]|$)`),
    });
  }

  if (phaser) {
    groups.push({
      name: "phaser-vendor",
      test: /[\\/]node_modules[\\/]phaser(?:[\\/]|$)/,
    });
  }

  if (tone) {
    groups.push({
      name: "tone-vendor",
      test: /[\\/]node_modules[\\/]tone(?:[\\/]|$)/,
    });
  }

  return groups;
}

/**
 * Explicit `chunks` first, in declaration order, then the `heavyDeps` groups. Rolldown gives a
 * module to the matching group with the smaller index, so this order is the precedence. A
 * `heavyDeps` group the caller redefines under the same name is dropped, not duplicated.
 */
function composeCodeSplittingGroups(
  chunks: VendorChunks,
  heavyDeps: HeavyDepsOptions,
): Array<CodeSplittingGroup | ChunkGroup> {
  const explicit = buildChunkGroups(chunks);
  const redefined = new Set(explicit.map(({ name }) => name));
  return [
    ...explicit,
    ...buildCodeSplittingGroups(heavyDeps).filter(({ name }) => !redefined.has(name)),
  ];
}

function sourceAlias(srcDir: string | undefined): Record<string, string> | undefined {
  if (srcDir === undefined) return undefined;
  // win32 absolute-ness is a superset of POSIX absolute-ness ("/x" is absolute in both), so one
  // check accepts a POSIX or a Windows path whichever platform evaluates the config.
  if (!path.win32.isAbsolute(srcDir)) {
    throw new TypeError(
      `defineGamePreset srcDir must be an absolute filesystem path; received ${JSON.stringify(srcDir)}`,
    );
  }
  return { "@": srcDir.replaceAll("\\", "/") };
}

interface CodeSplittingShape {
  groups?: unknown;
}

interface OutputShape {
  codeSplitting?: CodeSplittingShape;
}

/**
 * Vite's mergeConfig concatenates nested arrays. That is useful for plugins,
 * but duplicate named Rolldown groups are ambiguous. Preserve first-seen
 * ordering while making the caller's later group with the same name replace
 * the preset definition, matching the documented "overrides win" contract.
 */
function reconcileNamedCodeSplittingGroups(config: UserConfig): UserConfig {
  const output = config.build?.rolldownOptions?.output;
  if (!output || Array.isArray(output) || typeof output !== "object") return config;

  const codeSplitting = (output as OutputShape).codeSplitting;
  if (!codeSplitting || !Array.isArray(codeSplitting.groups)) return config;

  const groups: unknown[] = [];
  const namedPositions = new Map<string, number>();
  for (const group of codeSplitting.groups) {
    const name =
      typeof group === "object" && group !== null && "name" in group
        ? (group as { name?: unknown }).name
        : undefined;
    if (typeof name !== "string") {
      groups.push(group);
      continue;
    }

    const previous = namedPositions.get(name);
    if (previous === undefined) {
      namedPositions.set(name, groups.length);
      groups.push(group);
    } else {
      groups[previous] = group;
    }
  }
  codeSplitting.groups = groups;
  return config;
}

/**
 * Base Vite config factory encoding shared browser-game build conventions:
 * env-switched `base`, heavy-dep co-chunking fixes, and HMR watch-ignore
 * globs, merging caller overrides last so any project can fully escape-hatch.
 */
export function defineGamePreset(options: DefineGamePresetOptions): UserConfig {
  const {
    appName,
    base,
    plugins = [],
    heavyDeps = {},
    chunks = {},
    watchIgnore = [],
    dedupe = [],
    srcDir,
    overrides = {},
  } = options;

  const codeSplittingGroups = composeCodeSplittingGroups(chunks, heavyDeps);
  const optimizeDepsInclude: string[] = [];
  const optimizeDepsExclude: string[] = [];

  if (heavyDeps.three) optimizeDepsInclude.push("three");
  if (heavyDeps.rapier) optimizeDepsExclude.push("@dimforge/rapier3d-compat");
  const alias = sourceAlias(srcDir);

  const preset: UserConfig = {
    base: deriveBase(appName, base),
    plugins,
    resolve: {
      ...(alias ? { alias } : {}),
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
    ...(codeSplittingGroups.length
      ? {
          build: {
            rolldownOptions: {
              output: {
                codeSplitting: {
                  groups: codeSplittingGroups,
                },
              },
            },
          },
        }
      : {}),
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

  return reconcileNamedCodeSplittingGroups(mergeConfig(preset, overrides));
}
