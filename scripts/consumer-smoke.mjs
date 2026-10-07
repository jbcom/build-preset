#!/usr/bin/env node
// Packed-consumer smoke: packs the package, installs the tarball into an empty scratch project that
// can reach only the public npm registry (no scoped registry, no token, no ambient npm config), and
// proves every entry point loads under ESM and CommonJS, type-checks, and builds with Vite.
//
// Environment:
//   BUILD_PRESET_CONSUMER_SOURCE  install this exact registry spec (e.g. build-preset@0.4.0)
//                                 instead of packing the working tree
//   BUILD_PRESET_CONSUMER_VITEST  Vitest line for the consumer: a major ("4") or a range;
//                                 defaults to this repository's own Vitest range
//   BUILD_PRESET_RUN_BROWSER=1    also launch real headed Chromium against the consumer
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const pnpmCli = process.env.npm_execpath;
const requestedSource = process.env.BUILD_PRESET_CONSUMER_SOURCE;
const runBrowser = process.env.BUILD_PRESET_RUN_BROWSER === "1";

if (!pnpmCli) {
  throw new Error("consumer smoke must run through pnpm so npm_execpath identifies the pnpm CLI");
}

// The peer range spans two Vitest majors, so CI runs this once per supported major.
function vitestRange(request) {
  if (!request) return packageJson.devDependencies.vitest;
  if (request === "4") return "^4.1.10"; // the first Vitest 4 release the peer range accepts
  return /^\d+$/.test(request) ? `^${request}.0.0` : request;
}
const vitestSpec = vitestRange(process.env.BUILD_PRESET_CONSUMER_VITEST);
const consumerVitestMajor = /(\d+)/.exec(vitestSpec)?.[1];

function pnpm(args, cwd, env) {
  const javascriptCli = /\.[cm]?js$/i.test(pnpmCli);
  return execFileSync(
    javascriptCli ? process.execPath : pnpmCli,
    javascriptCli ? [pnpmCli, ...args] : args,
    { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

// An environment with no registry credentials, no ambient npm configuration and an empty home, so
// the install can only succeed against what the public registry serves anonymously.
const AUTH_ENV = /auth|password|token|secret|credential|cookie/i;
function anonymousEnvironment(home, userConfig) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^npm_config_/i.test(key)) continue;
    if (AUTH_ENV.test(key) && key !== "XAUTHORITY") continue;
    if (/^(?:XDG_|PNPM_HOME|NODE_PATH|ACTIONS_|RUNNER_)/i.test(key)) continue;
    environment[key] = value;
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
  };
}

const scratch = await mkdtemp(path.join(tmpdir(), "build-preset-consumer-"));

