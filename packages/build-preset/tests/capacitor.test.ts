import { afterEach, describe, expect, it } from "vitest";
import { androidVersionGradleSnippet, defineCapacitorPreset } from "../src/capacitor.js";

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
});

describe("androidVersionGradleSnippet", () => {
  it("emits a versionCode/versionName block parameterized from Gradle properties", () => {
    const snippet = androidVersionGradleSnippet();
    expect(snippet).toContain("versionCode (project.hasProperty('versionCode')");
    expect(snippet).toContain("versionName (project.hasProperty('versionName')");
  });
});
