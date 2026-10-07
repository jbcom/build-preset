import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  assertPublishReceiptPaths,
  assertSafeOutputPaths,
} from "../private-package-release/cli.mjs";
import { validateReleaseConfig } from "../private-package-release/config.mjs";
import { computeReleaseInput } from "../private-package-release/fingerprint.mjs";
import { preparePrivatePackageRelease } from "../private-package-release/orchestrator.mjs";
import {
  assertPackedFileSet,
  assertVerifierDependencyBinding,
  createRuntimeClients,
} from "../private-package-release/runtime.mjs";
import {
  classifyRegistryState,
  classifyReleaseState,
  RELEASE_STATES,
} from "../private-package-release/state.mjs";
import type { CommandRunner } from "../private-package-release/toolchain.mjs";

const registryUrl = "https://registry.npmjs.org/";
const config = {
  profile: "arcade-cabinet/private-package-release-config/v2",
  repository: "arcade-cabinet/example",
  configPath: "release.json",
  workflowPath: ".gitea/workflows/release.yml",
  mainBranch: "main" as const,
  releaseInputPaths: [],
  registry: { url: registryUrl, scope: "@arcade-cabinet" },
  packages: [
    {
      id: "example",
      directory: "packages/example",
      generatedPaths: ["packages/example/dist"],
      sourcePaths: ["packages/example"],
      name: "@arcade-cabinet/example",
      tagPrefix: "example-v",
      admission: {
        profile:
          "arcade-cabinet/pnpm-11.21.0/cyclonedx-1.7/lockfile-only-prod-no-peers-no-optional/v1",
        rootPurl: "pkg:npm/%40arcade-cabinet/example@1.0.0",
        componentCount: 1,
        dependencyCount: 1,
        componentIdentitySha256: "a".repeat(64),
        dependencyAdjacencySha256: "b".repeat(64),
      },
    },
  ],
};
const toolchain = {
  nodeExecutable: "/node",
  npmCli: "/npm",
  corepackCli: "/corepack",
  pnpmCli: "/pnpm",
};
const execute = promisify(execFile);

function responseJson(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runtime(
  options: {
    fetchImplementation?: typeof fetch;
    runCommand?: CommandRunner;
    environment?: Record<string, string>;
  } = {},
) {
  return createRuntimeClients({
    workspaceRoot: process.cwd(),
    config,
    toolchain,
    fetchImplementation: options.fetchImplementation ?? vi.fn(),
    runCommand: options.runCommand ?? (async () => ({ stdout: "", stderr: "" })),
    environment: {
      REGISTRY_URL: registryUrl,
      GITEA_SERVER_URL: "https://github.com/",
      GITEA_REPOSITORY: config.repository,
      GITEA_TOKEN: "gitea-canary",
      NPM_TOKEN: "npm-canary",
      ...options.environment,
    },
  });
}

async function buildWorkspace() {
  const workspaceRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "build-preset-hostile-build-")),
  );
  const packageDirectory = path.join(workspaceRoot, "package");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(workspaceRoot, ".gitignore"), "package/dist\n");
  await writeFile(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "@arcade-cabinet/example", scripts: { build: "fixture-build" } }),
  );
  await writeFile(path.join(packageDirectory, "README.md"), "bound source\n");
  await execute("git", ["init", "--quiet"], { cwd: workspaceRoot });
  await execute("git", ["add", "."], { cwd: workspaceRoot });
  await execute(
    "git",
    [
      "-c",
      "user.name=Build Preset Test",
      "-c",
      "user.email=build-preset@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: workspaceRoot },
  );
  return { workspaceRoot, packageDirectory };
}

function localReleaseConfig(generatedPaths = ["package/dist"]) {
  return {
    ...config,
    packages: [
      {
        ...config.packages[0],
        directory: "package",
        generatedPaths,
        sourcePaths: ["package"],
      },
    ],
  };
}

function buildRunner(onBuild: () => Promise<void> | void, npmCalls = vi.fn()) {
  return async (command: string, arguments_: string[], options: Record<string, unknown> = {}) => {
    if (command === "git") {
      return execute(command, arguments_, {
        ...options,
        encoding: options.encoding === null ? null : "utf8",
      });
    }
    if (arguments_[0] === toolchain.corepackCli) {
      return { stdout: "", stderr: "" };
    }
    if (arguments_[0] === toolchain.pnpmCli) {
      if (arguments_[1] === "--version") {
        return { stdout: "11.21.0\n", stderr: "" };
      }
      await onBuild();
      return { stdout: "", stderr: "" };
    }
    npmCalls(arguments_);
    return { stdout: "", stderr: "" };
  };
}

