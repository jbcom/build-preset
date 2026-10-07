---
title: Library builds
description: libraryBuild, a tsup config for publishable libraries whose banner and externals cannot drift.
---

`libraryBuild({ name, ... })` returns a tsup `Options` object. It needs the optional `tsup` peer
(`^8.5.0`).

```ts
// tsup.config.ts
import { libraryBuild } from "build-preset/tsup";

export default libraryBuild({
  name: "@your-scope/renderer",
  external: ["three", "react"],
});
```

The banner is derived from `name`, so it cannot drift from the package it describes. The defaults
are ESM, `es2022`, declarations, sourcemaps, treeshaking and `keepNames` (so consumer stack traces
and `fn.name` checks stay meaningful), with no minification, because applications minify and
libraries should not.

## `external`

`external` is the setting that matters. Anything imported but absent from it gets bundled into
`dist`, which duplicates the dependency and breaks `instanceof` against the host's copy. List your
`peerDependencies`.

## JSX

```ts
libraryBuild({ name: "@your-scope/ui", jsx: "automatic" });
```

The mode is routed through `esbuildOptions`, because tsup's `Options` has no `jsx` field and a
top-level `jsx` in a hand-written config is silently discarded. Use `"preserve"` only when your
entry points also resolve to `.jsx` files; esbuild will not put preserved JSX in a `.js` file.

## Escape hatch

`overrides` merges last and wins:

```ts
libraryBuild({
  name: "@your-scope/mobile",
  overrides: { target: "es2020", splitting: true },
});
```

With `splitting` on, the banner lands in the chunks that carry code rather than in the re-export
shim at `index.js`. The `/tsup` entry point is not part of the package barrel, so projects that do
not build a library never load tsup types.
