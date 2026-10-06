import { describe, expect, it } from "vitest";
import { defaultBrowserLaunchArgs, defineBrowserTest, defineUnitTest } from "../src/vitest.js";

describe("defineUnitTest", () => {
  it("defaults to jsdom environment and the standard include/exclude globs", () => {
    const config = defineUnitTest();
    expect(config?.environment).toBe("jsdom");
    expect(config?.include).toContain("tests/unit/**/*.{test,spec}.{ts,tsx}");
    expect(config?.exclude).toContain("tests/browser/**");
    expect(config?.exclude).toContain("tests/e2e/**");
  });

  it("honors caller-supplied include/exclude/environment", () => {
    const config = defineUnitTest({
      include: ["custom/**/*.test.ts"],
      exclude: ["custom/skip/**"],
      environment: "node",
    });
    expect(config?.include).toEqual(["custom/**/*.test.ts"]);
    expect(config?.exclude).toEqual(["custom/skip/**"]);
    expect(config?.environment).toBe("node");
  });
});

describe("defineBrowserTest", () => {
  it("always emits a headed, process-muted Chromium contract", () => {
    const config = defineBrowserTest();
    expect(config.browser.headless).toBe(false);
    expect(config.browser.provider.name).toBe("playwright");
    const args = config.browser.provider.options.launchOptions?.args ?? [];
    expect(args).toContain("--mute-audio");
    expect(args.some((argument) => /^--headless(?:=|$)/.test(argument))).toBe(false);
    expect("launchArgs" in config).toBe(false);
  });

  it("rejects the removed headless option even when JavaScript bypasses the type", () => {
    const unsafeOptions = { headless: true } as Parameters<typeof defineBrowserTest>[0] & {
      headless: boolean;
    };
    expect(() => defineBrowserTest(unsafeOptions)).toThrow(/does not accept a headless override/);
  });

  it("rejects a hidden headless Chromium launch argument", () => {
    expect(() => defineBrowserTest({ extraLaunchArgs: ["--headless=new"] })).toThrow(
      /rejects hidden Chromium headless flags/,
    );
  });

  it("always includes three in optimizeDeps, plus caller extras", () => {
    const config = defineBrowserTest({ optimizeDepsInclude: ["declarative-hex-worlds"] });
    expect(config.optimizeDeps.include).toEqual(["three", "declarative-hex-worlds"]);
  });

  it("lets non-Three renderers omit the Three dependency", () => {
    const config = defineBrowserTest({
      includeThree: false,
      optimizeDepsInclude: ["pixi.js", "koota"],
    });
    expect(config.optimizeDeps.include).toEqual(["pixi.js", "koota"]);
  });

  it("defaults fileParallelism to false (shared browser instance)", () => {
    const config = defineBrowserTest();
    expect(config.fileParallelism).toBe(false);
    expect("fileParallelism" in config.browser).toBe(false);
  });

  it("returns the default GPU/ANGLE launch args plus any extras", () => {
    const config = defineBrowserTest({ extraLaunchArgs: ["--foo"] });
    expect(config.browser.provider.options.launchOptions?.args).toEqual([
      "--mute-audio",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
      "--foo",
    ]);
  });
});

describe("defaultBrowserLaunchArgs", () => {
  it("returns the fleet-standard GPU/ANGLE args with no extras", () => {
    expect(defaultBrowserLaunchArgs()).toEqual([
      "--mute-audio",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
    ]);
  });

  it("rejects direct headless flags", () => {
    expect(() => defaultBrowserLaunchArgs(["--headless"])).toThrow(
      /rejects hidden Chromium headless flags/,
    );
  });
});
