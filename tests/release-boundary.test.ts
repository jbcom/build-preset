import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAnonymousNpmConfig,
  createAnonymousEnvironment,
} from "../private-package-release/anonymous-environment.mjs";
import {
  EXACT_PNPM_VERSION,
  prepareAnonymousCorepackEnvironment,
} from "../private-package-release/corepack-environment.mjs";
import { resolveExactToolchain } from "../private-package-release/toolchain.mjs";
import {
  assertCommitAncestor,
  assertCycloneDxPackageIdentity,
  assertExactChecksums,
} from "../scripts/release-attestation.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

describe("release boundary", () => {
  it("keeps the source package and release manifest on the same publish version", () => {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, ".release-please-manifest.json"), "utf8"),
    );
    expect(manifest["packages/build-preset"]).toBe(packageJson.version);
  });

  it("executes the installed TypeScript compiler without npx network fallback", () => {
    const source = readFileSync(path.join(packageRoot, "scripts/build.mjs"), "utf8");
    expect(source).toContain('require.resolve("typescript/package.json")');
    expect(source).toContain('path.join(typescriptRoot, "bin/tsc")');
    expect(source).toContain("execFileSync(process.execPath, [typescriptCli");
    expect(source).not.toMatch(/execFileSync\(["']npx["']/);
  });

  it("removes package auth variables, preserves X11 authority, and pins npm config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-preset-anonymous-env-"));
    const userConfig = path.join(root, "anonymous.npmrc");
    writeFileSync(userConfig, "@arcade-cabinet:registry=https://registry.invalid/npm/\n");
    const environment = createAnonymousEnvironment({
      home: path.join(root, "home"),
      userConfig,
      baseEnv: {
        PATH: process.env.PATH,
        DISPLAY: ":99",
        XAUTHORITY: "/tmp/xvfb-authority",
        HOME: "/credentialed/home",
        NODE_AUTH_TOKEN: "secret",
        NPM_TOKEN: "secret",
        NPM_TOKEN: "secret",
        GITEA_TOKEN: "secret",
        GITEA_SERVER_URL: "https://credentialed.invalid",
        "npm_config_//registry.invalid/:_authToken": "secret",
        npm_config_registry: "https://credentialed.invalid/npm/",
        npm_config_userconfig: "/credentialed/user.npmrc",
        NPM_CONFIG_GLOBALCONFIG: "/credentialed/global.npmrc",
        COREPACK_HOME: "/credentialed/corepack",
        COREPACK_NPM_TOKEN: "secret",
        COREPACK_INTEGRITY_KEYS: "0",
        XDG_CACHE_HOME: "/credentialed/cache",
        PNPM_HOME: "/credentialed/pnpm",
      },
    });
    expect(environment.PATH).toBe(process.env.PATH);
    expect(environment.DISPLAY).toBe(":99");
    expect(environment.XAUTHORITY).toBe("/tmp/xvfb-authority");
    expect(environment.HOME).toBe(path.join(root, "home"));
    expect(environment).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("GITEA_TOKEN");
    expect(environment).not.toHaveProperty("GITEA_SERVER_URL");
    expect(environment).not.toHaveProperty("npm_config_//registry.invalid/:_authToken");
    expect(environment).not.toHaveProperty("npm_config_registry");
    expect(environment).not.toHaveProperty("COREPACK_NPM_TOKEN");
    expect(environment).not.toHaveProperty("COREPACK_INTEGRITY_KEYS");
    expect(environment.COREPACK_HOME).toBe(path.join(root, "home/.cache/node/corepack"));
    expect(environment.COREPACK_ENABLE_NETWORK).toBe("0");
    expect(environment.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
    expect(environment.COREPACK_ENV_FILE).toBe("0");
    expect(environment.COREPACK_ENABLE_PROJECT_SPEC).toBe("0");
    expect(environment.XDG_CACHE_HOME).toBe(path.join(root, "home/.cache"));
    expect(environment).not.toHaveProperty("PNPM_HOME");
    expect(environment.npm_config_userconfig).toBe(userConfig);
    expect(readFileSync(environment.NPM_CONFIG_GLOBALCONFIG, "utf8")).not.toMatch(/auth|token/i);
  });

  it("exports exact pnpm into a fresh verifier-owned Corepack cache and runs offline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-preset-corepack-offline-"));
    const userConfig = path.join(root, "anonymous.npmrc");
    const home = path.join(root, "anonymous-home");
    writeFileSync(userConfig, "@arcade-cabinet:registry=https://registry.invalid/npm/\n");
    const toolchain = await resolveExactToolchain();
    const unprepared = createAnonymousEnvironment({ home, userConfig });
    expect(() =>
      execFileSync(process.execPath, [toolchain.pnpmCli, "--version"], {
        cwd: repositoryRoot,
        env: unprepared,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();

    const environment = await prepareAnonymousCorepackEnvironment({
      home,
      userConfig,
      toolchain,
    });
    expect(environment.HOME).toBe(home);
    expect(environment.HOME).not.toBe(process.env.HOME);
    expect(environment.COREPACK_HOME).toBe(path.join(home, ".cache/node/corepack"));
    expect(environment.COREPACK_ENABLE_NETWORK).toBe("0");
    expect(
      execFileSync(process.execPath, [toolchain.pnpmCli, "--version"], {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    ).toBe(EXACT_PNPM_VERSION);
    const lastKnownGood = JSON.parse(
      readFileSync(path.join(environment.COREPACK_HOME, "lastKnownGood.json"), "utf8"),
    );
    expect(lastKnownGood).toEqual({ pnpm: EXACT_PNPM_VERSION });
  }, 30_000);

  it("rejects authentication material in the claimed anonymous npm config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-preset-auth-config-"));
    const userConfig = path.join(root, "not-anonymous.npmrc");
    writeFileSync(userConfig, "//registry.invalid/:_authToken=secret\n");
    expect(() => assertAnonymousNpmConfig(userConfig)).toThrow(/authentication material/);
  });

  it("keeps publish and release planning bound to exact anonymous evidence", () => {
    const publish = readFileSync(path.join(repositoryRoot, ".gitea/workflows/publish.yml"), "utf8");
    const ci = readFileSync(path.join(repositoryRoot, ".gitea/workflows/ci.yml"), "utf8");
    const release = readFileSync(path.join(repositoryRoot, ".gitea/workflows/release.yml"), "utf8");
    expect(publish).toContain("dependency-current.json");
    expect(publish).toContain("private-package-release.json");
    expect(publish).toContain("packageManifest.version !== releaseManifest");
    expect(publish).toContain("/branches/main");
    expect(publish).toMatch(/permissions:\s*\n\s+contents: write\s*\n\s+actions: read/);
    expect(publish.match(/GITEA_SERVER_URL:\s*\$\{\{ github\.server_url \}\}/g)).toHaveLength(1);
    expect(
      publish.match(
        /export GITEA_SERVER_URL="\$\{REGISTRY_URL%\/api\/packages\/arcade-cabinet\/npm\/\}"/g,
      ),
    ).toHaveLength(2);
    expect(publish).not.toContain("git fetch origin main");
    expect(publish).toMatch(
      /BUILD_PRESET_CONSUMER_SOURCE:\s+\$\{\{ steps\.package\.outputs\.build_preset_version \}\}/,
    );
    expect(publish).not.toMatch(/BUILD_PRESET_CONSUMER_SOURCE:.*outputs\.name.*@/);
    expect(ci).toContain("Fresh anonymous build-preset headed consumer");
    expect(ci).toMatch(/BUILD_PRESET_RUN_BROWSER:\s+["']1["']/);
    expect(ci).toContain(
      "xvfb-run -a pnpm --filter @arcade-cabinet/build-preset run smoke:tarball",
    );
    expect(release).toContain("registryArchiveSha");
    expect(release).toContain("release asset set mismatch");
    expect(release).toContain("package version mismatch at tag");
    expect(release).toContain("assertCommitAncestor");
    expect(release).toContain("assertCycloneDxPackageIdentity");
    expect(release).toContain("assertExactChecksums");
    // The registry answers `@scope%2Fname` and 404s `%40scope%2Fname`: every package URL the
    // gate builds must use npm's spelling.
    expect(release).toContain("encodeURIComponent(packageName).replace(/^%40/u, '@')");
    expect(release).not.toMatch(/encodeURIComponent\(packageName\)(?!\.replace)/);
    expect(publish).not.toMatch(/(?:^|\s)\+\s+--(?:config|source|receipt)/m);
  });

  it("pins Linux workflow jobs so macOS host labels cannot claim them", () => {
    for (const workflow of ["ci.yml", "release.yml", "publish.yml"]) {
      const source = readFileSync(path.join(repositoryRoot, ".gitea/workflows", workflow), "utf8");
      expect(source).not.toContain("runs-on: ubuntu-latest");
      expect(source).toContain("runs-on: ubuntu-24.04");
    }
  });

  it("requires the release tag commit to be reachable from current Gitea main", async () => {
    const ancestorSha = "a".repeat(40);
    const mergeParentSha = "b".repeat(40);
    const headSha = "c".repeat(40);
    const divergentSha = "d".repeat(40);
    const graph = new Map([
      [headSha, [mergeParentSha, divergentSha]],
      [mergeParentSha, [ancestorSha]],
      [divergentSha, []],
      [ancestorSha, []],
    ]);
    const loadCommit = async (sha: string) => ({
      sha,
      parents: (graph.get(sha) ?? []).map((parent) => ({ sha: parent })),
    });

    await expect(
      assertCommitAncestor({ ancestorSha, headSha, loadCommit }),
    ).resolves.toBeUndefined();
    await expect(
      assertCommitAncestor({ ancestorSha: "e".repeat(40), headSha, loadCommit }),
    ).rejects.toThrow(/not an ancestor of current Gitea main/);
  });

  it("rejects duplicate or extra checksum names and verifies exact release bytes", () => {
    const assets = new Map([
      ["archive.tgz", Buffer.from("archive")],
      ["sbom.json", Buffer.from("sbom")],
    ]);
    const line = (name: string) =>
      `${createHash("sha256")
        .update(assets.get(name) ?? "")
        .digest("hex")}  ${name}`;
    const expectedAssets = [...assets.keys()];
    expect(() =>
      assertExactChecksums({
        contents: `${line("archive.tgz")}\n${line("sbom.json")}\n`,
        expectedAssets,
        assets,
      }),
    ).not.toThrow();
    expect(() =>
      assertExactChecksums({
        contents: `${line("archive.tgz")}\n${line("archive.tgz")}\n${line("sbom.json")}\n`,
        expectedAssets,
        assets,
      }),
    ).toThrow(/duplicate checksum asset/);
    expect(() =>
      assertExactChecksums({
        contents: `${line("archive.tgz")}\n${line("sbom.json")}\n${line("extra.txt")}\n`,
        expectedAssets,
        assets,
      }),
    ).toThrow(/checksum asset set mismatch/);
  });

  it("binds the CycloneDX root component to the package name and version", () => {
    const identity = {
      packageName: "@arcade-cabinet/build-preset",
      version: "0.2.0",
    };
    const sbom = {
      bomFormat: "CycloneDX",
      metadata: {
        component: {
          group: "@arcade-cabinet",
          name: "build-preset",
          version: "0.2.0",
          purl: "pkg:npm/%40arcade-cabinet/build-preset@0.2.0",
        },
      },
    };
    expect(() => assertCycloneDxPackageIdentity(sbom, identity)).not.toThrow();
    expect(() =>
      assertCycloneDxPackageIdentity(
        {
          ...sbom,
          metadata: { component: { ...sbom.metadata.component, version: "latest" } },
        },
        identity,
      ),
    ).toThrow(/CycloneDX component mismatch/);
    expect(() =>
      assertCycloneDxPackageIdentity(
        {
          ...sbom,
          metadata: { component: { ...sbom.metadata.component, name: "wrong-package" } },
        },
        identity,
      ),
    ).toThrow(/CycloneDX component mismatch/);
  });
});