try {
  let packageSource = requestedSource;
  let archiveSha256 = "registry-source";
  if (!packageSource) {
    pnpm(["pack", "--pack-destination", scratch], packageRoot, process.env);
    const archiveName = (await readdir(scratch)).find((name) => name.endsWith(".tgz"));
    if (!archiveName) throw new Error("pnpm pack did not create a tarball");
    const archive = path.join(scratch, archiveName);
    archiveSha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    packageSource = `file:${archive}`;
  }

  const userConfig = path.join(scratch, ".npmrc");
  await writeFile(userConfig, "registry=https://registry.npmjs.org/\n");
  await writeFile(path.join(scratch, "pnpm-workspace.yaml"), 'packages:\n  - "."\n');
  const environment = anonymousEnvironment(path.join(scratch, "anonymous-home"), userConfig);
  if (runBrowser && !environment.PLAYWRIGHT_BROWSERS_PATH) {
    const originalHome = process.env.HOME;
    if (!originalHome) throw new Error("browser smoke requires the original HOME for its cache");
    environment.PLAYWRIGHT_BROWSERS_PATH =
      process.platform === "darwin"
        ? path.join(originalHome, "Library/Caches/ms-playwright")
        : path.join(originalHome, ".cache/ms-playwright");
  }

  await writeFile(
    path.join(scratch, "package.json"),
    `${JSON.stringify(
      {
        name: "build-preset-clean-consumer",
        private: true,
        type: "module",
        dependencies: {
          "build-preset": packageSource,
          "@types/node": packageJson.devDependencies["@types/node"],
          "@vitest/browser-playwright": vitestSpec,
          playwright: packageJson.devDependencies.playwright,
          tsup: packageJson.devDependencies.tsup,
          typescript: packageJson.devDependencies.typescript,
          vite: packageJson.devDependencies.vite,
          vitest: vitestSpec,
        },
      },
      null,
      2,
    )}\n`,
  );
  pnpm(["install", "--ignore-scripts", "--frozen-lockfile=false"], scratch, environment);

  const installedRoot = path.join(scratch, "node_modules", "build-preset");
  const installedEntries = new Set(await readdir(installedRoot));
  for (const required of [
    "dist",
    "docs",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "package.json",
    "biome.base.json",
    "tsconfig.base.json",
  ]) {
    if (!installedEntries.has(required)) throw new Error(`packed artifact omitted ${required}`);
  }
  for (const forbidden of ["src", "scripts", "tests", "coverage", "private-package-release"]) {
    if (installedEntries.has(forbidden)) throw new Error(`packed artifact leaked ${forbidden}/`);
  }
  const readInstalledVersion = async (name) =>
    JSON.parse(await readFile(path.join(scratch, "node_modules", name, "package.json"), "utf8"))
      .version;
  const installedPackageJson = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  if (installedPackageJson.version !== packageJson.version && !requestedSource) {
    throw new Error(
      `clean consumer resolved build-preset ${installedPackageJson.version}; expected ${packageJson.version}`,
    );
  }
  if (
    JSON.stringify(installedPackageJson.peerDependencies) !==
    JSON.stringify(packageJson.peerDependencies)
  ) {
    throw new Error("packed artifact has different peer ranges than the source manifest");
  }
  if (installedPackageJson.dependencies !== undefined) {
    throw new Error("packed artifact declares runtime dependencies");
  }
  const installedVitest = await readInstalledVersion("vitest");
  if (!installedVitest.startsWith(`${consumerVitestMajor}.`)) {
    throw new Error(
      `clean consumer resolved Vitest ${installedVitest} for major ${consumerVitestMajor}`,
    );
  }
  const installedPlaywright = await readInstalledVersion("playwright");
  const installedVite = await readInstalledVersion("vite");

  await mkdir(path.join(scratch, "src"), { recursive: true });
  await writeFile(
    path.join(scratch, "index.html"),
    '<div id="app"></div><script type="module" src="/src/main.js"></script>\n',
  );
  await writeFile(
    path.join(scratch, "src/main.js"),
    'import { message } from "@/message.js"; document.querySelector("#app").textContent = message;\n',
  );
  await writeFile(
    path.join(scratch, "src/message.js"),
    'export const message = "built-tar-consumer";\n',
  );
  await writeFile(
    path.join(scratch, "smoke.mjs"),
    `import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "vite";
import * as rootPreset from "build-preset";
import * as capacitorPreset from "build-preset/capacitor";
import * as tsupPreset from "build-preset/tsup";
import * as vitePreset from "build-preset/vite";
import * as vitestPreset from "build-preset/vitest";

const require = createRequire(import.meta.url);
const cjs = {
  root: require("build-preset"),
  capacitor: require("build-preset/capacitor"),
  tsup: require("build-preset/tsup"),
  vite: require("build-preset/vite"),
  vitest: require("build-preset/vitest"),
};
const esm = {
  root: rootPreset,
  capacitor: capacitorPreset,
  tsup: tsupPreset,
  vite: vitePreset,
  vitest: vitestPreset,
};
const expected = {
  root: ["defineGamePreset", "defineBrowserTest", "defineUnitTest", "defineCapacitorPreset"],
  capacitor: ["defineCapacitorPreset", "mergeCapacitorConfig", "androidVersionGradleSnippet"],
  tsup: ["libraryBuild"],
  vite: ["defineGamePreset"],
  vitest: ["defineUnitTest", "defineBrowserTest", "defaultBrowserLaunchArgs"],
};
for (const [entry, names] of Object.entries(expected)) {
  for (const name of names) {
    if (typeof esm[entry][name] !== "function") throw new Error("ESM " + entry + " is missing " + name);
    if (typeof cjs[entry][name] !== "function") throw new Error("CJS " + entry + " is missing " + name);
  }
}
if ("libraryBuild" in rootPreset) throw new Error("the barrel must not export the tsup entry point");

if (esm.vitest.defineUnitTest({ environment: "node" }).environment !== "node") {
  throw new Error("unit-test export failed");
}
const browserPreset = esm.root.defineBrowserTest({ includeThree: false });
const browserArgs = browserPreset.browser.provider.options.launchOptions?.args ?? [];
if (!browserArgs.includes("--mute-audio")) throw new Error("provider mute argument missing");
if (browserPreset.browser.headless !== false) throw new Error("browser preset was not headed");
if ("launchArgs" in browserPreset) throw new Error("detached launch arguments remained public");
if ("androidReleaseWorkflowSnippet" in capacitorPreset) {
  throw new Error("an Android release workflow API must not ship in the tarball");
}
const capacitorConfig = esm.capacitor.defineCapacitorPreset({
  appId: "com.example.fixture",
  appName: "Fixture",
  overrides: { server: { hostname: "fixture.local" } },
});
if (capacitorConfig.webDir !== "dist" || capacitorConfig.server.androidScheme !== "https") {
  throw new Error("Capacitor export failed");
}
const library = esm.tsup.libraryBuild({ name: "fixture-library" });
if (library.banner.js !== "/* fixture-library - ESM Build */") {
  throw new Error("tsup export failed");
}
if (cjs.tsup.libraryBuild({ name: "fixture-library" }).banner.js !== library.banner.js) {
  throw new Error("the CommonJS tsup build disagrees with the ESM build");
}
for (const file of ["biome.base.json", "tsconfig.base.json"]) {
  JSON.parse(await readFile(require.resolve("build-preset/" + file), "utf8"));
}

await build(
  esm.vite.defineGamePreset({
    appName: "fixture",
    srcDir: path.resolve("src"),
    overrides: { root: process.cwd(), logLevel: "silent" },
  }),
);
`,
  );
  await writeFile(
    path.join(scratch, "smoke.ts"),
    `import { defineBrowserTest, defineGamePreset } from "build-preset";
import { libraryBuild } from "build-preset/tsup";

const browser = defineBrowserTest({ includeThree: false });
const args: readonly string[] = browser.browser.provider.options.launchOptions?.args ?? [];
if (!args.includes("--mute-audio")) throw new Error("typed provider mute contract missing");

defineGamePreset({
  appName: "typed-fixture",
  srcDir: new URL("./src", import.meta.url).pathname,
});
const banner = libraryBuild({ name: "typed-fixture" }).banner;
// tsup types a banner as an object or a function of the build context.
const bannerJs = typeof banner === "function" ? undefined : banner?.js;
if (bannerJs !== "/* typed-fixture - ESM Build */") throw new Error("typed tsup contract missing");
`,
  );
  await writeFile(
    path.join(scratch, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends: "build-preset/tsconfig.base.json",
        compilerOptions: { types: ["node"], lib: ["ES2024", "DOM", "DOM.Iterable"] },
        include: ["smoke.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(scratch, "consumer.browser.test.ts"),
    `import { expect, it } from "vitest";

it("runs headed and silent without mutating a saved audio preference", async () => {
  const key = "build-preset-consumer:audio-settings";
  const seeded = JSON.stringify({ muted: false, musicVolume: 0.37, sfxVolume: 0.68 });
  localStorage.setItem(key, seeded);
  expect(document.documentElement.dataset.audioMode).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 750));
  expect(localStorage.getItem(key)).toBe(seeded);
});
`,
  );
  await writeFile(
    path.join(scratch, "vitest.consumer.config.mjs"),
    `import { defineBrowserTest } from "build-preset/vitest";
import { defineConfig } from "vitest/config";

const browserTest = defineBrowserTest({
  include: ["consumer.browser.test.ts"],
  includeThree: false,
});

export default defineConfig({
  optimizeDeps: browserTest.optimizeDeps,
  test: {
    include: browserTest.include,
    fileParallelism: browserTest.fileParallelism,
    browser: browserTest.browser,
    testTimeout: 15_000,
  },
});
`,
  );

  execFileSync(process.execPath, [path.join(scratch, "smoke.mjs")], {
    cwd: scratch,
    env: environment,
    stdio: "inherit",
  });
  pnpm(["exec", "tsc", "--project", "tsconfig.json"], scratch, environment);
  const cliOutput = pnpm(["exec", "build-preset", "init-android"], scratch, environment);
  if (!cliOutput.includes("versionCode") || !cliOutput.includes("bundleRelease")) {
    throw new Error("installed build-preset CLI omitted the Android version scaffold");
  }
  try {
    pnpm(["exec", "build-preset", "unknown-command"], scratch, environment);
    throw new Error("an unknown CLI command unexpectedly succeeded");
  } catch (error) {
    if (error?.status !== 1) throw error;
  }
  const builtAssets = await readdir(path.join(scratch, "dist/assets"));
  const builtSource = (
    await Promise.all(
      builtAssets
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(path.join(scratch, "dist/assets", name), "utf8")),
    )
  ).join("\n");
  if (!builtSource.includes("built-tar-consumer")) {
    throw new Error("installed tarball did not produce the expected Vite bundle");
  }
  if (runBrowser) {
    execFileSync(
      process.execPath,
      [path.join(packageRoot, "scripts/verify-build-preset-browser.mjs")],
      {
        cwd: packageRoot,
        env: {
          ...environment,
          BUILD_PRESET_BROWSER_CWD: scratch,
          BUILD_PRESET_BROWSER_CONFIG: "vitest.consumer.config.mjs",
        },
        stdio: "inherit",
      },
    );
  }

  process.stdout.write(
    `build-preset: clean consumer installed ${packageJson.name}@${installedPackageJson.version}, ` +
      `Vitest ${installedVitest}, Playwright ${installedPlaywright}, Vite ${installedVite}, ` +
      `${runBrowser ? "headed browser run" : "no browser run"}, tarball sha256 ${archiveSha256}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
