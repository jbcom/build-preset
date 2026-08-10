import { describe, expect, it, vi } from "vitest";
import type { RegistryPackageMetadata } from "../private-package-release/dependency-current.mjs";
import {
  createInstalledResolutionGraph,
  createRegistryMetadataReader,
  DependencyCurrentInfrastructureError,
  DependencyCurrentPolicyError,
  validateDependencyCurrentConfig,
  verifyDependencyCurrent,
} from "../private-package-release/dependency-current.mjs";

const toolchain = { packageManager: "absent", nodeEngine: "24.x" } as const;
const publicRegistry = { url: "https://registry.npmjs.org/", access: "anonymous" } as const;
const arcadeRegistry = {
  url: "https://registry.npmjs.org/",
  access: "anonymous",
} as const;

function publicConfig() {
  return validateDependencyCurrentConfig({
    profile: "arcade-cabinet/dependency-current-config/v1",
    configPath: "dependency-current.json",
    manifestPath: "package.json",
    policy: "public-runtime-closure",
    registries: { public: publicRegistry, scopes: {} },
    privateScopes: [],
    forbiddenScopes: ["@arcade-cabinet", "@jbcom"],
    rootPackages: [],
    baselines: {},
    requireInstalledSections: ["dependencies"],
    manifestToolchain: toolchain,
  });
}

function privateConfig(baselines: Record<string, string> = {}) {
  return validateDependencyCurrentConfig({
    profile: "arcade-cabinet/dependency-current-config/v1",
    configPath: "dependency-current.json",
    manifestPath: "package.json",
    policy: "private-scopes-and-roots",
    registries: {
      public: publicRegistry,
      scopes: { "@arcade-cabinet": arcadeRegistry },
    },
    privateScopes: ["@arcade-cabinet"],
    forbiddenScopes: ["@jbcom"],
    rootPackages: [],
    baselines,
    requireInstalledSections: ["dependencies"],
    manifestToolchain: toolchain,
  });
}

function installedGraph(entries: Record<string, Record<string, string>>) {
  return {
    rootIdentity: "producer@1.0.0",
    resolve(owner: string, name: string) {
      return entries[owner]?.[name] ?? null;
    },
  };
}

