import type { Plugin } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { defineGamePreset } from "../src/vite.js";

const ENV_KEYS = ["VITE_BASE", "CAPACITOR", "GITHUB_PAGES"] as const;

function resetEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("defineGamePreset", () => {
  afterEach(resetEnv);

  it("defaults base to / with no env set", () => {
    resetEnv();
    const config = defineGamePreset({ appName: "kuroga" });
    expect(config.base).toBe("/");
  });

  it("derives GitHub Pages base from appName when GITHUB_PAGES=true", () => {
    resetEnv();
    process.env.GITHUB_PAGES = "true";
    const config = defineGamePreset({ appName: "kuroga" });
    expect(config.base).toBe("/kuroga/");
  });

  it("uses / when CAPACITOR=true even if GITHUB_PAGES is also set", () => {
    resetEnv();
    process.env.CAPACITOR = "true";
    const config = defineGamePreset({ appName: "kuroga" });
    expect(config.base).toBe("/");
  });

  it("explicit base option wins over every env derivation", () => {
    resetEnv();
    process.env.VITE_BASE = "/from-env/";
    const config = defineGamePreset({ appName: "kuroga", base: "/explicit/" });
    expect(config.base).toBe("/explicit/");
  });

  it("VITE_BASE env wins over CAPACITOR/GITHUB_PAGES derivation", () => {
    resetEnv();
    process.env.VITE_BASE = "/from-env/";
    process.env.CAPACITOR = "true";
    const config = defineGamePreset({ appName: "kuroga" });
    expect(config.base).toBe("/from-env/");
  });

  it("always dedupes react/react-dom, plus caller-supplied dedupe entries", () => {
    const config = defineGamePreset({ appName: "kuroga", dedupe: ["koota", "three"] });
    expect(config.resolve?.dedupe).toEqual(["react", "react-dom", "koota", "three"]);
  });

  it("safely omits the @ alias when srcDir is not explicit", () => {
    const config = defineGamePreset({ appName: "kuroga" });
    expect(config.resolve?.alias).toBeUndefined();
  });

  it("honors an explicit absolute srcDir for the @ alias", () => {
    const config = defineGamePreset({ appName: "kuroga", srcDir: "/workspace/game/src" });
    const alias = config.resolve?.alias as Record<string, string>;
    expect(alias["@"]).toBe("/workspace/game/src");
  });

  it("normalizes an absolute Windows srcDir for Vite", () => {
    const config = defineGamePreset({ appName: "kuroga", srcDir: "C:\\games\\kuroga\\src" });
    const alias = config.resolve?.alias as Record<string, string>;
    expect(alias["@"]).toBe("C:/games/kuroga/src");
  });

  it("rejects relative srcDir aliases", () => {
    expect(() => defineGamePreset({ appName: "kuroga", srcDir: "./src" })).toThrow(
      /srcDir must be an absolute filesystem path/,
    );
  });

  it("wires three.js optimizeDeps.include and a Rolldown code-splitting group", () => {
    const config = defineGamePreset({ appName: "kuroga", heavyDeps: { three: true } });
    expect(config.optimizeDeps?.include).toContain("three");
    const output = config.build?.rolldownOptions?.output as
      | { codeSplitting?: { groups?: Array<{ name: string; test: RegExp }> } }
      | undefined;
    expect(output?.codeSplitting?.groups?.map(({ name }) => name)).toEqual(["three-vendor"]);
  });

  it("groups three and Rapier paths into the same vendor boundary", () => {
    const config = defineGamePreset({
      appName: "kuroga",
      heavyDeps: { three: true, rapier: true },
    });
    const output = config.build?.rolldownOptions?.output as
      | { codeSplitting: { groups: Array<{ name: string; test: RegExp }> } }
      | undefined;
    if (!output) throw new Error("expected build.rolldownOptions.output to be set");
    const group = output.codeSplitting.groups.find(({ name }) => name === "three-vendor");
    if (!group) throw new Error("expected three-vendor code-splitting group");
    expect(group.test.test("/repo/node_modules/three/build/three.module.js")).toBe(true);
    expect(group.test.test("/repo/node_modules/@dimforge/rapier3d-compat/rapier.js")).toBe(true);
    expect(group.test.test("C:\\repo\\node_modules\\three\\build\\three.module.js")).toBe(true);
    expect(group.test.test("C:\\repo\\node_modules\\@dimforge\\rapier3d-compat\\rapier.js")).toBe(
      true,
    );
    expect(group.test.test("/repo/src/App.tsx")).toBe(false);
  });

  it("excludes rapier from optimizeDeps (async WASM init can't be pre-bundled)", () => {
    const config = defineGamePreset({ appName: "kuroga", heavyDeps: { rapier: true } });
    expect(config.optimizeDeps?.exclude).toContain("@dimforge/rapier3d-compat");
  });

  it("groups Phaser into its own Rolldown vendor boundary", () => {
    const config = defineGamePreset({ appName: "kuroga", heavyDeps: { phaser: true } });
    const output = config.build?.rolldownOptions?.output as
      | { codeSplitting: { groups: Array<{ name: string; test: RegExp }> } }
      | undefined;
    if (!output) throw new Error("expected build.rolldownOptions.output to be set");
    const group = output.codeSplitting.groups.find(({ name }) => name === "phaser-vendor");
    expect(group?.test.test("/repo/node_modules/phaser/dist/phaser.js")).toBe(true);
    expect(group?.test.test("C:\\repo\\node_modules\\phaser\\dist\\phaser.js")).toBe(true);
  });

  it("omits optimizeDeps/build entirely when no heavyDeps are set", () => {
    const config = defineGamePreset({ appName: "kuroga" });
    expect(config.optimizeDeps).toBeUndefined();
    expect(config.build).toBeUndefined();
  });

  it("merges default watch-ignore globs with caller-supplied extras", () => {
    const config = defineGamePreset({ appName: "kuroga", watchIgnore: ["**/coverage/**"] });
    const ignored = config.server?.watch?.ignored as string[];
    expect(ignored).toContain("**/diagnostics/**");
    expect(ignored).toContain("**/test-results/**");
    expect(ignored).toContain("**/coverage/**");
  });

  it("plugins from caller are passed through in order", () => {
    const pluginA: Plugin = { name: "a" };
    const pluginB: Plugin = { name: "b" };
    const config = defineGamePreset({
      appName: "kuroga",
      plugins: [pluginA, pluginB],
    });
    expect(config.plugins?.map((p) => (p as Plugin).name)).toEqual(["a", "b"]);
  });

  it("overrides.plugins are appended after preset plugins", () => {
    const base: Plugin = { name: "base" };
    const extra: Plugin = { name: "extra" };
    const config = defineGamePreset({
      appName: "kuroga",
      plugins: [base],
      overrides: { plugins: [extra] },
    });
    expect(config.plugins?.map((p) => (p as Plugin).name)).toEqual(["base", "extra"]);
  });

  it("deep-merges caller overrides without erasing preset-owned nested config", () => {
    const config = defineGamePreset({
      appName: "kuroga",
      srcDir: "/workspace/game/src",
      heavyDeps: { three: true },
      overrides: {
        build: { sourcemap: true },
        optimizeDeps: { include: ["koota"] },
        resolve: { alias: { fixtures: "/fixtures" }, dedupe: ["zustand"] },
        server: { port: 4312 },
      },
    });

    expect(config.build?.sourcemap).toBe(true);
    expect(config.build?.rolldownOptions?.output).toBeDefined();
    expect(config.optimizeDeps?.include).toEqual(["three", "koota"]);
    expect(config.resolve?.dedupe).toEqual(["react", "react-dom", "zustand"]);
    expect(config.resolve?.alias).toMatchObject({
      "@": "/workspace/game/src",
      fixtures: "/fixtures",
    });
    expect(config.server?.port).toBe(4312);
    expect(config.server?.watch?.ignored).toContain("**/diagnostics/**");
  });

  it("lets a caller replace a preset code-splitting group by name without duplication", () => {
    const callerGroup = {
      name: "three-vendor",
      test: /caller-three/,
    };
    const config = defineGamePreset({
      appName: "kuroga",
      heavyDeps: { three: true },
      overrides: {
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: {
                groups: [callerGroup, { name: "game-vendor", test: /game-vendor/ }],
              },
            },
          },
        },
      },
    });
    const output = config.build?.rolldownOptions?.output as
      | { codeSplitting: { groups: Array<{ name: string; test: RegExp }> } }
      | undefined;
    if (!output) throw new Error("expected code-splitting output");
    expect(output.codeSplitting.groups.map(({ name }) => name)).toEqual([
      "three-vendor",
      "game-vendor",
    ]);
    expect(output.codeSplitting.groups[0]).toBe(callerGroup);
  });
});
