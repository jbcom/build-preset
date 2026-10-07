import { describe, expect, it } from "vitest";
import { androidVersionGradleSnippet } from "../src/capacitor.js";
import { runCli } from "../src/cliCommands.js";

describe("runCli", () => {
  it("prints the Android version scaffold for init-android", () => {
    const result = runCli("init-android");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(androidVersionGradleSnippet());
    expect(result.stdout).toContain("bundleRelease");
    expect(result.stdout).toContain("ANDROID_VERSION_CODE:-1");
  });

  it("names an unknown command and exits 1", () => {
    const result = runCli("deploy");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown command: deploy");
    expect(result.stderr).toContain("build-preset init-android");
  });

  it("explains that no command was given", () => {
    const result = runCli(undefined);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: (none)");
  });
});