describe("dependency-current policy", () => {
  it("accepts only exact scoped wildcard root selectors", () => {
    const base = privateConfig();
    expect(
      validateDependencyCurrentConfig({ ...base, rootPackages: ["@rpgjs/*"] }).rootPackages,
    ).toEqual(["@rpgjs/*"]);
    for (const selection of [
      "pixi.js/*",
      "../escape/*",
      "https://evil.invalid/*",
      `@${"a".repeat(300)}/*`,
    ]) {
      expect(() => validateDependencyCurrentConfig({ ...base, rootPackages: [selection] })).toThrow(
        /wildcard|invalid dependency-current config/,
      );
    }
  });

  it("accepts npm-valid dot and underscore package names through npm-package-arg", () => {
    const candidate = privateConfig({ "legacy.name_ok": "1.0.0" });
    expect(candidate.baselines).toEqual({ "legacy.name_ok": "1.0.0" });
  });

  it("requires producer-owned direct declarations to select global latest", async () => {
    const metadata = {
      alpha: {
        "dist-tags": { latest: "2.0.0" },
        versions: { "1.0.0": { name: "alpha", version: "1.0.0" }, "2.0.0": {} },
      },
    };
    await expect(
      verifyDependencyCurrent({
        manifest: { name: "producer", version: "1.0.0", dependencies: { alpha: "1.0.0" } },
        config: publicConfig(),
        installedGraph: installedGraph({ "producer@1.0.0": { alpha: "1.0.0" } }),
        readMetadata: async (name: keyof typeof metadata) => metadata[name],
      }),
    ).rejects.toThrow(/latest is 2\.0\.0/);
  });

  it("uses a transitive upstream range's maximum compatible version and its frozen path", async () => {
    const metadata: Record<string, RegistryPackageMetadata> = {
      alpha: {
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": { name: "alpha", version: "1.0.0", dependencies: { beta: "^1.0.0" } },
        },
      },
      beta: {
        "dist-tags": { latest: "2.0.0" },
        versions: {
          "1.0.0": { name: "beta", version: "1.0.0" },
          "1.2.0": { name: "beta", version: "1.2.0" },
          "2.0.0": { name: "beta", version: "2.0.0" },
        },
      },
    };
    const manifest = { name: "producer", version: "1.0.0", dependencies: { alpha: "1.0.0" } };
    const graph = installedGraph({
      "producer@1.0.0": { alpha: "1.0.0" },
      "alpha@1.0.0": { beta: "1.2.0" },
    });
    const result = await verifyDependencyCurrent({
      manifest,
      config: publicConfig(),
      installedGraph: graph,
      readMetadata: async (name: string) => metadata[name],
    });
    expect(result.verified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "beta",
          selected: "1.2.0",
          latest: "2.0.0",
          installPath: "$>alpha@1.0.0>beta@1.2.0",
        }),
      ]),
    );
    await expect(
      verifyDependencyCurrent({
        manifest,
        config: publicConfig(),
        installedGraph: installedGraph({
          "producer@1.0.0": { alpha: "1.0.0" },
          "alpha@1.0.0": { beta: "1.0.0" },
        }),
        readMetadata: async (name: string) => metadata[name],
      }),
    ).rejects.toThrow(/frozen install resolves 1\.0\.0/);
  });

  it("rejects forbidden direct scopes even when they are not selected roots", async () => {
    await expect(
      verifyDependencyCurrent({
        manifest: {
          name: "producer",
          version: "1.0.0",
          devDependencies: { "@jbcom/secret": "1.0.0" },
        },
        config: publicConfig(),
        readMetadata: vi.fn(),
      }),
    ).rejects.toThrow(/direct forbidden dependency/);
  });

  it("traverses actually installed private optional peers and permits virtual baselines", async () => {
    const config = privateConfig({ rpgjs: "5.0.0" });
    const metadata: Record<string, RegistryPackageMetadata> = {
      "@arcade-cabinet/ai": {
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "@arcade-cabinet/ai",
            version: "1.0.0",
            peerDependencies: { yuka: "^0.7.0" },
            peerDependenciesMeta: { yuka: { optional: true } },
          },
        },
      },
      yuka: {
        "dist-tags": { latest: "0.7.7" },
        versions: { "0.7.7": { name: "yuka", version: "0.7.7" } },
      },
      rpgjs: {
        "dist-tags": { latest: "5.0.0" },
        versions: { "5.0.0": { name: "rpgjs", version: "5.0.0" } },
      },
    };
    const result = await verifyDependencyCurrent({
      manifest: {
        name: "producer",
        version: "1.0.0",
        dependencies: { "@arcade-cabinet/ai": "1.0.0" },
      },
      config,
      installedGraph: installedGraph({
        "producer@1.0.0": { "@arcade-cabinet/ai": "1.0.0" },
        "@arcade-cabinet/ai@1.0.0": { yuka: "0.7.7" },
      }),
      readMetadata: async (name: string) => metadata[name],
    });
    expect(result.verified.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["@arcade-cabinet/ai", "yuka", "rpgjs"]),
    );
    expect(result.skipped).not.toContain(expect.stringContaining("yuka"));
  });

  it("requires public leaves beneath private packages to be globally latest", async () => {
    const metadata: Record<string, RegistryPackageMetadata> = {
      "@arcade-cabinet/ai": {
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "@arcade-cabinet/ai",
            version: "1.0.0",
            dependencies: { yuka: "0.7.6" },
          },
        },
      },
      yuka: {
        "dist-tags": { latest: "0.7.7" },
        versions: {
          "0.7.6": { name: "yuka", version: "0.7.6" },
          "0.7.7": { name: "yuka", version: "0.7.7" },
        },
      },
    };
    await expect(
      verifyDependencyCurrent({
        manifest: {
          name: "producer",
          version: "1.0.0",
          dependencies: { "@arcade-cabinet/ai": "1.0.0" },
        },
        config: privateConfig(),
        installedGraph: installedGraph({
          "producer@1.0.0": { "@arcade-cabinet/ai": "1.0.0" },
          "@arcade-cabinet/ai@1.0.0": { yuka: "0.7.6" },
        }),
        readMetadata: async (name: string) => metadata[name],
      }),
    ).rejects.toThrow(/latest is 0\.7\.7/);
  });

  it("rejects conflicting installed resolutions for one exact owner identity", () => {
    expect(() =>
      createInstalledResolutionGraph([
        {
          name: "producer",
          version: "1.0.0",
          dependencies: {
            alpha: {
              version: "1.0.0",
              dependencies: { beta: { version: "1.0.0" } },
            },
            duplicate: {
              version: "1.0.0",
              dependencies: {
                alpha: {
                  version: "1.0.0",
                  dependencies: { beta: { version: "1.1.0" } },
                },
              },
            },
          },
        },
      ]),
    ).toThrow(/conflicting installed versions/);
  });

  it("terminates cycles and emits the same ordered evidence for shuffled manifests", async () => {
    const metadata: Record<string, RegistryPackageMetadata> = {
      alpha: {
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "alpha",
            version: "1.0.0",
            dependencies: { beta: "1.0.0" },
          },
        },
      },
      beta: {
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "beta",
            version: "1.0.0",
            dependencies: { alpha: "1.0.0" },
          },
        },
      },
    };
    const graph = installedGraph({
      "producer@1.0.0": { alpha: "1.0.0", beta: "1.0.0" },
      "alpha@1.0.0": { beta: "1.0.0" },
      "beta@1.0.0": { alpha: "1.0.0" },
    });
    const run = (dependencies: Record<string, string>) =>
      verifyDependencyCurrent({
        manifest: { name: "producer", version: "1.0.0", dependencies },
        config: publicConfig(),
        installedGraph: graph,
        readMetadata: async (name: string) => metadata[name],
      });
    const left = await run({ beta: "1.0.0", alpha: "1.0.0" });
    const right = await run({ alpha: "1.0.0", beta: "1.0.0" });
    expect(left).toEqual(right);
    expect(left.packageCount).toBe(2);
  });

  it("fails before registry I/O when an adversarial graph exceeds the edge cap", async () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 32_769 }, (_, index) => [`package-${index}`, "1.0.0"]),
    );
    const readMetadata = vi.fn();
    await expect(
      verifyDependencyCurrent({
        manifest: { name: "producer", version: "1.0.0", dependencies },
        config: publicConfig(),
        installedGraph: installedGraph({}),
        readMetadata,
      }),
    ).rejects.toThrow(/exceeds 32768 edges/);
    expect(readMetadata).not.toHaveBeenCalled();
  });
});

