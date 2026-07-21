import { afterEach, describe, expect, it } from "vitest";
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
  afterEach(() => {
    delete process.env.CI;
    delete process.env.VITEST_BROWSER_HEADLESS;
  });

  it("defaults headless to false when CI is unset", () => {
    delete process.env.CI;
    const config = defineBrowserTest();
    expect(config.browser.headless).toBe(false);
  });

  it("defaults headless to true when CI is set", () => {
    process.env.CI = "true";
    const config = defineBrowserTest();
    expect(config.browser.headless).toBe(true);
  });

  it("VITEST_BROWSER_HEADLESS=false overrides CI=true (local escape hatch)", () => {
    process.env.CI = "true";
    process.env.VITEST_BROWSER_HEADLESS = "false";
    const config = defineBrowserTest();
    expect(config.browser.headless).toBe(false);
  });

  it("explicit headless option wins over env entirely", () => {
    process.env.CI = "true";
    const config = defineBrowserTest({ headless: false });
    expect(config.browser.headless).toBe(false);
  });

  it("always includes three in optimizeDeps, plus caller extras", () => {
    const config = defineBrowserTest({ optimizeDepsInclude: ["declarative-hex-worlds"] });
    expect(config.optimizeDeps.include).toEqual(["three", "declarative-hex-worlds"]);
  });

  it("defaults fileParallelism to false (shared browser instance)", () => {
    const config = defineBrowserTest();
    expect(config.browser.fileParallelism).toBe(false);
  });

  it("returns the default GPU/ANGLE launch args plus any extras", () => {
    const config = defineBrowserTest({ extraLaunchArgs: ["--foo"] });
    expect(config.launchArgs).toEqual([
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
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
    ]);
  });
});
