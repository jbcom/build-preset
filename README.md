# build-preset

[![npm](https://img.shields.io/npm/v/build-preset)](https://www.npmjs.com/package/build-preset)
[![CI](https://github.com/jbcom/build-preset/actions/workflows/ci.yml/badge.svg)](https://github.com/jbcom/build-preset/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/build-preset)](LICENSE)

Shared build conventions for browser games. One dependency gives a project its Vite 8 config,
its Vitest unit and real-browser test fragments, a Capacitor config, a tsup library build, and the
TypeScript and Biome base configs, so a dozen game repositories stop drifting apart.

- **Vite 8** game config with env-switched `base`, Rolldown code-splitting groups for
  heavy vendors (three.js, Rapier, Phaser), HMR watch-ignore, and an optional `@` alias.
- **Vitest 4 or 5** fragments: a jsdom or Node unit config and a **headed, muted** real-Chromium
  browser config that builds the Playwright provider itself.
- **Capacitor** config with a documented merge, so overriding `server.hostname` keeps
  `server.androidScheme`.
- **tsup** library build whose banner is derived from the package name.
- **`tsconfig.base.json`** and **`biome.base.json`** to extend.
- No runtime dependencies. Every entry point ships ESM and CommonJS with matching types.

## Install

```sh
pnpm add -D build-preset vite vitest @vitest/browser-playwright playwright
```

`tsup` is an optional peer: install it only if you use `build-preset/tsup`.

## Quick start

```ts
// vite.config.ts
import { defineGamePreset } from "build-preset/vite";
import path from "node:path";

export default defineGamePreset({
  appName: "my-game",
  srcDir: path.resolve(import.meta.dirname, "src"),
  heavyDeps: { three: true, rapier: true },
});
```

```ts
// vitest.browser.config.ts
import { defineBrowserTest } from "build-preset/vitest";
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

```jsonc
// tsconfig.json
{ "extends": "build-preset/tsconfig.base.json" }
```

```jsonc
// biome.json
{ "extends": ["build-preset/biome.base.json"] }
```

## API overview

| Import | Exports |
| --- | --- |
| `build-preset` | Everything below except `/tsup` (a thin barrel; prefer the subpaths) |
| `build-preset/vite` | `defineGamePreset`, `HeavyDepsOptions` |
| `build-preset/vitest` | `defineUnitTest`, `defineBrowserTest`, `defaultBrowserLaunchArgs` |
| `build-preset/capacitor` | `defineCapacitorPreset`, `mergeCapacitorConfig`, `androidVersionGradleSnippet` |
| `build-preset/tsup` | `libraryBuild` |
| `build-preset/tsconfig.base.json`, `build-preset/biome.base.json` | Shared configuration to `extends` |

The `build-preset init-android` command prints the CI-parameterized `versionName` and
`versionCode` block to paste into `android/app/build.gradle`.

See the [API reference](docs/API.md) for every option and the [architecture notes](docs/ARCHITECTURE.md)
for why the presets behave as they do.

## The browser test contract

`defineBrowserTest` is headed-only. It constructs the Vitest Playwright provider itself and puts
`--mute-audio` in `provider.options.launchOptions.args`, so a silent run does not depend on a
consumer remembering to copy a launch-argument array. It throws on a `headless` option and on any
hidden `--headless` Chromium argument. Muting the audio does not change a player's saved audio
preference: the consumer still asserts a non-persistent runtime mute route in its own tests.

## Compatibility

| | Supported |
| --- | --- |
| Node.js | 24 and newer (CI verifies 24 and 26; Windows on 26) |
| Vite | `^8.2.1` |
| Vitest | `^4.1.10` or `^5.0.0` |
| `@vitest/browser-playwright` | `^4.1.10` or `^5.0.0`, matching Vitest |
| Playwright | `>=1.62.1 <2` |
| tsup (optional) | `^8.5.0` |

The Vitest 4 and Vitest 5 lines are both exercised by the packed-consumer smoke in CI.

## Development

```sh
mise install            # Node 26 and pnpm 12, or `corepack enable`
pnpm install
pnpm verify             # Biome, markdownlint, tsc, tests with coverage, build, publint, attw, packed-consumer smoke
pnpm docs:build         # the Sourcey documentation site
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases are automated by Release Please and published to
npm with provenance from GitHub Actions.

## Links

- Documentation: <https://jonbogaty.com/build-preset/>
- npm: <https://www.npmjs.com/package/build-preset>
- Changelog: [CHANGELOG.md](CHANGELOG.md)
- Decisions: [docs/decisions.md](docs/decisions.md)
- Security policy: [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
