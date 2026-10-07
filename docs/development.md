---
title: Development
description: Set up build-preset, validate a change, and contribute through the protected workflow.
---

## Local workflow

```sh
mise install
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps --no-shell chromium
pnpm verify
pnpm docs:build
```

`pnpm verify` is the library gate: Biome, Markdown linting, strict TypeScript, tests with coverage,
the dual-format build, `publint`, Are The Types Wrong, and a packed-consumer smoke against the public
registry. `BUILD_PRESET_RUN_BROWSER=1 pnpm smoke:consumer` adds a real headed Chromium run, and
`BUILD_PRESET_CONSUMER_VITEST=4` runs the consumer on the Vitest 4 line. `pnpm docs:build` validates
and renders the Sourcey site.

Branch from `main`, make a focused Conventional Commit, open an upstream pull request, and keep the
required checks green. Release Please owns versions and the changelog.
