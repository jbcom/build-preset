# @arcade-cabinet/build-preset

Shared build and private-package release governance for the Arcade Cabinet fleet.
Version 0.3.0 requires
Node 24, Vite 8.2 or newer in the Vite 8 line, and Playwright 1.62.1 or newer
in the Playwright 1 line for browser-provider fragments.

```ts
import { defineGamePreset } from "@arcade-cabinet/build-preset/vite";
import path from "node:path";

export default defineGamePreset({
  appName: "my-game",
  srcDir: path.resolve(import.meta.dirname, "src"),
  heavyDeps: { three: true, rapier: true },
});
```

The package root is also a supported ESM/CJS/types barrel when a config needs
more than one factory:

```ts
import { defineBrowserTest, defineGamePreset } from "@arcade-cabinet/build-preset";
```

The Vite factory composes caller overrides with Vite's own `mergeConfig` and
uses Rolldown `codeSplitting.groups` for heavy vendor boundaries. It does not
emit deprecated `manualChunks` configuration. Because Vite concatenates nested
group arrays, the preset reconciles duplicate group names after the merge: a
caller group with the same name replaces the preset definition, while other
groups remain in order.

`srcDir` is optional. Omitting it creates no `@` alias. When supplied, it must
be an absolute POSIX or Windows filesystem path; the preset rejects relative
replacements instead of letting Vite resolve them from an unrelated working
directory.

The package also exports Capacitor and Vitest factories plus shared TypeScript
and Biome base configurations. Framework plugins and game-specific settings
remain consumer-owned.

Browser-test fragments are headed-only and construct the Vitest Playwright
provider themselves (Vitest 4 or 5), with the process-level `--mute-audio` backstop wired into
`provider.options.launchOptions.args`. Use the returned root and test fragments
directly; there is no detached launch-argument array to remember:

```ts
import { defineBrowserTest } from "@arcade-cabinet/build-preset";
import { defineConfig } from "vitest/config";

const browserTest = defineBrowserTest({
  include: ["tests/browser/**/*.browser.test.ts"],
  includeThree: false,
});

export default defineConfig({
  optimizeDeps: browserTest.optimizeDeps,
  test: {
    include: browserTest.include,
    fileParallelism: browserTest.fileParallelism,
    browser: browserTest.browser,
  },
});
```

The factory rejects both the removed `headless` option and hidden `--headless`
Chromium arguments. Consumers must still activate and assert a non-persistent
runtime mute route—normally through
`@arcade-cabinet/test-harness/silent-qa`—without changing saved player audio
preferences.

## Private package release verifier

The ESM-only `@arcade-cabinet/build-preset/private-package-release` export owns
the reusable release state machine, exact-source fingerprints, reproducible
scriptless tarball packing, three-run native pnpm CycloneDX normalization, and
idempotent Gitea/npm retry checks. A repository supplies strict declarative JSON;
it does not supply executable commands. Each package entry names explicit,
non-overlapping `sourcePaths`, mandatory package-contained `generatedPaths`, a
literal tag prefix, and a committed SBOM admission profile. Before each of the
two independent packs, every generated path is proven ignored and free of
tracked files, removed, then recreated by the build without symlinks. The build
must leave Git source unchanged, and npm's JSON pack manifest may contain only
Git-tracked package files or files under those exact generated roots. The root
`LICENSE` and every other common release input are separately bound as regular
Git blobs. Root packages must still list their real source paths—the whole
repository is never an implicit package source.

```sh
# Read-only: print a candidate admission. The selected package must have
# admission:null, the exact source must be clean HEAD, and the environment must
# contain no credential- or runner-bearing values.
build-preset package-release profile-sbom \
  --config packages/build-preset/private-package-release.json \
  --package build-preset \
  --source "$SOURCE_SHA"

# CI preflight, then the separately revalidated mutation phase.
build-preset package-release prepare \
  --config packages/build-preset/private-package-release.json \
  --source "$SOURCE_SHA" \
  --release-root "$RUNNER_TEMP/private-package-release" \
  --verification-root "$RUNNER_TEMP/private-package-verification" \
  --receipt "$RUNNER_TEMP/private-package-release-receipt.json"
build-preset package-release publish \
  --config packages/build-preset/private-package-release.json \
  --release-root "$RUNNER_TEMP/private-package-release" \
  --receipt "$RUNNER_TEMP/private-package-release-receipt.json"
```

Preparation and publication require exact Node 24.19.0, npm 11.17.0, and pnpm
11.21.0. `REGISTRY_URL`, `GITEA_SERVER_URL`, and `GITEA_REPOSITORY` must exactly
match the committed config; Gitea reads use `GITEA_TOKEN`, while the single npm
mutation uses `NPM_TOKEN`. Receipt, release directories, and all
assets are canonical real paths below `RUNNER_TEMP`; symlink, CR/LF, redirect,
tag-prefix, tag-object, registry-state, and asset-byte drift fail before mutation.
Release creation also validates Gitea's returned identity, metadata, and exact
source target before the first asset upload.

