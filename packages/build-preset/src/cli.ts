#!/usr/bin/env node
import { androidVersionGradleSnippet } from "./capacitor.js";

/**
 * `npx @arcade-cabinet/build-preset init-android`
 *
 * Prints the CI-parameterized versionName/versionCode override block a
 * consumer applies to `android/app/build.gradle`'s `defaultConfig` after
 * `cap add android`. Kept as a print-and-paste helper rather than an
 * in-place file editor: build.gradle is generated/hand-edited native
 * project config the caller owns, and Capacitor's own `cap add android`
 * scaffold already produces the surrounding file — this only supplies the
 * one block little-legends's own android/app/build.gradle hardcodes
 * (`versionCode 1` / `versionName "1.0"`) instead of parameterizing.
 */
function initAndroid(): void {
  process.stdout.write(
    [
      "Paste the following into android/app/build.gradle's defaultConfig block,",
      "replacing the existing `versionCode` / `versionName` lines:",
      "",
      androidVersionGradleSnippet(),
      "",
      "Then build with:",
      "  ./gradlew bundleRelease -PversionName=$npm_package_version -PversionCode=$" +
        "{ANDROID_VERSION_CODE:-1}",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [, , command, ...arguments_] = process.argv;
  switch (command) {
    case "init-android":
      initAndroid();
      break;
    case "package-release": {
      const release = await import("../private-package-release/cli.mjs");
      await release.main(arguments_);
      break;
    }
    case "dependency-current": {
      const current = await import("../private-package-release/dependency-current.mjs");
      await current.dependencyCurrentMain(arguments_);
      break;
    }
    default:
      process.stderr.write(
        [
          `Unknown command: ${command ?? "(none)"}`,
          "",
          "Usage:",
          "  build-preset init-android",
          "  build-preset dependency-current --config <path>",
          "  build-preset package-release <prepare|publish|profile-sbom> --config <path> [options]",
          "",
        ].join("\n"),
      );
      process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error ? Number(error.exitCode) : 1;
});
