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

  it("sets the @ alias to srcDir (default ./src)", () => {
    const config = defineGamePreset({ appName: "kuroga" });
    const alias = config.resolve?.alias as Record<string, string>;
    expect(alias["@"]).toBe("./src");
  });

  it("honors a custom srcDir for the @ alias", () => {
    const config = defineGamePreset({ appName: "kuroga", srcDir: "./app" });
    const alias = config.resolve?.alias as Record<string, string>;
    expect(alias["@"]).toBe("./app");
  });

  it("wires three.js optimizeDeps.include and a manualChunks function when heavyDeps.three is set", () => {
    const config = defineGamePreset({ appName: "kuroga", heavyDeps: { three: true } });
    expect(config.optimizeDeps?.include).toContain("three");
    const manualChunks = config.build?.rollupOptions?.output as { manualChunks?: unknown };
    expect(typeof manualChunks?.manualChunks).toBe("function");
  });

  it("manualChunks buckets three/rapier node_modules paths into three-vendor", () => {
    const config = defineGamePreset({
      appName: "kuroga",
      heavyDeps: { three: true, rapier: true },
    });
    const output = config.build?.rollupOptions?.output as
      | { manualChunks: (id: string) => string | undefined }
      | undefined;
    if (!output) throw new Error("expected build.rollupOptions.output to be set");
    expect(output.manualChunks("/repo/node_modules/three/build/three.module.js")).toBe(
      "three-vendor",
    );
    expect(output.manualChunks("/repo/node_modules/@dimforge/rapier3d-compat/rapier.js")).toBe(
      "three-vendor",
    );
    expect(output.manualChunks("/repo/src/App.tsx")).toBeUndefined();
  });

  it("excludes rapier from optimizeDeps (async WASM init can't be pre-bundled)", () => {
    const config = defineGamePreset({ appName: "kuroga", heavyDeps: { rapier: true } });
    expect(config.optimizeDeps?.exclude).toContain("@dimforge/rapier3d-compat");
  });

  it("buckets phaser into phaser-vendor via manualChunks", () => {
    const config = defineGamePreset({ appName: "kuroga", heavyDeps: { phaser: true } });
    const output = config.build?.rollupOptions?.output as
      | { manualChunks: (id: string) => string | undefined }
      | undefined;
    if (!output) throw new Error("expected build.rollupOptions.output to be set");
    expect(output.manualChunks("/repo/node_modules/phaser/dist/phaser.js")).toBe("phaser-vendor");
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
});
