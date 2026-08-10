#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnonymousEnvironment } from "../private-package-release/anonymous-environment.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, "../..");
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const pnpmCli = process.env.npm_execpath;
const requestedSource = process.env.BUILD_PRESET_CONSUMER_SOURCE;
const runBrowser = process.env.BUILD_PRESET_RUN_BROWSER === "1";

if (!pnpmCli) {
  throw new Error("consumer smoke must run through pnpm so npm_execpath identifies the pinned CLI");
}

function pnpm(args, cwd, env = process.env) {
  const javascriptCli = /\.[cm]?js$/i.test(pnpmCli);
  return execFileSync(
    javascriptCli ? process.execPath : pnpmCli,
    javascriptCli ? [pnpmCli, ...args] : args,
    {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

const scratch = await mkdtemp(path.join(tmpdir(), "build-preset-consumer-"));

try {
  let packageSource = requestedSource;
  let archiveSha256 = "registry-source";
  if (!packageSource) {
    pnpm(["pack", "--pack-destination", scratch], packageRoot);
    const archiveName = (await readdir(scratch)).find((name) => name.endsWith(".tgz"));
    if (!archiveName) throw new Error("pnpm pack did not create a tarball");
    const archive = path.join(scratch, archiveName);
    archiveSha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    packageSource = `file:${archive}`;
  }

  await writeFile(path.join(scratch, "pnpm-workspace.yaml"), 'packages:\n  - "."\n');
  await writeFile(
    path.join(scratch, ".npmrc"),
    "@arcade-cabinet:registry=https://registry.npmjs.org/\n",
  );
  const anonymousEnvironment = createAnonymousEnvironment({
    home: path.join(scratch, "anonymous-home"),
    userConfig: path.join(scratch, ".npmrc"),
  });
  if (runBrowser && !anonymousEnvironment.PLAYWRIGHT_BROWSERS_PATH) {
    const originalHome = process.env.HOME;
    if (!originalHome) throw new Error("browser smoke requires the original HOME for its cache");
    anonymousEnvironment.PLAYWRIGHT_BROWSERS_PATH =
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
          "@arcade-cabinet/build-preset": packageSource,
          "@types/node": "24.13.3",
          "@vitest/browser-playwright": "4.1.10",
          playwright: "1.62.1",
          typescript: "7.0.2",
          vite: "8.2.1",
          vitest: "4.1.10",
        },
      },
      null,
      2,
    )}\n`,
  );
  pnpm(
    ["install", "--prefer-offline", "--ignore-scripts", "--frozen-lockfile=false"],
    scratch,
    anonymousEnvironment,
  );

  const installedPackageRoot = path.join(
    scratch,
    "node_modules",
    "@arcade-cabinet",
    "build-preset",
  );
  const installedEntries = new Set(await readdir(installedPackageRoot));
  for (const required of [
    "dist",
    "private-package-release",
    "README.md",
    "CHANGELOG.md",
    "package.json",
  ]) {
    if (!installedEntries.has(required)) throw new Error(`packed artifact omitted ${required}`);
  }
  for (const forbidden of ["src", "scripts", "tests"]) {
    if (installedEntries.has(forbidden)) throw new Error(`packed artifact leaked ${forbidden}/`);
  }
  const installedPackageJson = JSON.parse(
    await readFile(path.join(installedPackageRoot, "package.json"), "utf8"),
  );
  if (installedPackageJson.version !== packageJson.version) {
    throw new Error(
      `clean consumer resolved build preset ${installedPackageJson.version}; expected ${packageJson.version}`,
    );
  }
  if (installedPackageJson.peerDependencies?.playwright !== ">=1.62.1 <2") {
    throw new Error("packed artifact has an inaccurate Playwright peer range");
  }
  const installedPlaywrightJson = JSON.parse(
    await readFile(path.join(scratch, "node_modules", "playwright", "package.json"), "utf8"),
  );
  if (installedPlaywrightJson.version !== "1.62.1") {
    throw new Error(`clean consumer resolved Playwright ${installedPlaywrightJson.version}`);
  }
  const installedNodeTypesJson = JSON.parse(
    await readFile(path.join(scratch, "node_modules", "@types", "node", "package.json"), "utf8"),
  );
  if (installedNodeTypesJson.version !== "24.13.3") {
    throw new Error(`clean consumer resolved Node types ${installedNodeTypesJson.version}`);
  }
  const installedViteJson = JSON.parse(
    await readFile(path.join(scratch, "node_modules", "vite", "package.json"), "utf8"),
  );
  if (installedViteJson.version !== "8.2.1") {
    throw new Error(`clean consumer resolved Vite ${installedViteJson.version}`);
  }

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
    `import { createRequire } from "node:module";
import path from "node:path";
import { build } from "vite";
import * as rootPreset from "@arcade-cabinet/build-preset";
import * as capacitorPreset from "@arcade-cabinet/build-preset/capacitor";
import {
  validateReleaseConfig,
  RELEASE_STATES,
} from "@arcade-cabinet/build-preset/private-package-release";
import {
  validateDependencyCurrentConfig,
  DependencyCurrentPolicyError,
} from "@arcade-cabinet/build-preset/dependency-current";
import { defineGamePreset } from "@arcade-cabinet/build-preset/vite";
import { defineUnitTest } from "@arcade-cabinet/build-preset/vitest";

const require = createRequire(import.meta.url);
const cjsRoot = require("@arcade-cabinet/build-preset");
const cjsVite = require("@arcade-cabinet/build-preset/vite");
if (typeof rootPreset.defineGamePreset !== "function") throw new Error("ESM root export missing");
if (typeof cjsRoot.defineBrowserTest !== "function") throw new Error("CJS root export missing");
if (typeof cjsVite.defineGamePreset !== "function") throw new Error("CJS Vite export missing");
if (defineUnitTest({ environment: "node" }).environment !== "node") {
  throw new Error("unit-test export failed");
}
const browserPreset = rootPreset.defineBrowserTest({ includeThree: false });
const browserArgs = browserPreset.browser.provider.options.launchOptions?.args ?? [];
if (!browserArgs.includes("--mute-audio")) throw new Error("provider mute argument missing");
if (browserPreset.browser.headless !== false) throw new Error("browser preset was not headed");
if ("launchArgs" in browserPreset) throw new Error("detached launch arguments remained public");
if ("androidReleaseWorkflowSnippet" in capacitorPreset) {
  throw new Error("unsafe Android release workflow API remained in the tarball");
}
if (capacitorPreset.defineCapacitorPreset({ appId: "com.jbcom.fixture", appName: "Fixture" }).webDir !== "dist") {
  throw new Error("Capacitor export failed");
}
if (RELEASE_STATES.NEW !== "NEW") throw new Error("release state export failed");
if (new DependencyCurrentPolicyError("fixture").exitCode !== 2) {
  throw new Error("dependency-current policy export failed");
}
const releaseConfig = validateReleaseConfig({
  profile: "arcade-cabinet/private-package-release-config/v2",
  repository: "arcade-cabinet/fixture",
  configPath: "release.json",
  workflowPath: ".gitea/workflows/release.yml",
  mainBranch: "main",
  releaseInputPaths: [],
  registry: {
    url: "https://registry.npmjs.org/",
    scope: "@arcade-cabinet",
  },
  packages: [{
    id: "fixture",
    directory: "packages/fixture",
    generatedPaths: ["packages/fixture/dist"],
    sourcePaths: ["packages/fixture"],
    name: "@arcade-cabinet/fixture",
    tagPrefix: "fixture-v",
    admission: null,
  }],
}, { requireAdmissions: false });
if (releaseConfig.packages[0].id !== "fixture") throw new Error("release config export failed");
const currentConfig = validateDependencyCurrentConfig({
  profile: "arcade-cabinet/dependency-current-config/v1",
  configPath: "dependency-current.json",
  manifestPath: "package.json",
  policy: "public-runtime-closure",
  registries: {
    public: { url: "https://registry.npmjs.org/", access: "anonymous" },
    scopes: {},
  },
  privateScopes: [],
  forbiddenScopes: ["@arcade-cabinet", "@jbcom"],
  rootPackages: [],
  baselines: {},
  requireInstalledSections: ["dependencies"],
  manifestToolchain: { packageManager: "absent", nodeEngine: "24.x" },
});
if (currentConfig.policy !== "public-runtime-closure") {
  throw new Error("dependency-current config export failed");
}

await build(
  defineGamePreset({
    appName: "fixture",
    srcDir: path.resolve("src"),
    overrides: { root: process.cwd(), logLevel: "silent" },
  }),
);
`,
  );

  await writeFile(
    path.join(scratch, "smoke.ts"),
    `import { defineBrowserTest, defineGamePreset } from "@arcade-cabinet/build-preset";
import type { ReleaseReceipt } from "@arcade-cabinet/build-preset/private-package-release";
import { RELEASE_STATES } from "@arcade-cabinet/build-preset/private-package-release";
import type { DependencyCurrentConfig, VerifiedDependencyEdge } from "@arcade-cabinet/build-preset/dependency-current";
import { DependencyCurrentInfrastructureError } from "@arcade-cabinet/build-preset/dependency-current";

const browser = defineBrowserTest({ includeThree: false });
const args: readonly string[] = browser.browser.provider.options.launchOptions?.args ?? [];
if (!args.includes("--mute-audio")) throw new Error("typed provider mute contract missing");

defineGamePreset({
  appName: "typed-fixture",
  srcDir: new URL("./src", import.meta.url).pathname,
});
const receipt = null as ReleaseReceipt | null;
const current = null as DependencyCurrentConfig | null;
const edge = null as VerifiedDependencyEdge | null;
void receipt;
void current;
void edge;
if (RELEASE_STATES.NEW !== "NEW") throw new Error("typed release export missing");
if (new DependencyCurrentInfrastructureError("fixture").exitCode !== 3) {
  throw new Error("typed dependency-current export missing");
}
`,
  );
  await writeFile(
    path.join(scratch, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2024",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2024", "DOM", "DOM.Iterable", "ESNext.Disposable"],
          types: ["node"],
          strict: true,
          noEmit: true,
        },
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
    `import { defineBrowserTest } from "@arcade-cabinet/build-preset";
import { defineConfig } from "vitest/config";

const browserTest = defineBrowserTest({
  include: ["consumer.browser.test.ts"],
  includeThree: false,
});

export default defineConfig({
  optimizeDeps: browserTest.optimizeDeps,
  test: {
    include: browserTest.include,
    browser: browserTest.browser,
    testTimeout: 15_000,
  },
});
`,
  );

  execFileSync(process.execPath, [path.join(scratch, "smoke.mjs")], {
    cwd: scratch,
    env: anonymousEnvironment,
    stdio: "inherit",
  });
  pnpm(["exec", "tsc", "--project", "tsconfig.json"], scratch, anonymousEnvironment);
  const cliOutput = pnpm(["exec", "build-preset", "init-android"], scratch, anonymousEnvironment);
  if (!cliOutput.includes("versionCode") || !cliOutput.includes("bundleRelease")) {
    throw new Error("installed build-preset CLI omitted the Android version scaffold");
  }
  for (const arguments_ of [["dependency-current"], ["package-release"]]) {
    try {
      pnpm(["exec", "build-preset", ...arguments_], scratch, anonymousEnvironment);
      throw new Error(`${arguments_[0]} invalid invocation unexpectedly succeeded`);
    } catch (error) {
      const expectedStatus = arguments_[0] === "dependency-current" ? 2 : 1;
      if (error?.status !== expectedStatus) {
        throw new Error(
          `${arguments_[0]} CLI dispatch exited ${error?.status}, expected ${expectedStatus}`,
        );
      }
    }
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
      [path.join(repositoryRoot, "scripts/verify-build-preset-browser.mjs")],
      {
        cwd: repositoryRoot,
        env: {
          ...anonymousEnvironment,
          BUILD_PRESET_BROWSER_CWD: scratch,
          BUILD_PRESET_BROWSER_CONFIG: "vitest.consumer.config.mjs",
        },
        stdio: "inherit",
      },
    );
  }

  process.stdout.write(
    `build-preset: clean consumer installed ${packageJson.name}@${packageJson.version}, ` +
      `Playwright ${installedPlaywrightJson.version}, Vite ${installedViteJson.version}, ` +
      `tarball sha256 ${archiveSha256}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
