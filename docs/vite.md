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
| `tone` | a `tone-vendor` code-splitting group |

The factory uses Rolldown `codeSplitting.groups`, the Vite 8 mechanism. It never emits the
deprecated `manualChunks`.

## Vendor chunks by when they load

The `heavyDeps` toggles name fixed groups. A game that splits vendor code by **when it loads**, so
the title screen fetches only what it draws and the rest arrives with the first level, names its
own chunks with `chunks`:

```ts
defineGamePreset({
  appName: "example-game",
  chunks: {
    // The title preloads these three...
    three: ["three"],
    r3f: ["@react-three/fiber"],
    drei: ["@react-three/drei"],
    // ...and these load with the first level.
    rapier: ["@react-three/rapier", "@dimforge/rapier3d-compat"],
    post: ["@react-three/postprocessing", "postprocessing", "n8ao"],
    tone: ["tone"],
  },
});
```

Each key is an emitted chunk's name; each value lists what claims modules for it:

- A **string** is an npm package name and claims every module under that package's
  `node_modules/<name>/` directory, on POSIX and Windows paths. It does not claim a different
  package whose name merely contains it: `"postprocessing"` leaves `@react-three/postprocessing`
  alone, so name both.
- A **`RegExp`** is tested against the whole module id. Use `[\\/]` for path separators. The `g`
  and `y` flags throw, because they make `RegExp#test` stateful.

### Precedence

A module that several chunks match goes to exactly one of them, by these rules in order:

1. **Declaration order.** The first chunk with a matching pattern wins, so declare the most
   specific chunk first: `rapier: ["@react-three/rapier"]` above
   `r3f: [/node_modules[\\/]@react-three[\\/]/]` carves Rapier out of the broad pattern, and the
   reverse leaves `rapier` empty (and so not emitted).
2. **`chunks` outrank `heavyDeps`.** A module a chunk claims never reaches a `heavyDeps` group, and
   a `heavyDeps` group whose name equals a chunk's name (`three-vendor`, `phaser-vendor`,
   `tone-vendor`) is dropped in favour of the chunk. `heavyDeps` still owns `optimizeDeps`:
   `heavyDeps: { rapier: true }` keeps excluding `@dimforge/rapier3d-compat` from pre-bundling
   whatever `chunks` says.
3. **`overrides` come last.** A caller group in `overrides` replaces a chunk of the same name in
   place; any other caller group ranks below every preset group.

Order rests on Rolldown choosing the smaller group index when groups share a priority, which the
conformance tests build against the installed Vite to prove. Naming one package in two chunks is
the one overlap that can be seen without running a build, so it throws a `TypeError`, as do a
chunk with no patterns and a purely numeric chunk name (JavaScript would visit it out of
declaration order).

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
