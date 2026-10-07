---
title: Vite
description: defineGamePreset, the env-switched base, heavy-dependency chunking and the override rules.
---

`defineGamePreset({ appName, ... })` returns a Vite `UserConfig`. `appName` is required because the
derived defaults key off it.

## The `base`

The base resolves in this order, and an explicit `base` option beats all of it:

1. the `VITE_BASE` environment variable
2. `CAPACITOR=true`, which gives `/`
3. `GITHUB_PAGES=true`, which gives `/<appName>/`
4. `/`

## Heavy dependencies

Each toggle wires in the fix a browser game otherwise rediscovers:

| Toggle | Effect |
| --- | --- |
| `three` | dedupe, `optimizeDeps.include: ["three"]`, and a `three-vendor` code-splitting group |
| `rapier` | `optimizeDeps.exclude` for `@dimforge/rapier3d-compat` (async WASM cannot be pre-bundled) and co-chunking with three |
| `phaser` | a `phaser-vendor` code-splitting group |

The factory uses Rolldown `codeSplitting.groups`, the Vite 8 mechanism. It never emits the
deprecated `manualChunks`.

## The `@` alias

`srcDir` is optional. Omit it and no alias exists. When supplied it must be an absolute POSIX or
Windows path, and the factory throws on a relative one, because Vite would resolve it from an
unrelated working directory. Windows paths are normalized to forward slashes.

## Overrides

`overrides` merges last through Vite's own `mergeConfig`, so plugins and arrays concatenate. Nested
arrays make duplicate named code-splitting groups ambiguous, so after the merge the factory
reconciles them: a caller group with the same `name` replaces the preset's definition and the other
groups keep their order.

The factory also ignores `**/diagnostics/**`, `**/test-results/**`, `**/dist/**`, `**/android/**`
and `**/ios/**` in the dev server's file watcher; `watchIgnore` appends to that list.