describe("registry metadata ingress", () => {
  it("never sends a token to public or attacker-controlled routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: url.href, init });
      return new Response('{"dist-tags":{"latest":"1.0.0"},"versions":{}}', {
        headers: { "content-type": "application/json" },
      });
    });
    const reader = createRegistryMetadataReader({
      environment: { PRIVATE_NPM_TOKEN: "canary" },
      fetchImplementation: fetchImplementation as typeof fetch,
    });
    await reader("alpha", publicRegistry);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    await expect(
      reader("@jbcom/secret", {
        url: "https://attacker.invalid/api/packages/jbcom/npm/",
        access: "private-npm-token",
      }),
    ).rejects.toBeInstanceOf(DependencyCurrentPolicyError);
    await expect(reader("@arcade-cabinet/secret", publicRegistry)).rejects.toBeInstanceOf(
      DependencyCurrentPolicyError,
    );
    expect(calls).toHaveLength(1);
  });

  it("sends the fixed token only to the exact jbcom endpoint", async () => {
    const fetchImplementation = vi.fn(async (_url: URL, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer canary");
      expect(init.redirect).toBe("manual");
      return new Response('{"dist-tags":{"latest":"1.0.0"},"versions":{}}', {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    const reader = createRegistryMetadataReader({
      environment: { PRIVATE_NPM_TOKEN: "canary" },
      fetchImplementation: fetchImplementation as typeof fetch,
    });
    await reader("@jbcom/secret", {
      url: "https://registry.npmjs.org/",
      access: "private-npm-token",
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([
    ["redirect", new Response("", { status: 302, headers: { location: "https://evil.invalid" } })],
    ["authentication failure", new Response("", { status: 401 })],
    ["missing metadata", new Response("", { status: 404 })],
    ["content type", new Response("{}", { headers: { "content-type": "text/html" } })],
    [
      "oversize",
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "1024" },
      }),
    ],
  ])("fails closed on %s responses", async (_label, response) => {
    const reader = createRegistryMetadataReader({
      maxMetadataBytes: 16,
      fetchImplementation: (async () => response) as typeof fetch,
    });
    await expect(reader("alpha", publicRegistry)).rejects.toBeInstanceOf(
      DependencyCurrentInfrastructureError,
    );
  });

  it("aborts a stalled registry request", async () => {
    const reader = createRegistryMetadataReader({
      timeoutMs: 5,
      fetchImplementation: ((_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    });
    await expect(reader("alpha", publicRegistry)).rejects.toBeInstanceOf(
      DependencyCurrentInfrastructureError,
    );
  });
});
