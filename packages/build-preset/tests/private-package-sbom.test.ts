import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PrivatePackageReleaseConfig,
  SbomAdmission,
} from "../private-package-release/config.mjs";
import { normalizeAndValidatePnpmSbom } from "../private-package-release/sbom.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const pnpmCli = path.join(
  path.dirname(path.dirname(process.execPath)),
  "lib/node_modules/corepack/dist/pnpm.js",
);
// The committed admission is the one the release gate enforces; testing a copy would let the two
// drift apart silently.
const releaseConfig = JSON.parse(
  await readFile(path.join(packageRoot, "private-package-release.json"), "utf8"),
) as PrivatePackageReleaseConfig;
const committedAdmission = releaseConfig.packages.find(
  ({ id }) => id === "build-preset",
)?.admission;
if (!committedAdmission) throw new Error("build-preset has no committed SBOM admission");
const admission: SbomAdmission = committedAdmission;
const { version } = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
  version: string;
};

async function rawSbom() {
  if (!existsSync(pnpmCli)) throw new Error("exact Corepack pnpm CLI is unavailable");
  const root = await mkdtemp(path.join(tmpdir(), "build-preset-raw-sbom-"));
  const output = path.join(root, "raw.cdx.json");
  execFileSync(
    process.execPath,
    [
      pnpmCli,
      "--filter",
      "@arcade-cabinet/build-preset",
      "--fail-if-no-match",
      "sbom",
      "--sbom-format",
      "cyclonedx",
      "--sbom-spec-version",
      "1.7",
      "--lockfile-only",
      "--prod",
      "--exclude-peers",
      "--no-optional",
      "--out",
      output,
    ],
    { cwd: workspaceRoot, stdio: "pipe" },
  );
  return output;
}

async function normalize(inputPath: string, forbiddenValues: string[] = []) {
  return normalizeAndValidatePnpmSbom({
    inputPath,
    sourceSha: "1".repeat(40),
    sourceEpoch: "1",
    packageDirectory: packageRoot,
    workspaceRoot,
    registryUrl,
    admission,
    lockfileBlob: "2".repeat(40),
    packageSourceSha256: "3".repeat(64),
    releaseInputSha256: "4".repeat(64),
    archives: [
      {
        name: `arcade-cabinet-build-preset-${version}.tgz`,
        sha256: "5".repeat(64),
      },
    ],
    forbiddenValues,
  });
}

const registryUrl = "https://registry.npmjs.org/";

describe("private package SBOM admission", () => {
  it("accepts the committed exact graph and explicit UNLICENSED identity", async () => {
    const output = await rawSbom();
    const evidence = await normalize(output);
    expect(evidence).toMatchObject({
      packageName: "@arcade-cabinet/build-preset",
      version,
      rootRef: admission.rootPurl,
      componentCount: admission.componentCount,
      dependencyCount: admission.dependencyCount,
      componentIdentitySha256: admission.componentIdentitySha256,
      dependencyAdjacencySha256: admission.dependencyAdjacencySha256,
    });
    const normalized = JSON.parse(await readFile(output, "utf8"));
    expect(normalized.metadata.component.licenses).toEqual([{ license: { name: "UNLICENSED" } }]);
  });

  it("rejects extra root metadata instead of silently normalizing it away", async () => {
    const output = await rawSbom();
    const document = JSON.parse(await readFile(output, "utf8"));
    document.metadata.component.externalReferences.push({
      type: "website",
      url: "https://attacker.invalid/",
    });
    await writeFile(output, JSON.stringify(document));
    await expect(normalize(output)).rejects.toThrow(/root identity/);
  });

  it("rejects credential canaries anywhere in native pnpm evidence", async () => {
    const output = await rawSbom();
    const document = JSON.parse(await readFile(output, "utf8"));
    document.metadata.component.description = "credential-canary";
    await writeFile(output, JSON.stringify(document));
    await expect(normalize(output, ["credential-canary"])).rejects.toThrow(
      /forbidden environment\/canary value/,
    );
  });
});
