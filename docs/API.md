# API reference

Everything is exported from `build-preset`, except `libraryBuild`, which lives only at
`build-preset/tsup`. The subpaths reduce coupling: prefer them over the barrel.

## `build-preset/vite`

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
`VendorChunks` and `ChunkPattern` are exported. The full precedence rules, with the Will It Blow?
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
