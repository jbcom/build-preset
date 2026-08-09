# @arcade-cabinet/build-preset

Shared build configuration for the Arcade Cabinet fleet. Version 0.2.0 requires
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

Browser-test fragments are headed-only and construct the Vitest 4 Playwright
provider themselves, with the process-level `--mute-audio` backstop wired into
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
    browser: browserTest.browser,
  },
});
```

The factory rejects both the removed `headless` option and hidden `--headless`
Chromium arguments. Consumers must still activate and assert a non-persistent
runtime mute route—normally through
`@arcade-cabinet/test-harness/silent-qa`—without changing saved player audio
preferences.

The Capacitor subpath intentionally exports configuration and the
`androidVersionGradleSnippet()` scaffold only. Release workflow YAML is not a
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
support, typechecks the root barrel, exercises the CLI, and builds with Vite 8.2.1.

Set `BUILD_PRESET_CONSUMER_SOURCE` to an exact registry spec and
`BUILD_PRESET_RUN_BROWSER=1` to rerun the same clean-consumer contract against a
published package. That route launches real headed Chromium, requires
`--mute-audio`, rejects `--headless`, and proves the browser test does not mutate a
seeded player audio preference.