The invoking toolchain must have pnpm 11.21.0 prepared in its Corepack cache (the
repository workflows do this before install). For each release run, the verifier
exports that exact cached package manager with Corepack networking disabled, imports
and activates it in a fresh cache beneath the anonymous scratch home, and keeps
networking disabled for every build and SBOM subprocess. It never forwards the
caller's `HOME`, XDG cache paths, Corepack overrides, npm configuration, or package
tokens. A missing prepared pnpm fails before package code runs; prepare the exact
version once with `corepack install --global pnpm@11.21.0` and retry.

## Dependency currency

The ESM-only `@arcade-cabinet/build-preset/dependency-current` export and CLI
implement two strict declarative policies:

- `public-runtime-closure` requires every producer-owned runtime dependency and
  required peer to select public npm's global `latest`. Upstream-owned transitive
  ranges select their maximum compatible version, and every logical owner path
  must resolve that exact version in the frozen pnpm installation. Uninstalled
  optional peers are recorded as explicit skips.
- `private-scopes-and-roots` requires exact current versions across configured
  private scopes, framework roots, baselines, their private recursion, and public
  boundary leaves. `@arcade-cabinet` is anonymous; `@jbcom` alone may use
  `PRIVATE_NPM_TOKEN`, only on its exact committed registry route.

```sh
build-preset dependency-current --config dependency-current.json
build-preset dependency-current --config dependency-current.json --json
```

The JSON form is canonical and deterministic. Exit 2 denotes configuration or
currency policy failure; exit 3 denotes registry/network infrastructure failure.
Registry reads are bounded streaming GETs with an abort timeout, JSON media-type
validation, no redirects, graph caps, and no ambient npm configuration.

### Capacitor config and `overrides`

`defineCapacitorPreset({ appId, appName, ... })` returns a plain
`CapacitorConfig`-shaped object. Its `overrides` option is merged over the
preset's defaults (`server.androidScheme: "https"`, `android.allowMixedContent:
false`, and `android.webContentsDebuggingEnabled` derived from `CAP_DEBUG`):

- `server`, `android` and `ios` merge one level deep, so
  `overrides: { server: { hostname: "game.local" } }` keeps
  `server.androidScheme`, and `overrides: { android: { buildOptions: {...} } }`
  keeps `allowMixedContent` and `webContentsDebuggingEnabled`.
- `plugins` merges per plugin: each plugin's options object merges one level
  deep, and plugins named on only one side pass through.
- Inside a merged object the override wins per key. To unset a preset key,
  pass it explicitly as `undefined`.
- Every other key (`appId`, `webDir`, `backgroundColor`, ...) is replaced
  wholesale, as are arrays and nested values below the merged level.

```ts
import { defineCapacitorPreset } from "@arcade-cabinet/build-preset/capacitor";

export default defineCapacitorPreset({
  appId: "com.example.game",
  appName: "Game",
  overrides: {
    server: { hostname: "game.local" }, // androidScheme: "https" is kept
    android: { allowMixedContent: true }, // wins over the preset's false
  },
});
```

`mergeCapacitorConfig(base, overrides)` applies the same rules to any two config
objects, for consumers that layer further environment-specific config on top.

The Capacitor subpath intentionally exports configuration, `mergeCapacitorConfig()`
and the `androidVersionGradleSnippet()` scaffold only. Release workflow YAML is not a
package API: signing identity, application metadata, ABI policy, and release
verification are game-specific, and must fail closed. In particular, a release
job must never substitute a debug APK when production signing material is
missing.

## Verification

```sh
pnpm --filter @arcade-cabinet/build-preset verify
```

The gate runs lint, type checking, unit and real Vite 8.2 build regressions,
builds both ESM and CJS output, inspects the pack list, then installs the built
tarball into an isolated clean consumer using a cache-preferring install that
still fetches any peer absent from a fresh runner's store. That publish-shaped
consumer asserts the packed `playwright` peer range (`>=1.62.1 <2`), resolves
Playwright 1.62.1 with Node 24 declarations and disposable-symbol library
support, imports and typechecks both release-governance subpaths, exercises their
CLI dispatch, and builds with Vite 8.2.1.

Set `BUILD_PRESET_CONSUMER_SOURCE` to an exact registry spec and
`BUILD_PRESET_RUN_BROWSER=1` to rerun the same clean-consumer contract against a
published package. That route launches real headed Chromium, requires
`--mute-audio`, rejects `--headless`, and proves the browser test does not mutate a
seeded player audio preference.
