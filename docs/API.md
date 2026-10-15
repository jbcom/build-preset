# API reference

Everything is exported from `build-preset`, except `libraryBuild`, which lives only at
`build-preset/tsup`. The subpaths reduce coupling: prefer them over the barrel.

## `build-preset/vite`

### `staticRouteExport(options?)`

An opt-in Vite plugin that copies the final built `index.html` into declared route directories.
It reads the resolved `root` and `build.outDir`, including caller overrides, in a post-order,
sequential `closeBundle` hook. Use it through the preset's existing `plugins` option:

```ts
import { defineGamePreset, staticRouteExport } from "build-preset/vite";

export default defineGamePreset({
  appName: "example-game",
  plugins: [staticRouteExport({ routes: ["/play", "guide/topic"] })],
});
```

| Option | Type | Meaning |
| --- | --- | --- |
| `routes` | `readonly string[]` | Directory routes; omitted means no exports. Optional leading/trailing slash is accepted; `/` already exists. |
| `enabled` | `boolean` | Defaults to `true`; `false` disables output. |
| `native` | `boolean` | Defaults to `process.env.CAPACITOR === "true"`; native output is skipped. |

Routes use slash-separated ASCII letters, digits, underscores and hyphens. Traversal, empty
segments, URL parameters, encodings, file extensions, Windows device names and case collisions
are rejected. Exact duplicates are deduplicated. Existing route directories must be ordinary
directories, never symbolic links. An existing destination index is retained only if its bytes
equal the current built index; a different document is never overwritten. A repeated normal build
refreshes aliases after Vite empties its output; with `emptyOutDir: false`, remove changed old
aliases before rebuilding.

The plugin runs only for written HTML web builds, skipping serve, native, SSR, library and
`build.write: false` modes. A failed build that never writes its bundle cannot export a stale
retained index. An active export requires the built root index to exist. `base` must
be root-relative (`/` or `/example/`) or an absolute HTTP(S) URL; a relative base such as `./`
would make copied asset URLs resolve beneath each route and is rejected. The built HTML is copied
byte for byte, so custom relative URLs in that document remain the caller's responsibility.

This exports files such as `guide/topic/index.html`; it does not install redirects or server
fallbacks. A server may still return 404 for `/guide/topic` even when that file exists. Verify
the deployed clean URL, its trailing-slash form, its explicit `index.html`, and referenced assets
on the actual host; configure directory indexes or rewrites there as needed. File-export tests
do not establish a particular server's routing behavior.

### `defineGamePreset(options)`

```ts
function defineGamePreset(options: DefineGamePresetOptions): UserConfig;
```

| Option | Type | Meaning |
| --- | --- | --- |
| `appName` | `string` (required) | Drives the default GitHub Pages base `/<appName>/` |
| `base` | `string` | Explicit base. Otherwise `VITE_BASE`, then `CAPACITOR=true` (`/`), then `GITHUB_PAGES=true`, then `/` |
| `plugins` | `PluginOption[]` | Framework plugins the caller supplies |
| `heavyDeps` | `HeavyDepsOptions` | `{ three?, rapier?, phaser?, tone? }`, see below |
| `chunks` | `VendorChunks` | `Record<chunkName, (string \| RegExp)[]>`: vendor chunks by when they load, see below |
| `watchIgnore` | `string[]` | Appended to the preset's dev-server watch-ignore globs |
| `dedupe` | `string[]` | Extra ids to dedupe beyond `react` and `react-dom` |
| `srcDir` | `string` | Absolute path for the optional `@` alias. A relative path throws `TypeError` |
| `overrides` | `UserConfig` | Merged last with Vite's `mergeConfig`; a same-named code-splitting group replaces the preset's |

`heavyDeps.three` adds `optimizeDeps.include: ["three"]` and a `three-vendor` group.
`heavyDeps.rapier` excludes `@dimforge/rapier3d-compat` from optimization and co-chunks it with
three. `heavyDeps.phaser` adds a `phaser-vendor` group and `heavyDeps.tone` a `tone-vendor` group.
Groups use Rolldown `build.rolldownOptions.output.codeSplitting.groups`.

