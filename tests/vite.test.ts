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
    const config = defineGamePreset({ appName: "example-game" });
    expect(config.base).toBe("/");
  });

  it("derives GitHub Pages base from appName when GITHUB_PAGES=true", () => {
    resetEnv();
    process.env.GITHUB_PAGES = "true";
    const config = defineGamePreset({ appName: "example-game" });
    expect(config.base).toBe("/example-game/");
  });

  it("uses / when CAPACITOR=true even if GITHUB_PAGES is also set", () => {
    resetEnv();
    process.env.CAPACITOR = "true";
    const config = defineGamePreset({ appName: "example-game" });
    expect(config.base).toBe("/");
  });

  it("explicit base option wins over every env derivation", () => {
    resetEnv();
    process.env.VITE_BASE = "/from-env/";
    const config = defineGamePreset({ appName: "example-game", base: "/explicit/" });
    expect(config.base).toBe("/explicit/");
  });

  it("VITE_BASE env wins over CAPACITOR/GITHUB_PAGES derivation", () => {
    resetEnv();
    process.env.VITE_BASE = "/from-env/";
    process.env.CAPACITOR = "true";
    const config = defineGamePreset({ appName: "example-game" });
    expect(config.base).toBe("/from-env/");
  });

  it("always dedupes react/react-dom, plus caller-supplied dedupe entries", () => {
    const config = defineGamePreset({ appName: "example-game", dedupe: ["koota", "three"] });
    expect(config.resolve?.dedupe).toEqual(["react", "react-dom", "koota", "three"]);
  });

  it("safely omits the @ alias when srcDir is not explicit", () => {
    const config = defineGamePreset({ appName: "example-game" });
    expect(config.resolve?.alias).toBeUndefined();
  });

  it("honors an explicit absolute srcDir for the @ alias", () => {
    const config = defineGamePreset({ appName: "example-game", srcDir: "/workspace/game/src" });
    const alias = config.resolve?.alias as Record<string, string>;
    expect(alias["@"]).toBe("/workspace/game/src");
  });

  it("normalizes an absolute Windows srcDir for Vite", () => {
    const config = defineGamePreset({
      appName: "example-game",
      srcDir: "C:\\games\\example-game\\src",
    });
    const alias = config.resolve?.alias as Record<string, string>;
    expect(alias["@"]).toBe("C:/games/example-game/src");
  });

  it("rejects relative srcDir aliases", () => {
    expect(() => defineGamePreset({ appName: "example-game", srcDir: "./src" })).toThrow(
      /srcDir must be an absolute filesystem path/,
    );
  });

  it("wires three.js optimizeDeps.include and a Rolldown code-splitting group", () => {
    const config = defineGamePreset({ appName: "example-game", heavyDeps: { three: true } });
    expect(config.optimizeDeps?.include).toContain("three");
    const output = config.build?.rolldownOptions?.output as
      | { codeSplitting?: { groups?: Array<{ name: string; test: RegExp }> } }
      | undefined;
    expect(output?.codeSplitting?.groups?.map(({ name }) => name)).toEqual(["three-vendor"]);
  });

  it("groups three and Rapier paths into the same vendor boundary", () => {
    const config = defineGamePreset({
      appName: "example-game",
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
    const config = defineGamePreset({ appName: "example-game", heavyDeps: { rapier: true } });
    expect(config.optimizeDeps?.exclude).toContain("@dimforge/rapier3d-compat");
  });

  it("groups Phaser into its own Rolldown vendor boundary", () => {
    const config = defineGamePreset({ appName: "example-game", heavyDeps: { phaser: true } });
    const output = config.build?.rolldownOptions?.output as
      | { codeSplitting: { groups: Array<{ name: string; test: RegExp }> } }
      | undefined;
    if (!output) throw new Error("expected build.rolldownOptions.output to be set");
    const group = output.codeSplitting.groups.find(({ name }) => name === "phaser-vendor");
    expect(group?.test.test("/repo/node_modules/phaser/dist/phaser.js")).toBe(true);
    expect(group?.test.test("C:\\repo\\node_modules\\phaser\\dist\\phaser.js")).toBe(true);
  });

  it("omits optimizeDeps/build entirely when no heavyDeps are set", () => {
    const config = defineGamePreset({ appName: "example-game" });
    expect(config.optimizeDeps).toBeUndefined();
    expect(config.build).toBeUndefined();
  });

  it("merges default watch-ignore globs with caller-supplied extras", () => {
    const config = defineGamePreset({ appName: "example-game", watchIgnore: ["**/coverage/**"] });
    const ignored = config.server?.watch?.ignored as string[];
    expect(ignored).toContain("**/diagnostics/**");
    expect(ignored).toContain("**/test-results/**");
    expect(ignored).toContain("**/coverage/**");
  });

  it("plugins from caller are passed through in order", () => {
    const pluginA: Plugin = { name: "a" };
    const pluginB: Plugin = { name: "b" };
    const config = defineGamePreset({
      appName: "example-game",
      plugins: [pluginA, pluginB],
    });
    expect(config.plugins?.map((p) => (p as Plugin).name)).toEqual(["a", "b"]);
  });

  it("overrides.plugins are appended after preset plugins", () => {
    const base: Plugin = { name: "base" };
    const extra: Plugin = { name: "extra" };
    const config = defineGamePreset({
      appName: "example-game",
      plugins: [base],
      overrides: { plugins: [extra] },
    });
    expect(config.plugins?.map((p) => (p as Plugin).name)).toEqual(["base", "extra"]);
  });

  it("deep-merges caller overrides without erasing preset-owned nested config", () => {
    const config = defineGamePreset({
      appName: "example-game",
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
      appName: "example-game",
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

  it("leaves a caller's non-object or group-less rolldown output untouched", () => {
    const arrayOutput = [{ entryFileNames: "a.js" }];
    const withArray = defineGamePreset({
      appName: "example-game",
      overrides: { build: { rolldownOptions: { output: arrayOutput } } },
    });
    expect(withArray.build?.rolldownOptions?.output).toEqual(arrayOutput);

    const withoutGroups = defineGamePreset({
      appName: "example-game",
      overrides: { build: { rolldownOptions: { output: { entryFileNames: "b.js" } } } },
    });
    expect(withoutGroups.build?.rolldownOptions?.output).toEqual({ entryFileNames: "b.js" });

    const withoutOutput = defineGamePreset({ appName: "example-game" });
    expect(withoutOutput.build?.rolldownOptions?.output).toBeUndefined();
  });

  it("keeps caller code-splitting groups that have no name, in order", () => {
    // The type requires a name; a JavaScript caller can omit it, and that is what is under test.
    const anonymous = { test: /anonymous/ } as unknown as { name: string; test: RegExp };
    const config = defineGamePreset({
      appName: "example-game",
      heavyDeps: { phaser: true },
      overrides: {
        build: {
          rolldownOptions: {
            output: { codeSplitting: { groups: [anonymous, anonymous] } },
          },
        },
      },
    });
    const output = config.build?.rolldownOptions?.output as
      | { codeSplitting: { groups: unknown[] } }
      | undefined;
    if (!output) throw new Error("expected code-splitting output");
    expect(output.codeSplitting.groups).toHaveLength(3);
    expect(output.codeSplitting.groups.slice(1)).toEqual([anonymous, anonymous]);
  });
});
