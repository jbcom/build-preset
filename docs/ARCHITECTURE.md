# Architecture

build-preset is configuration, not tooling. Each module is a pure function from options to a plain
config object, so it is cheap to test and easy to override.

## Module boundaries

```text
vite ───────────> vite (mergeConfig, normalizePath)
vitest ─────────> @vitest/browser-playwright
capacitor ──────> (leaf: no imports)
tsup ───────────> tsup (types only)
cli ────────────> capacitor
index ──────────> re-exports capacitor, vite and vitest (never tsup)
```

Nothing imports a framework plugin. `tsup` is imported for types only, so its absence costs a
consumer nothing at runtime, and the barrel leaves it out so that a project that never builds a
library never needs its types either.

## Contracts

1. **Overrides merge last.** Every factory takes an `overrides` option applied after all derived
   fields, so no project is boxed in by a preset default.
2. **Headed and muted browser tests.** `defineBrowserTest` constructs the Playwright provider itself
   and refuses `headless` in any spelling. The mute flag cannot be separated from the provider
   because there is no standalone argument array to pass around.
3. **Absolute aliases only.** A relative `srcDir` throws, because Vite would resolve it against the
   process working directory rather than the config file.
4. **Rolldown groups, not `manualChunks`.** Vite 8 deprecates `manualChunks`. The factory emits
   `codeSplitting.groups` and reconciles same-named groups after `mergeConfig`, because `mergeConfig`
   concatenates nested arrays and would otherwise keep both definitions.
5. **Capacitor merges are explicit.** Replacing a whole `server` object by accident drops
   `androidScheme`, which breaks the app on Android, so the three platform sections and `plugins`
   merge one level deep and everything else replaces.
6. **Types match the runtime.** The CommonJS build emits its own `.d.cts` declarations; pointing
   `require` at an ESM `.d.ts` makes TypeScript read the types as ESM while Node loads CommonJS.

## Build and packaging

`scripts/build.mjs` runs the installed TypeScript twice, once per `tsconfig.esm.json` and
`tsconfig.cjs.json`, with no bundler. The CommonJS output is renamed to `.cjs` and `.d.cts`, its
specifiers are rewritten, and `dist/cjs` gets a `{ "type": "commonjs" }` manifest. The CLI keeps its
shebang and is marked executable.

The package has no runtime dependencies. `pnpm verify` ends in a packed-consumer smoke that installs
the tarball into an empty project against the public registry only, loads every entry point under
ESM and CommonJS, type-checks a consumer file, builds a Vite app, and optionally launches headed
Chromium. CI runs that smoke against both supported Vitest majors.

## Intentional limits

- No framework plugins, no Tailwind, no React setup.
- No release workflow YAML for Capacitor: signing and release policy belong to the application.
- No `headless` mode in the browser fragment.