`chunks` emits one group per key, ahead of the `heavyDeps` groups. A string is an npm package name
(it claims `node_modules/<name>/` and nothing else); a `RegExp` is tested against the module id and
must not carry the `g` or `y` flag. A module several chunks match goes to the first one declared. A
`heavyDeps` group named like a chunk is dropped; a package named in two chunks, an empty chunk and
a purely numeric chunk name throw `TypeError`. `chunks` never changes `optimizeDeps`. The types
`VendorChunks` and `ChunkPattern` are exported. The full precedence rules, with a load-time
split as the example, are in [Vite](vite.md#vendor-chunks-by-when-they-load).

## `build-preset/vitest`

### `defineUnitTest(options?)`

```ts
function defineUnitTest(options?: DefineUnitTestOptions): UnitTestFragment;
```

`DefineUnitTestOptions` has `include`, `exclude` and `environment` (`"jsdom"`, the default, or
`"node"`). The fragment is `{ include, exclude, environment, environmentOptions? }`. Under `jsdom`,
`environmentOptions.jsdom.url` is `http://localhost:3000` so `localStorage` exists. Spread it into
`test`.

### `defineBrowserTest(options?)`

**Deprecated:** use game-harness's `defineBrowserTestConfig` (`game-harness/vitest`). Removed in the
next major.

```ts
function defineBrowserTest(options?: DefineBrowserTestOptions): {
  include: string[];
  optimizeDeps: { include: string[] };
  fileParallelism: boolean;
  browser: BrowserTestFragment;
};
```

| Option | Default | Meaning |
| --- | --- | --- |
| `include` | `["tests/browser/**/*.{test,spec}.{ts,tsx}"]` | Test globs |
| `includeThree` | `true` | Pre-bundle `three` in `optimizeDeps.include` |
| `optimizeDepsInclude` | `[]` | Extra ids to pre-bundle |
| `fileParallelism` | `false` | Top-level `test.fileParallelism` |
| `extraLaunchArgs` | `[]` | Appended after the default Chromium arguments |

`browser` is `{ enabled: true, instances: [{ browser: "chromium" }], headless: false,
screenshotFailures: true, provider }`. The provider is `playwright({ launchOptions: { args } })`
from `@vitest/browser-playwright`. Passing a `headless` option, or a `--headless` entry in
`extraLaunchArgs`, throws `TypeError`.

### `defaultBrowserLaunchArgs(extra?)`

**Deprecated:** use game-harness's `createChromiumLaunchProfile` (`game-harness/chromium`), or its
`gpuMode` and `gpuArgs` options on `defineBrowserTestConfig` (`game-harness/vitest`). Removed in the
next major.

```ts
function defaultBrowserLaunchArgs(extra?: string[]): string[];
```

Returns `--mute-audio`, `--enable-gpu`, `--ignore-gpu-blocklist`, `--use-gl=angle`,
`--use-angle=swiftshader-webgl`, then `extra`. Throws on a `--headless` entry.

## `build-preset/capacitor`

### `defineCapacitorPreset(options)`

```ts
function defineCapacitorPreset(options: DefineCapacitorPresetOptions): Record<string, unknown>;
```

Options: `appId`, `appName` (required), `debugEnvVar` (default `CAP_DEBUG`), `backgroundColor`,
`webDir` (default `dist`), `androidPath` (default `android`), `overrides`.

### `mergeCapacitorConfig(base, overrides)`

```ts
function mergeCapacitorConfig(
  preset: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown>;
```

`server`, `android` and `ios` merge one level deep; `plugins` merges per plugin; every other key is
replaced. An explicit `undefined` inside a merged object unsets that key. Inputs are not mutated.

### `androidVersionGradleSnippet()`

Returns the `versionCode` and `versionName` block for `android/app/build.gradle`.

## `build-preset/tsup`

### `libraryBuild(options)`

```ts
function libraryBuild(options: LibraryBuildOptions): Options; // tsup's Options
```

Options: `name` (required), `entry` (default `["src/index.ts"]`), `external` (default `[]`), `jsx`
(`"transform"`, `"preserve"` or `"automatic"`, routed through `esbuildOptions`), `overrides`.
Requires the optional `tsup` peer.

## Shared configuration files

`build-preset/tsconfig.base.json` and `build-preset/biome.base.json` resolve through the package
`exports` map, so TypeScript's and Biome's `extends` find them.

## CLI

`build-preset init-android` prints the Android version scaffold. Any other command prints usage to
stderr and exits 1.
