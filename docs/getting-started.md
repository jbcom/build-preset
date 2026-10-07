---
title: Getting started
description: Install build-preset and wire up Vite, Vitest, TypeScript and Biome.
---

## Install

```sh
pnpm add -D build-preset vite vitest @vitest/browser-playwright playwright
```

Use Node.js 24 or newer. `vite`, `vitest`, `@vitest/browser-playwright` and `playwright` are peer
dependencies, so the project controls their versions. Install `tsup` too only if you use the
library build. The package ships native ESM and CommonJS entry points with format-correct
TypeScript declarations.

## Vite

```ts
// vite.config.ts
import { defineGamePreset } from "build-preset/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineGamePreset({
  appName: "my-game",
  plugins: [react()],
  srcDir: path.resolve(import.meta.dirname, "src"),
  heavyDeps: { three: true },
});
```

## Unit tests

```ts
// vitest.config.ts
import { defineUnitTest } from "build-preset/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { ...defineUnitTest({ environment: "node" }) } });
```

## Browser tests

```ts
// vitest.browser.config.ts
import { defineBrowserTest } from "build-preset/vitest";
import { defineConfig } from "vitest/config";

const browserTest = defineBrowserTest({ includeThree: false });

export default defineConfig({
  optimizeDeps: browserTest.optimizeDeps,
  test: {
    include: browserTest.include,
    fileParallelism: browserTest.fileParallelism,
    browser: browserTest.browser,
  },
});
```

Install Chromium once with `pnpm exec playwright install --with-deps --no-shell chromium`. On a
Linux CI runner without a display, run the tests under `xvfb-run -a`, because the browser is headed.

## TypeScript and Biome

```jsonc
// tsconfig.json
{ "extends": "build-preset/tsconfig.base.json", "include": ["src", "tests"] }
```

```jsonc
// biome.json
{ "extends": ["build-preset/biome.base.json"] }
```

`tsconfig.base.json` is strict, bundler-resolved and `noEmit`, aimed at an application that Vite
builds. Add `"types"` and `"paths"` in the project.