describe("release state contracts", () => {
  it("classifies all four idempotent states and rejects impossible state", () => {
    const unpublished = classifyRegistryState({
      candidateVersion: "2.0.0",
      versions: ["1.0.0"],
      distTags: { latest: "1.0.0" },
    });
    const published = classifyRegistryState({
      candidateVersion: "2.0.0",
      versions: ["1.0.0", "2.0.0"],
      distTags: { latest: "2.0.0" },
    });
    expect(classifyReleaseState({ registry: unpublished, tag: null, release: null })).toBe(
      RELEASE_STATES.NEW,
    );
    expect(classifyReleaseState({ registry: published, tag: null, release: null })).toBe(
      RELEASE_STATES.REGISTRY_ONLY,
    );
    expect(classifyReleaseState({ registry: published, tag: {}, release: null })).toBe(
      RELEASE_STATES.TAG_ONLY,
    );
    expect(classifyReleaseState({ registry: published, tag: {}, release: {} })).toBe(
      RELEASE_STATES.EXISTING,
    );
    expect(() => classifyReleaseState({ registry: unpublished, tag: {}, release: null })).toThrow(
      /conflicts/,
    );
  });

  it.each([
    ["private package", { private: true }],
    [
      "non-latest publish tag",
      { publishConfig: { registry: registryUrl, access: "restricted", tag: "next" } },
    ],
  ])("rejects %s before packing or mutation", async (_label, override) => {
    const pack = vi.fn();
    const clients = {
      remoteMain: async () => "1".repeat(40),
      manifest: async () => ({
        name: "@arcade-cabinet/example",
        version: "1.0.0",
        description: "Example",
        license: "UNLICENSED",
        repository: {
          url: "https://github.com/jbcom/example.git",
          directory: "packages/example",
        },
        publishConfig: { registry: registryUrl, access: "restricted" },
        ...override,
      }),
      pack,
    };
    await expect(
      preparePrivatePackageRelease({
        sourceSha: "1".repeat(40),
        releaseRoot: "/tmp/release",
        verificationRoot: "/tmp/verify",
        clients,
        config,
        configEvidence: { gitBlob: "2".repeat(40), sha256: "3".repeat(64) },
        verifier: {},
      }),
    ).rejects.toThrow(/manifest|publishConfig/);
    expect(pack).not.toHaveBeenCalled();
  });
});

