---
title: build-preset
description: Shared Vite, Vitest, Capacitor, tsup, TypeScript and Biome configuration for browser games.
---

build-preset is the build configuration a family of browser-game repositories used to copy from
each other, extracted into one package. It gives a project a Vite 8 config, Vitest unit and
real-browser test fragments, a Capacitor config, a tsup library build, and shared TypeScript and
Biome base configs.

It is deliberately **configuration only**. It has no runtime dependencies and takes no framework
opinion: React, Tailwind and other plugins stay the project's own. Every factory returns a plain
config object and accepts an `overrides` escape hatch that merges last.

## Why use it?

| Problem | build-preset convention |
| --- | --- |
| Heavy vendors (three.js, Rapier, Phaser) split into racing chunks | Rolldown `codeSplitting.groups` and `optimizeDeps` per `heavyDeps` toggle |
| A browser test run is loud, or runs headless and hides GPU bugs | Headed-only Chromium with `--mute-audio` built into the provider |
| A mid-run dependency re-bundle produces a second React instance | The dep-optimizer pre-bundle list is part of the browser fragment |
| Overriding one Capacitor key discards the preset's sibling keys | `server`, `android`, `ios` and `plugins` merge one level deep |
| A library ships another package's banner or bundles its peers | `libraryBuild` derives the banner from the name and takes explicit externals |
| Every repo has a slightly different tsconfig and Biome setup | `tsconfig.base.json` and `biome.base.json` to extend |

## Where to go next

- [Getting started](getting-started/) installs the package and wires a first config.
- [Vite](vite/), [Browser testing](browser-testing/), [Capacitor](capacitor/) and
  [Library builds](library-builds/) are one guide per entry point.
- [API](API/) lists every export and option; [Architecture](ARCHITECTURE/) explains the contracts.
