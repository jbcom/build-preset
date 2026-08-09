import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAnonymousNpmConfig,
  createAnonymousEnvironment,
} from "../scripts/anonymous-environment.mjs";
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

  it("removes token and auth variables and pins both npm config layers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-preset-anonymous-env-"));
    const userConfig = path.join(root, "anonymous.npmrc");
    writeFileSync(userConfig, "@arcade-cabinet:registry=https://registry.invalid/npm/\n");
    const environment = createAnonymousEnvironment({
      home: path.join(root, "home"),
      userConfig,
      baseEnv: {
        PATH: process.env.PATH,
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
      },
    });
    expect(environment.PATH).toBe(process.env.PATH);
    expect(environment.HOME).toBe(path.join(root, "home"));
    expect(environment).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("GITEA_TOKEN");
    expect(environment).not.toHaveProperty("GITEA_SERVER_URL");
    expect(environment).not.toHaveProperty("npm_config_//registry.invalid/:_authToken");
    expect(environment).not.toHaveProperty("npm_config_registry");
    expect(environment.npm_config_userconfig).toBe(userConfig);
    expect(readFileSync(environment.NPM_CONFIG_GLOBALCONFIG, "utf8")).not.toMatch(/auth|token/i);
  });

  it("rejects authentication material in the claimed anonymous npm config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-preset-auth-config-"));
    const userConfig = path.join(root, "not-anonymous.npmrc");
    writeFileSync(userConfig, "//registry.invalid/:_authToken=secret\n");
    expect(() => assertAnonymousNpmConfig(userConfig)).toThrow(/authentication material/);
  });

  it("keeps publish and release planning bound to exact anonymous evidence", () => {
    const publish = readFileSync(
      path.join(repositoryRoot, ".gitea/workflows/publish-build-preset.yml"),
      "utf8",
    );
    const release = readFileSync(path.join(repositoryRoot, ".gitea/workflows/release.yml"), "utf8");
    expect(publish).toContain("anonymous-environment.mjs");
    expect(publish).toContain("remoteNames");
    expect(publish).toContain("remoteSha !== localSha");
    expect(publish).toContain('cd "$BUILD_PRESET_PACKAGE_DIR"');
    expect(release).toContain("registryArchiveSha");
    expect(release).toContain("release asset set mismatch");
    expect(release).toContain("package version mismatch at tag");
    expect(release).toContain("assertCommitAncestor");
    expect(release).toContain("assertCycloneDxPackageIdentity");
    expect(release).toContain("assertExactChecksums");
  });

  it("pins Linux workflow jobs so macOS host labels cannot claim them", () => {
    for (const workflow of ["ci.yml", "cd.yml", "release.yml", "publish-build-preset.yml"]) {
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