describe("verifier dependency binding", () => {
  // The verifier is this package at its current version; the repository root binds it.
  const packageVersion = (
    JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as {
      version: string;
    }
  ).version;

  async function bindingFixture(installed: Record<string, unknown>) {
    const workspaceRoot = await realpath(path.resolve(import.meta.dirname, "../../.."));
    const packageRoot = await realpath(path.join(workspaceRoot, "packages/build-preset"));
    const projects = [
      {
        name: "@arcade-cabinet/build-preset",
        version: packageVersion,
        path: packageRoot,
      },
      {
        name: "build-preset-repository",
        version: "0.0.0",
        path: workspaceRoot,
        devDependencies: { "@arcade-cabinet/build-preset": installed },
      },
    ];
    return {
      packageRoot,
      workspaceRoot,
      verify: () =>
        assertVerifierDependencyBinding({
          workspaceRoot,
          verifier: { packageName: "@arcade-cabinet/build-preset", version: packageVersion },
          toolchain,
          runCommand: async () => ({ stdout: JSON.stringify(projects), stderr: "" }),
        }),
    };
  }

  it("rejects a root workspace range that is neither * nor the exact version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "verifier-range-"));
    try {
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          devDependencies: { "@arcade-cabinet/build-preset": `workspace:^${packageVersion}` },
        }),
      );
      await expect(
        assertVerifierDependencyBinding({
          workspaceRoot: root,
          verifier: { packageName: "@arcade-cabinet/build-preset", version: packageVersion },
          toolchain,
          runCommand: async () => {
            throw new Error("the spec check must refuse before pnpm runs");
          },
        }),
      ).rejects.toThrow(/does not exactly bind/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("authenticates pnpm's link entry through its exact package path and manifest", async () => {
    const workspaceRoot = await realpath(path.resolve(import.meta.dirname, "../../.."));
    const packageRoot = await realpath(path.join(workspaceRoot, "packages/build-preset"));
    // The repository root binds its own package as `workspace:*`; that spec must be accepted.
    const rootManifest = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(rootManifest.devDependencies["@arcade-cabinet/build-preset"]).toBe("workspace:*");
    const fixture = await bindingFixture({
      from: "@arcade-cabinet/build-preset",
      version: "link:packages/build-preset",
      path: packageRoot,
    });
    await expect(fixture.verify()).resolves.toBeUndefined();
  });

  it("rejects a linked verifier at the wrong package path", async () => {
    const workspaceRoot = await realpath(path.resolve(import.meta.dirname, "../../.."));
    const fixture = await bindingFixture({
      version: "link:packages/build-preset",
      path: workspaceRoot,
    });
    await expect(fixture.verify()).rejects.toThrow(/escapes the workspace|executing package root/);
  });

  it("rejects a same-version registry entry at a different package path", async () => {
    const workspaceRoot = await realpath(path.resolve(import.meta.dirname, "../../.."));
    const holder = await mkdtemp(path.join(workspaceRoot, "node_modules/verifier-path-"));
    try {
      await writeFile(
        path.join(holder, "package.json"),
        JSON.stringify({ name: "@arcade-cabinet/build-preset", version: packageVersion }),
      );
      const fixture = await bindingFixture({ version: packageVersion, path: holder });
      await expect(fixture.verify()).rejects.toThrow(/executing package root/);
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  });

  it("rejects a registry locator with the wrong version", async () => {
    const workspaceRoot = await realpath(path.resolve(import.meta.dirname, "../../.."));
    const packageRoot = await realpath(path.join(workspaceRoot, "packages/build-preset"));
    const fixture = await bindingFixture({ version: "0.2.0", path: packageRoot });
    await expect(fixture.verify()).rejects.toThrow(/installed verifier 0\.2\.0/);
  });

  it("rejects a verifier path that traverses a symlink", async () => {
    const workspaceRoot = await realpath(path.resolve(import.meta.dirname, "../../.."));
    const packageRoot = await realpath(path.join(workspaceRoot, "packages/build-preset"));
    const holder = await mkdtemp(path.join(workspaceRoot, "node_modules/verifier-symlink-"));
    const linkedPath = path.join(holder, "build-preset");
    try {
      await symlink(packageRoot, linkedPath, "dir");
      const fixture = await bindingFixture({
        version: "link:packages/build-preset",
        path: linkedPath,
      });
      await expect(fixture.verify()).rejects.toThrow(/traverses a symlink/);
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  });
});

describe("release filesystem boundary", () => {
  it("removes poisoned generated output and rejects a no-op build", async () => {
    const { workspaceRoot, packageDirectory } = await buildWorkspace();
    const poison = path.join(packageDirectory, "dist", "poisoned.js");
    await mkdir(path.dirname(poison), { recursive: true });
    await writeFile(poison, "export const poisoned = true;\n");
    const clients = await createRuntimeClients({
      workspaceRoot,
      config: localReleaseConfig(),
      toolchain,
      runCommand: buildRunner(() => {}),
      fetchImplementation: vi.fn(),
      environment: {
        REGISTRY_URL: registryUrl,
        GITEA_SERVER_URL: "https://github.com/",
        GITEA_REPOSITORY: config.repository,
        GITEA_TOKEN: "gitea-canary",
      },
    });
    await expect(clients.pack("package", path.join(workspaceRoot, "pack"))).rejects.toThrow(
      /did not recreate generated output/,
    );
    await expect(access(poison)).rejects.toThrow();
    await clients.cleanup();
  });

  it("rejects tracked generated targets before deleting them", async () => {
    const { workspaceRoot, packageDirectory } = await buildWorkspace();
    const manifestPath = path.join(packageDirectory, "package.json");
    const original = await readFile(manifestPath, "utf8");
    const clients = await createRuntimeClients({
      workspaceRoot,
      config: localReleaseConfig(["package/package.json"]),
      toolchain,
      runCommand: buildRunner(() => {}),
      fetchImplementation: vi.fn(),
      environment: {
        REGISTRY_URL: registryUrl,
        GITEA_SERVER_URL: "https://github.com/",
        GITEA_REPOSITORY: config.repository,
        GITEA_TOKEN: "gitea-canary",
      },
    });
    await expect(clients.pack("package", path.join(workspaceRoot, "pack"))).rejects.toThrow(
      /generated output contains tracked files/,
    );
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(original);
    await clients.cleanup();
  });

  it("rejects builds that rewrite tracked source before npm pack", async () => {
    const { workspaceRoot, packageDirectory } = await buildWorkspace();
    const npmCalls = vi.fn();
    const clients = await createRuntimeClients({
      workspaceRoot,
      config: localReleaseConfig(),
      toolchain,
      runCommand: buildRunner(async () => {
        await writeFile(path.join(packageDirectory, "README.md"), "rewritten by build\n");
        await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
        await writeFile(path.join(packageDirectory, "dist", "index.js"), "export {};\n");
      }, npmCalls),
      fetchImplementation: vi.fn(),
      environment: {
        REGISTRY_URL: registryUrl,
        GITEA_SERVER_URL: "https://github.com/",
        GITEA_REPOSITORY: config.repository,
        GITEA_TOKEN: "gitea-canary",
      },
    });
    await expect(clients.pack("package", path.join(workspaceRoot, "pack"))).rejects.toThrow(
      /tracked package source bytes changed during build/,
    );
    expect(npmCalls).not.toHaveBeenCalled();
    await clients.cleanup();
  });

  it("rejects a build that moves HEAD while leaving a clean worktree", async () => {
    const { workspaceRoot, packageDirectory } = await buildWorkspace();
    const npmCalls = vi.fn();
    const clients = await createRuntimeClients({
      workspaceRoot,
      config: localReleaseConfig(),
      toolchain,
      runCommand: buildRunner(async () => {
        await execute(
          "git",
          [
            "-c",
            "user.name=Build Preset Test",
            "-c",
            "user.email=build-preset@example.invalid",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "hostile source move",
          ],
          { cwd: workspaceRoot },
        );
        await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
        await writeFile(path.join(packageDirectory, "dist", "index.js"), "export {};\n");
      }, npmCalls),
      fetchImplementation: vi.fn(),
      environment: {
        REGISTRY_URL: registryUrl,
        GITEA_SERVER_URL: "https://github.com/",
        GITEA_REPOSITORY: config.repository,
        GITEA_TOKEN: "gitea-canary",
      },
    });
    await expect(clients.pack("package", path.join(workspaceRoot, "pack"))).rejects.toThrow(
      /changed the exact source HEAD/,
    );
    expect(npmCalls).not.toHaveBeenCalled();
    await clients.cleanup();
  });

  it("rejects noncanonical and VCS-control generated paths in configuration", () => {
    for (const generatedPath of [
      "packages/example/dist/.",
      "packages/example//dist",
      ".git/objects",
    ]) {
      const directory = generatedPath.startsWith(".git/") ? "." : "packages/example";
      expect(() =>
        validateReleaseConfig({
          ...config,
          packages: [{ ...config.packages[0], directory, generatedPaths: [generatedPath] }],
        }),
      ).toThrow(/canonical POSIX|safe strict descendants/);
    }
  });

  it("requires every release input, including LICENSE, to be a regular Git blob", async () => {
    const sourceSha = "1".repeat(40);
    const blob = "2".repeat(40);
    const git = vi.fn(async (...arguments_: string[]) => {
      if (arguments_[0] === "show") return "1234567890";
      if (arguments_[0] === "ls-tree" && arguments_.includes("-r")) {
        return `100644 blob ${blob}\tpackage/index.js`;
      }
      const file = arguments_.at(-1);
      return `${file === "LICENSE" ? "120000" : "100644"} blob ${blob}\t${file}`;
    });
    await expect(
      computeReleaseInput({
        sourceSha,
        packageDirectory: "package",
        sourcePaths: ["package"],
        configPath: "release.json",
        workflowPath: ".gitea/workflows/release.yml",
        git,
      }),
    ).rejects.toThrow(/tracked regular file: LICENSE/);
  });

  it("rejects an ignored packed file outside the exact generated roots", () => {
    expect(() =>
      assertPackedFileSet({
        packageDirectory: "packages/example",
        generatedPaths: ["packages/example/dist"],
        trackedFiles: ["packages/example/package.json"],
        packedFiles: [{ path: "package.json" }, { path: "dist/index.js" }, { path: "poison.js" }],
      }),
    ).toThrow(/unbound file: poison\.js/);
  });

  it("rejects nested output roots and prospective symlink traversal", async () => {
    const runner = await mkdtemp(path.join(tmpdir(), "build-preset-paths-"));
    await expect(
      assertSafeOutputPaths(
        {
          releaseRoot: path.join(runner, "release"),
          verificationRoot: path.join(runner, "release", "verify"),
          receipt: path.join(runner, "receipt.json"),
        },
        { RUNNER_TEMP: runner },
      ),
    ).rejects.toThrow(/disjoint/);

    const outside = await mkdtemp(path.join(tmpdir(), "build-preset-outside-"));
    await symlink(outside, path.join(runner, "link"));
    await expect(
      assertSafeOutputPaths(
        {
          releaseRoot: path.join(runner, "link", "release"),
          verificationRoot: path.join(runner, "verify"),
          receipt: path.join(runner, "receipt.json"),
        },
        { RUNNER_TEMP: runner },
      ),
    ).rejects.toThrow(/symlink|escaped/);
  });

  it("rejects a publish asset symlink even when every lexical path is inside the root", async () => {
    const runner = await mkdtemp(path.join(tmpdir(), "build-preset-publish-paths-"));
    const releaseRoot = path.join(runner, "release");
    const packageRoot = path.join(releaseRoot, "example");
    await mkdir(packageRoot, { recursive: true });
    const receiptPath = path.join(runner, "receipt.json");
    const outside = path.join(runner, "outside.tgz");
    await writeFile(receiptPath, "{}");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(packageRoot, "example.tgz"));
    await writeFile(path.join(packageRoot, "sbom.json"), "{}");
    await writeFile(path.join(packageRoot, "sums.txt"), "sum");
    await expect(
      assertPublishReceiptPaths(
        receiptPath,
        {
          releaseRoot: await realpath(releaseRoot),
          packages: [
            {
              id: "example",
              releaseDirectory: packageRoot,
              archivePath: path.join(packageRoot, "example.tgz"),
              sbomPath: path.join(packageRoot, "sbom.json"),
              checksumPath: path.join(packageRoot, "sums.txt"),
            },
          ],
        },
        releaseRoot,
      ),
    ).rejects.toThrow(/symlink/);
  });
});

describe("credential and immutable tag boundaries", () => {
  it("rejects a mismatched release creation response before asset upload can begin", async () => {
    const fetchImplementation = vi.fn(async () =>
      responseJson({
        id: 9,
        tag_name: "wrong-tag",
        target_commitish: "1".repeat(40),
        name: "Expected",
        body: "Expected body",
        draft: false,
        prerelease: false,
        assets: [],
      }),
    );
    const clients = await runtime({ fetchImplementation: fetchImplementation as typeof fetch });
    await expect(
      clients.createRelease({
        tagName: "example-v1.0.0",
        targetSha: "1".repeat(40),
        name: "Expected",
        body: "Expected body",
        draft: false,
        prerelease: false,
      }),
    ).rejects.toThrow(/created release response mismatch|release body mismatch/);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    await clients.cleanup();
  });

  it.each([
    ["nonpositive id", { id: 0 }],
    ["wrong target", { target_commitish: "2".repeat(40) }],
    ["wrong metadata", { body: "Unexpected body" }],
  ])("rejects a created release with %s", async (_label, override) => {
    const fetchImplementation = vi.fn(async () =>
      responseJson({
        id: 9,
        tag_name: "example-v1.0.0",
        target_commitish: "1".repeat(40),
        name: "Expected",
        body: "Expected body",
        draft: false,
        prerelease: false,
        assets: [],
        ...override,
      }),
    );
    const clients = await runtime({ fetchImplementation: fetchImplementation as typeof fetch });
    await expect(
      clients.createRelease({
        tagName: "example-v1.0.0",
        targetSha: "1".repeat(40),
        name: "Expected",
        body: "Expected body",
        draft: false,
        prerelease: false,
      }),
    ).rejects.toThrow(/created release response mismatch|release body mismatch/);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    await clients.cleanup();
  });

  it("accepts an exact release response only after its tag resolves to the requested source", async () => {
    const targetSha = "1".repeat(40);
    const releasePayload = {
      id: 9,
      tag_name: "example-v1.0.0",
      target_commitish: targetSha,
      name: "Expected",
      body: "Expected body",
      draft: false,
      prerelease: false,
      assets: [],
    };
    const fetchImplementation = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/releases")) {
        return responseJson(releasePayload);
      }
      return responseJson({
        ref: "refs/tags/example-v1.0.0",
        object: { type: "commit", sha: targetSha },
      });
    });
    const clients = await runtime({ fetchImplementation: fetchImplementation as typeof fetch });
    await expect(
      clients.createRelease({
        tagName: "example-v1.0.0",
        targetSha,
        name: "Expected",
        body: "Expected body",
        draft: false,
        prerelease: false,
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 9, tagName: "example-v1.0.0" }));
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    await clients.cleanup();
  });

  it("rejects a positive create response ID that differs from the persisted tagged release", async () => {
    const targetSha = "1".repeat(40);
    const releasePayload = {
      tag_name: "example-v1.0.0",
      target_commitish: targetSha,
      name: "Expected",
      body: "Expected body",
      draft: false,
      prerelease: false,
      assets: [],
    };
    const fetchImplementation = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/releases")) return responseJson({ id: 9, ...releasePayload });
      if (href.includes("/git/refs/tags/")) {
        return responseJson({
          ref: "refs/tags/example-v1.0.0",
          object: { type: "commit", sha: targetSha },
        });
      }
      return responseJson({ id: 10, ...releasePayload });
    });
    const clients = await runtime({ fetchImplementation: fetchImplementation as typeof fetch });
    await expect(
      clients.createRelease({
        tagName: "example-v1.0.0",
        targetSha,
        name: "Expected",
        body: "Expected body",
        draft: false,
        prerelease: false,
      }),
    ).rejects.toThrow(/persisted ID mismatch/);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    await clients.cleanup();
  });

  it("rejects an exact release response when the created tag resolves elsewhere", async () => {
    const targetSha = "1".repeat(40);
    const fetchImplementation = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/releases")) {
        return responseJson({
          id: 9,
          tag_name: "example-v1.0.0",
          target_commitish: targetSha,
          name: "Expected",
          body: "Expected body",
          draft: false,
          prerelease: false,
          assets: [],
        });
      }
      return responseJson({
        ref: "refs/tags/example-v1.0.0",
        object: { type: "commit", sha: "2".repeat(40) },
      });
    });
    const clients = await runtime({ fetchImplementation: fetchImplementation as typeof fetch });
    await expect(
      clients.createRelease({
        tagName: "example-v1.0.0",
        targetSha,
        name: "Expected",
        body: "Expected body",
        draft: false,
        prerelease: false,
      }),
    ).rejects.toThrow(/did not resolve to its requested source/);
    await clients.cleanup();
  });

  it("rejects a different Gitea origin before sending the token", async () => {
    const fetchImplementation = vi.fn();
    await expect(
      runtime({
        fetchImplementation: fetchImplementation as typeof fetch,
        environment: { GITEA_SERVER_URL: "https://attacker.invalid/" },
      }),
    ).rejects.toThrow(/registry origin/);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("requires the exact requested tag ref and a final commit", async () => {
    const prefixFetch = vi.fn(async () =>
      responseJson([
        { ref: "refs/tags/example-v1.0.0-prefix", object: { type: "commit", sha: "1".repeat(40) } },
      ]),
    );
    const prefixClients = await runtime({ fetchImplementation: prefixFetch as typeof fetch });
    await expect(prefixClients.giteaTag("example-v1.0.0")).rejects.toThrow(/exact tag ref/);
    await prefixClients.cleanup();

    const fetchImplementation = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/git/refs/tags/")) {
        return responseJson({
          ref: "refs/tags/example-v1.0.0",
          object: { type: "tag", sha: "a".repeat(40) },
        });
      }
      if (href.endsWith(`/git/tags/${"a".repeat(40)}`)) {
        return responseJson({ object: { type: "tag", sha: "b".repeat(40) } });
      }
      return responseJson({ object: { type: "commit", sha: "c".repeat(40) } });
    });
    const clients = await runtime({ fetchImplementation: fetchImplementation as typeof fetch });
    await expect(clients.giteaTag("example-v1.0.0")).resolves.toEqual({
      targetSha: "c".repeat(40),
    });
    await clients.cleanup();
  });

  it("publishes the immutable tarball explicitly as latest without scripts", async () => {
    const calls: Array<string[]> = [];
    const clients = await runtime({
      runCommand: async (_command, arguments_) => {
        calls.push(arguments_);
        return { stdout: "", stderr: "" };
      },
    });
    await clients.publishArchive("/tmp/example.tgz");
    const publish = calls.find((arguments_) => arguments_.includes("publish"));
    expect(publish).toEqual(expect.arrayContaining(["--tag", "latest", "--ignore-scripts"]));
    await clients.cleanup();
  });
});
