# Agent notes

This file is for an autonomous coding agent working in this repository. It covers what isn't obvious
from reading the code alone.

## Toolchain

- Package manager: pnpm, pinned in `package.json#packageManager`. Use `mise install` (reads
  `mise.toml`) for the default Node 26 and pnpm 12, or `corepack enable`. Node.js 22, 24 and 26
  are supported; CI verifies each maintained line without requiring an exact patch version.
- This is a pnpm workspace with two members: `.` (the published package) and `docs/` (the private
  Sourcey documentation site). Root scripts operate on the package; `pnpm docs:*` delegate to
  `docs/` via `pnpm --filter build-preset-docs`. Sourcey emits `docs/dist/`, including the site
  `llms.txt`; the root `llms.txt` is separate, concise orientation.
- `pnpm verify` is the single gate CI runs: Biome, markdownlint on the published docs, strict
  TypeScript, the test suite with coverage, the dual-format build, `publint`, Are The Types Wrong,
  and a packed-consumer smoke that installs the tarball from the public registry. A change is not
  done while any part of it is red. CI's `docs` job separately runs `pnpm docs:build`.
- The browser smoke needs Chromium: `pnpm exec playwright install --with-deps --no-shell chromium`,
  then `BUILD_PRESET_RUN_BROWSER=1 pnpm smoke:consumer` (under `xvfb-run -a` on Linux).
  `BUILD_PRESET_CONSUMER_VITEST=4` selects the Vitest 4 line.

## Core invariants: do not violate these when editing `src/`

1. `defineBrowserTest` is headed-only and always carries `--mute-audio`. Never add a `headless`
   option, and never accept a hidden `--headless` argument.
2. Every factory takes `overrides` and applies it last.
3. A relative `srcDir` throws; never resolve it silently.
4. Heavy-vendor chunking uses Rolldown `codeSplitting.groups`, never `manualChunks`.
5. The package has no runtime dependencies. `vite`, `vitest`, `@vitest/browser-playwright` and
   `playwright` are peers; `tsup` is an optional peer used for types only.
6. `src/tsup.ts` stays out of the `src/index.ts` barrel.
7. The peer ranges are the compatibility promise: keep Vite, Vitest (4 and 5) and Playwright floors
   honest, and keep the packed-consumer smoke exercising both Vitest majors.

## Keeping docs and tests in sync

A change to the public surface needs matching updates in all of:

- `tests/*.test.ts`
- `docs/API.md`, and `docs/ARCHITECTURE.md` when a contract or module boundary changes. Do not
  create a second documentation renderer or a duplicate page tree.
- `README.md`, if the quick start or the API overview table changes.

Examples and fixtures use neutral names (`example-game`, `com.example.game`). Never put another
project's names, characters or storage keys in docs, comments, tests or scripts.

## Commits and releases

- Conventional Commits only. A required CI check enforces conventional PR titles and Release Please
  parses the preserved merge-commit history to drive `CHANGELOG.md` and the next version. Never
  hand-edit the changelog or bump a version yourself.
- `pre-commit`, `simple-git-hooks`, `lint-staged` and `commitlint` run locally after `pnpm install`.
  Don't bypass them with `--no-verify`; fix the input instead.
- Publishing is by npm trusted publishing (OIDC) from the `publish` job in
  `.github/workflows/cd.yml`, after Release Please creates a release from a green `main` commit.

## Files most likely to surprise you

- `pnpm-workspace.yaml`'s `allowBuilds` map controls which packages' install scripts run. A new
  dependency needing a native build step will silently no-op until it is added there.
- Sourcey paths in `docs/sourcey.config.ts` resolve relative to `docs/`, and every navbar and footer
  link needs a `type`.
- `biome.base.json` and `tsconfig.base.json` are shipped to consumers; changing them is a public API
  change. The repository's own `biome.json` extends the shipped base.
