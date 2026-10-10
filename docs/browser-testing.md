---
title: Browser testing
description: The headed, muted real-Chromium Vitest fragment and the unit-test fragment.
---

> **Deprecated.** Browser QA has one owner: use game-harness's `defineBrowserTestConfig`
> (`game-harness/vitest`), which carries the renderer profiles, the mute, multi-instance viewports
> and the browser server's address; in place of `defaultBrowserLaunchArgs`, its
> `createChromiumLaunchProfile` (`game-harness/chromium`). `defineBrowserTest` and
> `defaultBrowserLaunchArgs` stay for existing consumers and are removed in the next major.
> `defineUnitTest` stays here.

## `defineBrowserTest`

Returns `{ include, optimizeDeps, fileParallelism, browser }` to spread into a Vitest config. It
supports Vitest 4 and Vitest 5 and builds the Playwright provider itself.

- **Headed only.** `browser.headless` is `false`. Passing a `headless` option throws a `TypeError`,
  and so does any `--headless` or `--headless=...` entry in `extraLaunchArgs`. A non-visual
  diagnostic belongs in a separate config.
- **Muted at the process level.** `--mute-audio` is the first launch argument, inside
  `provider.options.launchOptions.args`. There is no detached launch-argument array to forget.
  The consumer is still responsible for activating and asserting a non-persistent runtime mute route
  in the game, without touching the player's saved audio preference.
- **GPU-friendly.** The defaults enable the GPU path through ANGLE and SwiftShader so WebGL tests run
  on machines without a hardware GPU.
- **One browser.** `fileParallelism` defaults to `false` because real-Chromium tests share one
  instance. In Vitest 5 it is the top-level `test.fileParallelism`; spread it there.
- **A stable module graph.** `three` is pre-bundled by default (`includeThree: true`) so Vite's
  dep-optimizer does not re-bundle mid-run and create a second React instance. Set
  `includeThree: false` for Pixi, canvas and DOM-only games, and list other modules in
  `optimizeDepsInclude`.

## `defineUnitTest`

Returns `{ include, exclude, environment, environmentOptions? }` for pure-logic tests. The default
environment is `jsdom`, with the origin set to `http://localhost:3000` because jsdom exposes
`localStorage` and `sessionStorage` only on a real origin. Pass `environment: "node"` for code that
never touches the DOM.

## `defaultBrowserLaunchArgs`

Returns the launch arguments `defineBrowserTest` uses, with your extras appended. It rejects hidden
headless flags too.

## Running

```sh
pnpm exec playwright install --with-deps --no-shell chromium
xvfb-run -a pnpm exec vitest run --config vitest.browser.config.ts   # Linux without a display
```
