import { androidVersionGradleSnippet } from "./capacitor.js";

/** What a CLI invocation prints and the exit code it ends with. */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `build-preset init-android`
 *
 * Prints the CI-parameterized versionName/versionCode override block a
 * consumer applies to `android/app/build.gradle`'s `defaultConfig` after
 * `cap add android`. Kept as a print-and-paste helper rather than an
 * in-place file editor: build.gradle is generated/hand-edited native
 * project config the caller owns, and Capacitor's own `cap add android`
 * scaffold already produces the surrounding file. This only supplies the
 * one block that scaffold hardcodes (`versionCode 1` / `versionName "1.0"`)
 * instead of parameterizing.
 */
function initAndroid(): string {
  return [
    "Paste the following into android/app/build.gradle's defaultConfig block,",
    "replacing the existing `versionCode` / `versionName` lines:",
    "",
    androidVersionGradleSnippet(),
    "",
    "Then build with:",
    "  ./gradlew bundleRelease -PversionName=$npm_package_version -PversionCode=$" +
      "{ANDROID_VERSION_CODE:-1}",
    "",
  ].join("\n");
}

/** Runs one CLI command without touching the process, so it can be tested directly. */
export function runCli(command: string | undefined): CliResult {
  if (command === "init-android") {
    return { stdout: initAndroid(), stderr: "", exitCode: 0 };
  }
  return {
    stdout: "",
    stderr: [
      `Unknown command: ${command ?? "(none)"}`,
      "",
      "Usage:",
      "  build-preset init-android",
      "",
    ].join("\n"),
    exitCode: 1,
  };
}
