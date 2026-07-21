export interface DefineUnitTestOptions {
  /** Glob(s) for pure-logic unit test files. */
  include?: string[];
  /** Glob(s) to exclude (browser/e2e suites always excluded by default). */
  exclude?: string[];
  /** jsdom (default) or node — jsdom needed for DOM-touching unit tests. */
  environment?: "jsdom" | "node";
  /** Path alias target for "@/*" (defaults to "./src"). */
  srcDir?: string;
}

/** Minimal config fragment this preset returns — spread directly into
 * vitest's real `test` field (`defineConfig({ test: { ...defineUnitTest() } })`). */
export interface UnitTestFragment {
  include: string[];
  exclude: string[];
  environment: "jsdom" | "node";
}

/**
 * Node/jsdom unit-test config fragment — little-legends' vitest.config.ts
 * pattern: pure sim code (grid math, RNG determinism, worldgen, turn
 * systems) run fast without a real browser. Real-browser component tests
 * use `defineBrowserTest` instead.
 */
export function defineUnitTest(options: DefineUnitTestOptions = {}): UnitTestFragment {
  const {
    include = ["tests/unit/**/*.{test,spec}.{ts,tsx}", "src/**/*.{test,spec}.{ts,tsx}"],
    exclude = ["tests/browser/**", "tests/e2e/**", "node_modules", "dist", "android"],
    environment = "jsdom",
  } = options;

  return {
    include,
    exclude,
    environment,
  };
}

export interface DefineBrowserTestOptions {
  /** Glob(s) for real-browser component test files. */
  include?: string[];
  /**
   * Extra module ids to pre-list in optimizeDeps.include so Vite's
   * dep-optimizer doesn't discover them mid-test-run. A mid-run re-bundle
   * reloads the module graph and produces a SECOND React instance, which
   * throws "Invalid hook call" from inside R3F's own <Canvas> — a real,
   * previously-hit bug (little-legends' vitest.browser.config.ts, hex-board
   * spike) this preset now encodes once instead of every repo rediscovering
   * it. `three` and `react`-adjacent deps are pre-included by default.
   */
  optimizeDepsInclude?: string[];
  /** Headless override. Defaults to CI-driven (headless in CI, headed locally),
   * with a `VITEST_BROWSER_HEADLESS=false` local escape hatch. */
  headless?: boolean;
  /** Disable file parallelism (default true — real-Chromium tests share one browser instance). */
  fileParallelism?: boolean;
  /** Extra Playwright chromium launch args, appended after the GPU/ANGLE defaults. */
  extraLaunchArgs?: string[];
}

function deriveHeadless(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  if (process.env.VITEST_BROWSER_HEADLESS === "false") return false;
  return !!process.env.CI;
}

/** Playwright's three supported browser engines (mirrors vitest's own
 * `BrowserInstanceOption['browser']` union without a hard dependency on
 * @vitest/browser-playwright). */
export type PlaywrightBrowserName = "chromium" | "firefox" | "webkit";

/** Minimal browser-test config shape this preset returns — the consumer
 * spreads it into vitest's real `test.browser` field, supplying its own
 * `provider` (e.g. `playwright({ launchOptions: { args } })`) since this
 * package intentionally has no hard dependency on @vitest/browser-playwright. */
export interface BrowserTestFragment {
  enabled: true;
  instances: Array<{ browser: PlaywrightBrowserName }>;
  headless: boolean;
  screenshotFailures: true;
  fileParallelism: boolean;
}

/**
 * Real-browser (Chromium via Playwright) test config fragment — drives the
 * app through the DOM/store and asserts rendered output, not raw pixels.
 * Ships the GPU/ANGLE launch args and dep-optimizer pre-bundle list that
 * little-legends' vitest.browser.config.ts hand-rolled and documented.
 */
export function defineBrowserTest(options: DefineBrowserTestOptions = {}): {
  include: string[];
  optimizeDeps: { include: string[] };
  browser: BrowserTestFragment;
  launchArgs: string[];
} {
  const {
    include = ["tests/browser/**/*.{test,spec}.{ts,tsx}"],
    optimizeDepsInclude = [],
    headless,
    fileParallelism = false,
    extraLaunchArgs = [],
  } = options;

  return {
    include,
    optimizeDeps: {
      include: ["three", ...optimizeDepsInclude],
    },
    browser: {
      enabled: true,
      instances: [{ browser: "chromium" }],
      headless: deriveHeadless(headless),
      screenshotFailures: true,
      fileParallelism,
    },
    launchArgs: defaultBrowserLaunchArgs(extraLaunchArgs),
  };
}

/** GPU/ANGLE Chromium launch args the fleet's browser configs converge on. */
export function defaultBrowserLaunchArgs(extra: string[] = []): string[] {
  return [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    ...extra,
  ];
}
