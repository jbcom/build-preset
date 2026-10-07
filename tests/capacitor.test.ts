import { afterEach, describe, expect, it } from "vitest";
import {
  androidVersionGradleSnippet,
  defineCapacitorPreset,
  mergeCapacitorConfig,
} from "../src/capacitor.js";

describe("defineCapacitorPreset", () => {
  afterEach(() => {
    delete process.env.CAP_DEBUG;
    delete process.env.MY_DEBUG_FLAG;
  });

  it("builds a config object with the expected shape and defaults", () => {
    const config = defineCapacitorPreset({ appId: "com.jbcom.kuroga", appName: "Kuroga" });
    expect(config).toMatchObject({
      appId: "com.jbcom.kuroga",
      appName: "Kuroga",
      webDir: "dist",
      server: { androidScheme: "https" },
      android: {
        path: "android",
        allowMixedContent: false,
        webContentsDebuggingEnabled: false,
      },
    });
  });

  it("defaults webContentsDebuggingEnabled to false when CAP_DEBUG is unset", () => {
    const config = defineCapacitorPreset({ appId: "com.jbcom.kuroga", appName: "Kuroga" });
    expect((config.android as Record<string, unknown>).webContentsDebuggingEnabled).toBe(false);
  });

  it("enables webContentsDebuggingEnabled when CAP_DEBUG=true", () => {
    process.env.CAP_DEBUG = "true";
    const config = defineCapacitorPreset({ appId: "com.jbcom.kuroga", appName: "Kuroga" });
    expect((config.android as Record<string, unknown>).webContentsDebuggingEnabled).toBe(true);
  });

  it("honors a custom debugEnvVar name", () => {
    process.env.MY_DEBUG_FLAG = "true";
    const config = defineCapacitorPreset({
      appId: "com.jbcom.kuroga",
      appName: "Kuroga",
      debugEnvVar: "MY_DEBUG_FLAG",
    });
    expect((config.android as Record<string, unknown>).webContentsDebuggingEnabled).toBe(true);
  });

  it("includes backgroundColor only when provided", () => {
    const withColor = defineCapacitorPreset({
      appId: "com.jbcom.kuroga",
      appName: "Kuroga",
      backgroundColor: "#261f1a",
    });
    expect(withColor.backgroundColor).toBe("#261f1a");

    const withoutColor = defineCapacitorPreset({ appId: "com.jbcom.kuroga", appName: "Kuroga" });
    expect(withoutColor.backgroundColor).toBeUndefined();
  });

  it("caller overrides win over preset defaults", () => {
    const config = defineCapacitorPreset({
      appId: "com.jbcom.kuroga",
      appName: "Kuroga",
      overrides: { webDir: "build" },
    });
    expect(config.webDir).toBe("build");
  });

  describe("nested overrides", () => {
    const base = { appId: "com.jbcom.kuroga", appName: "Kuroga" };

    it("keeps server.androidScheme when overrides.server only sets another key", () => {
      const config = defineCapacitorPreset({
        ...base,
        overrides: { server: { hostname: "kuroga.local" } },
      });
      expect(config.server).toEqual({ androidScheme: "https", hostname: "kuroga.local" });
    });

    it("keeps allowMixedContent and the debug-derived flag when overrides.android sets another key", () => {
      const config = defineCapacitorPreset({
        ...base,
        overrides: { android: { buildOptions: { releaseType: "AAB" } } },
      });
      expect(config.android).toEqual({
        path: "android",
        allowMixedContent: false,
        webContentsDebuggingEnabled: false,
        buildOptions: { releaseType: "AAB" },
      });

      process.env.CAP_DEBUG = "true";
      const debugConfig = defineCapacitorPreset({
        ...base,
        overrides: { android: { backgroundColor: "#000000" } },
      });
      expect(debugConfig.android).toMatchObject({
        allowMixedContent: false,
        webContentsDebuggingEnabled: true,
        backgroundColor: "#000000",
      });
    });

    it("lets an explicit override of a preset key win over the preset value", () => {
      process.env.CAP_DEBUG = "true";
      const config = defineCapacitorPreset({
        ...base,
        overrides: {
          server: { androidScheme: "http" },
          android: { allowMixedContent: true, webContentsDebuggingEnabled: false },
        },
      });
      expect(config.server).toEqual({ androidScheme: "http" });
      expect(config.android).toEqual({
        path: "android",
        allowMixedContent: true,
        webContentsDebuggingEnabled: false,
      });
    });

    it("merges ios one level deep and replaces top-level scalars", () => {
      const config = defineCapacitorPreset({
        ...base,
        overrides: { ios: { contentInset: "always" }, appName: "Renamed" },
      });
      expect(config.ios).toEqual({ contentInset: "always" });
      expect(config.appName).toBe("Renamed");
    });

    it("merges plugins per plugin, with the override winning per key", () => {
      const config = defineCapacitorPreset({
        ...base,
        overrides: {
          plugins: {
            SplashScreen: { launchShowDuration: 0, backgroundColor: "#111111" },
            Keyboard: { resize: "body" },
          },
        },
      });
      expect(config.plugins).toEqual({
        SplashScreen: { launchShowDuration: 0, backgroundColor: "#111111" },
        Keyboard: { resize: "body" },
      });
    });
  });
});

describe("mergeCapacitorConfig", () => {
  it("merges plugins per plugin: shared plugins merge per key, others pass through", () => {
    const merged = mergeCapacitorConfig(
      {
        appId: "a",
        plugins: {
          SplashScreen: { launchShowDuration: 3000, backgroundColor: "#222222" },
          Keyboard: { resize: "native" },
        },
      },
      {
        plugins: {
          SplashScreen: { launchShowDuration: 0 },
          StatusBar: { style: "DARK" },
        },
      },
    );
    expect(merged.plugins).toEqual({
      SplashScreen: { launchShowDuration: 0, backgroundColor: "#222222" },
      Keyboard: { resize: "native" },
      StatusBar: { style: "DARK" },
    });
  });

  it("replaces non-object values and does not merge into plugin arrays or scalars", () => {
    const merged = mergeCapacitorConfig(
      { webDir: "dist", server: { androidScheme: "https" }, plugins: { P: { list: [1, 2] } } },
      { webDir: "build", server: undefined, plugins: { P: { list: [3] } } },
    );
    expect(merged.webDir).toBe("build");
    expect(merged.server).toEqual({ androidScheme: "https" });
    expect(merged.plugins).toEqual({ P: { list: [3] } });
  });

  it("does not mutate its inputs", () => {
    const preset = { server: { androidScheme: "https" } };
    const overrides = { server: { hostname: "x.local" } };
    mergeCapacitorConfig(preset, overrides);
    expect(preset).toEqual({ server: { androidScheme: "https" } });
    expect(overrides).toEqual({ server: { hostname: "x.local" } });
  });
});

describe("androidVersionGradleSnippet", () => {
  it("emits a versionCode/versionName block parameterized from Gradle properties", () => {
    const snippet = androidVersionGradleSnippet();
    expect(snippet).toContain("versionCode (project.hasProperty('versionCode')");
    expect(snippet).toContain("versionName (project.hasProperty('versionName')");
  });
});
