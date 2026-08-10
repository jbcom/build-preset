#!/usr/bin/env node

import { appendFile, chmod, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import semver from "semver";
import { loadReleaseConfig, RECEIPT_PROFILE, runningVerifierIdentity } from "./config.mjs";
import { createGitClient } from "./fingerprint.mjs";
import { preparePrivatePackageRelease, publishPrivatePackageRelease } from "./orchestrator.mjs";
import {
  assertExactLocalSource,
  assertExactReleaseRuntime,
  assertVerifierDependencyBinding,
  createRuntimeClients,
  profilePackageAdmission,
} from "./runtime.mjs";
import { classifyRegistryState, classifyReleaseState, RELEASE_STATES } from "./state.mjs";

export function parseArguments(argv) {
  const [phase, ...rest] = argv;
  if (!["prepare", "publish", "profile-sbom"].includes(phase)) {
    throw new Error(
      "usage: build-preset package-release <prepare|publish|profile-sbom> --config <path> [options]",
    );
  }
  const allowed = new Set(
    phase === "prepare"
      ? ["--config", "--source", "--release-root", "--verification-root", "--receipt"]
      : phase === "publish"
        ? ["--config", "--receipt", "--release-root"]
        : ["--config", "--package", "--source"],
  );
  const options = { phase };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(key) || value === undefined) throw new Error(`invalid option ${key}`);
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (options[name] !== undefined) throw new Error(`duplicate option ${key}`);
    options[name] = value;
  }
  if (!options.config) throw new Error("--config is required");
  const required =
    phase === "prepare"
      ? ["source", "releaseRoot", "verificationRoot", "receipt"]
      : phase === "publish"
        ? ["receipt", "releaseRoot"]
        : ["source", "package"];
  for (const name of required) {
    if (!options[name]) {
      throw new Error(`--${name.replace(/[A-Z]/gu, "-$&").toLowerCase()} is required`);
    }
  }
  return options;
}

const RECEIPT_KEYS = [
  "config",
  "packages",
  "profile",
  "releaseRoot",
  "registry",
  "repository",
  "sourceSha",
  "verifier",
];
const CANDIDATE_KEYS = [
  "admission",
  "archiveName",
  "archivePath",
  "archiveSha256",
  "checksumName",
  "checksumPath",
  "checksumSha256",
  "configBlob",
  "distTagsBefore",
  "existingReleaseAssets",
  "generatedPaths",
  "id",
  "latestMode",
  "licenseBlob",
  "localAssets",
  "lockfileBlob",
  "missingReleaseAssets",
  "npmrcBlob",
  "packageDirectory",
  "packageName",
  "packageSourceSha256",
  "releaseDirectory",
  "releaseId",
  "releaseInputSha256",
  "rootManifestBlob",
  "sbomEvidence",
  "sbomName",
  "sbomPath",
  "sbomSha256",
  "sourceEpoch",
  "sourcePaths",
  "sourceSha",
  "state",
  "tagName",
  "tagTargetSha",
  "version",
  "versionsBefore",
  "workflowBlob",
  "workspaceBlob",
];
const SBOM_EVIDENCE_KEYS = [
  "componentCount",
  "componentIdentitySha256",
  "dependencyAdjacencySha256",
  "dependencyCount",
  "packageName",
  "rootRef",
  "sbomSha256",
  "serialNumber",
  "version",
];

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function equal(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function isHex(value, length) {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
}

function contained(root, target, { allowRoot = false } = {}) {
  const relative = path.relative(root, target);
  return (
    (allowRoot || relative !== "") &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function packageArchiveName(packageName, version) {
  return `${packageName.slice(1).replace("/", "-")}-${version}.tgz`;
}

export function validateReceipt(
  receipt,
  { config, loadedConfig, verifier, expectedReleaseRoot } = {},
) {
  if (
    !exactKeys(receipt, RECEIPT_KEYS) ||
    receipt.profile !== RECEIPT_PROFILE ||
    !isHex(receipt.sourceSha, 40) ||
    receipt.repository !== config.repository ||
    !equal(receipt.registry, config.registry) ||
    !exactKeys(receipt.config, ["gitBlob", "path", "sha256"]) ||
    receipt.config.path !== config.configPath ||
    receipt.config.sha256 !== loadedConfig.sha256 ||
    !isHex(receipt.config.gitBlob, 40) ||
    !equal(receipt.verifier, verifier) ||
    !path.isAbsolute(receipt.releaseRoot ?? "") ||
    !Array.isArray(receipt.packages) ||
    receipt.packages.length !== config.packages.length
  ) {
    throw new Error("invalid private-package release receipt");
  }
  const specs = new Map(config.packages.map((spec) => [spec.id, spec]));
  const seen = new Set();
  let releaseRoot;
  for (const candidate of receipt.packages) {
    const spec = specs.get(candidate.id);
    if (
      !exactKeys(candidate, CANDIDATE_KEYS) ||
      !spec ||
      seen.has(candidate.id) ||
      candidate.packageDirectory !== spec.directory ||
      candidate.packageName !== spec.name ||
      !equal(candidate.generatedPaths, spec.generatedPaths) ||
      !equal(candidate.sourcePaths, spec.sourcePaths) ||
      !equal(candidate.admission, spec.admission)
    ) {
      throw new Error(`unexpected package in release receipt: ${candidate.id ?? "<missing>"}`);
    }
    seen.add(candidate.id);
    const expectedSourceSha = candidate.tagTargetSha ?? receipt.sourceSha;
    const gitDigests = [
      candidate.lockfileBlob,
      candidate.licenseBlob,
      candidate.configBlob,
      candidate.workflowBlob,
      candidate.rootManifestBlob,
      candidate.workspaceBlob,
      candidate.npmrcBlob,
    ];
    if (
      !isHex(candidate.sourceSha, 40) ||
      candidate.sourceSha !== expectedSourceSha ||
      (candidate.tagTargetSha !== null && !isHex(candidate.tagTargetSha, 40)) ||
      (candidate.releaseId !== null &&
        (!Number.isSafeInteger(candidate.releaseId) || candidate.releaseId <= 0)) ||
      !/^\d+$/u.test(candidate.sourceEpoch ?? "") ||
      !gitDigests.every((value) => isHex(value, 40)) ||
      candidate.configBlob !== receipt.config.gitBlob ||
      !isHex(candidate.packageSourceSha256, 64) ||
      !isHex(candidate.releaseInputSha256, 64) ||
      !isHex(candidate.archiveSha256, 64) ||
      !isHex(candidate.sbomSha256, 64) ||
      !isHex(candidate.checksumSha256, 64)
    ) {
      throw new Error(`invalid provenance evidence for ${candidate.id}`);
    }
    if (
      !semver.valid(candidate.version) ||
      candidate.tagName !== `${spec.tagPrefix}${candidate.version}` ||
      candidate.archiveName !== packageArchiveName(spec.name, candidate.version) ||
      !path.isAbsolute(candidate.releaseDirectory ?? "") ||
      !path.isAbsolute(candidate.archivePath ?? "") ||
      candidate.archivePath !== path.join(candidate.releaseDirectory, candidate.archiveName) ||
      candidate.sbomName !== `${candidate.tagName}-sbom.cdx.json` ||
      candidate.checksumName !== `${candidate.tagName}-SHA256SUMS.txt` ||
      candidate.sbomPath !== path.join(candidate.releaseDirectory, candidate.sbomName) ||
      candidate.checksumPath !== path.join(candidate.releaseDirectory, candidate.checksumName)
    ) {
      throw new Error(`incomplete release receipt for ${candidate.id}`);
    }
    const candidateRoot = path.dirname(candidate.releaseDirectory);
    releaseRoot ??= candidateRoot;
    if (
      receipt.releaseRoot !== releaseRoot ||
      candidateRoot !== releaseRoot ||
      candidate.releaseDirectory !== path.join(releaseRoot, candidate.id) ||
      (expectedReleaseRoot && path.resolve(releaseRoot) !== path.resolve(expectedReleaseRoot))
    ) {
      throw new Error(`release directory escaped the expected root for ${candidate.id}`);
    }
    for (const value of [
      candidate.packageName,
      candidate.version,
      candidate.archivePath,
      candidate.archiveSha256,
    ]) {
      if (typeof value !== "string" || /[\r\n]/u.test(value)) {
        throw new Error(`unsafe action output in release receipt for ${candidate.id}`);
      }
    }
    const expectedNames = [
      candidate.archiveName,
      candidate.sbomName,
      candidate.checksumName,
    ].sort();
    if (
      !Array.isArray(candidate.localAssets) ||
      candidate.localAssets.length !== 3 ||
      !equal(candidate.localAssets.map(({ name }) => name).sort(), expectedNames) ||
      candidate.localAssets.some(
        ({ name, sha256 }) => path.basename(name) !== name || !isHex(sha256, 64),
      )
    ) {
      throw new Error(`invalid release asset evidence for ${candidate.id}`);
    }
    const digests = new Map(candidate.localAssets.map(({ name, sha256 }) => [name, sha256]));
    if (
      digests.get(candidate.archiveName) !== candidate.archiveSha256 ||
      digests.get(candidate.sbomName) !== candidate.sbomSha256 ||
      digests.get(candidate.checksumName) !== candidate.checksumSha256
    ) {
      throw new Error(`release asset digest mapping mismatch for ${candidate.id}`);
    }
    const existing = candidate.existingReleaseAssets;
    const missing = candidate.missingReleaseAssets;
    if (
      !Array.isArray(existing) ||
      !Array.isArray(missing) ||
      !equal([...existing, ...missing].sort(), expectedNames) ||
      new Set([...existing, ...missing]).size !== expectedNames.length
    ) {
      throw new Error(`invalid release asset retry partition for ${candidate.id}`);
    }
    let registry;
    try {
      registry = classifyRegistryState({
        candidateVersion: candidate.version,
        versions: candidate.versionsBefore,
        distTags: candidate.distTagsBefore,
      });
    } catch (error) {
      throw new Error(`invalid registry snapshot for ${candidate.id}: ${error.message}`);
    }
    const tag = candidate.tagTargetSha === null ? null : { targetSha: candidate.tagTargetSha };
    const release = candidate.releaseId === null ? null : { id: candidate.releaseId };
    if (
      registry.latestMode !== candidate.latestMode ||
      !Object.values(RELEASE_STATES).includes(candidate.state) ||
      classifyReleaseState({ registry, tag, release }) !== candidate.state
    ) {
      throw new Error(`release state mismatch for ${candidate.id}`);
    }
    if (
      (release === null && existing.length !== 0) ||
      !exactKeys(candidate.sbomEvidence, SBOM_EVIDENCE_KEYS) ||
      candidate.sbomEvidence.packageName !== candidate.packageName ||
      candidate.sbomEvidence.version !== candidate.version ||
      candidate.sbomEvidence.rootRef !== candidate.admission.rootPurl ||
      candidate.sbomEvidence.sbomSha256 !== candidate.sbomSha256 ||
      candidate.sbomEvidence.componentCount !== candidate.admission.componentCount ||
      candidate.sbomEvidence.dependencyCount !== candidate.admission.dependencyCount ||
      candidate.sbomEvidence.componentIdentitySha256 !==
        candidate.admission.componentIdentitySha256 ||
      candidate.sbomEvidence.dependencyAdjacencySha256 !==
        candidate.admission.dependencyAdjacencySha256 ||
      !/^urn:uuid:[0-9a-f-]{36}$/u.test(candidate.sbomEvidence.serialNumber ?? "")
    ) {
      throw new Error(`invalid SBOM evidence for ${candidate.id}`);
    }
  }
  if (expectedReleaseRoot && !contained(path.dirname(expectedReleaseRoot), releaseRoot)) {
    throw new Error("release root escaped its expected parent");
  }
  return receipt;
}

async function writeActionOutputs(receipt) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [];
  for (const candidate of receipt.packages) {
    const key = candidate.id.replaceAll("-", "_");
    lines.push(`${key}_name=${candidate.packageName}`);
    lines.push(`${key}_version=${candidate.version}`);
    lines.push(`${key}_archive=${candidate.archivePath}`);
    lines.push(`${key}_archive_sha=${candidate.archiveSha256}`);
  }
  lines.push(`release_root=${path.dirname(receipt.packages[0].releaseDirectory)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function gitBlobAtSource(workspaceRoot, sourceSha, configPath) {
  return createGitClient(workspaceRoot)("rev-parse", `${sourceSha}:${configPath}`);
}

export async function assertSafeOutputPaths(options, environment = process.env) {
  const paths = [options.receipt, options.releaseRoot, options.verificationRoot]
    .filter(Boolean)
    .map((value) => {
      if (/[\r\n]/u.test(value)) throw new Error("release output paths contain control lines");
      return path.resolve(value);
    });
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (
        paths[left] === paths[right] ||
        contained(paths[left], paths[right]) ||
        contained(paths[right], paths[left])
      ) {
        throw new Error("release output paths must be disjoint");
      }
    }
  }
  if (!environment.RUNNER_TEMP) return;
  const runnerRoot = await realpath(environment.RUNNER_TEMP);
  for (const output of paths) {
    if (!contained(runnerRoot, output)) {
      throw new Error(`release output escaped RUNNER_TEMP: ${output}`);
    }
    let probe = output;
    while (probe !== runnerRoot) {
      try {
        const resolved = await realpath(probe);
        if (!contained(runnerRoot, resolved, { allowRoot: true }) || resolved !== probe) {
          throw new Error(`release output traverses a symlink: ${output}`);
        }
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        probe = path.dirname(probe);
      }
    }
  }
}

export async function assertPublishReceiptPaths(receiptPath, receipt, expectedReleaseRoot) {
  const actualReceipt = await realpath(receiptPath);
  if (actualReceipt !== path.resolve(receiptPath)) {
    throw new Error("release receipt traverses a symlink");
  }
  const releaseRoot = await realpath(expectedReleaseRoot);
  if (releaseRoot !== path.resolve(expectedReleaseRoot) || receipt.releaseRoot !== releaseRoot) {
    throw new Error("release root traverses a symlink or differs from receipt");
  }
  for (const candidate of receipt.packages) {
    const releaseDirectory = await realpath(candidate.releaseDirectory);
    if (
      releaseDirectory !== candidate.releaseDirectory ||
      !contained(releaseRoot, releaseDirectory)
    ) {
      throw new Error(`release directory traverses a symlink for ${candidate.id}`);
    }
    for (const assetPath of [candidate.archivePath, candidate.sbomPath, candidate.checksumPath]) {
      const resolved = await realpath(assetPath);
      if (resolved !== assetPath || !contained(releaseDirectory, resolved)) {
        throw new Error(`release asset traverses a symlink for ${candidate.id}`);
      }
      const metadata = await stat(resolved);
      if (!metadata.isFile()) throw new Error(`release asset is not a file for ${candidate.id}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const workspaceRoot = await realpath(process.cwd());
  const loadedConfig = await loadReleaseConfig({
    workspaceRoot,
    configPath: options.config,
    requireAdmissions: options.phase !== "profile-sbom",
  });
  const verifier = await runningVerifierIdentity();
  const toolchain = await assertExactReleaseRuntime(workspaceRoot);
  await assertVerifierDependencyBinding({ workspaceRoot, verifier, toolchain });

  if (options.phase === "profile-sbom") {
    const spec = loadedConfig.config.packages.find(({ id }) => id === options.package);
    if (!spec) throw new Error(`unknown configured package: ${options.package}`);
    if (spec.admission !== null) {
      throw new Error("profile-sbom requires admission:null and never auto-accepts a profile");
    }
    await assertExactLocalSource(options.source, workspaceRoot);
    const admission = await profilePackageAdmission({
      workspaceRoot,
      sourceSha: options.source,
      spec,
      config: loadedConfig.config,
      toolchain,
    });
    process.stdout.write(`${canonicalize(admission)}\n`);
    return;
  }

  await assertSafeOutputPaths(options);
  let clients;
  try {
    if (options.phase === "prepare") {
      await assertExactLocalSource(options.source, workspaceRoot);
      const gitBlob = await gitBlobAtSource(
        workspaceRoot,
        options.source,
        loadedConfig.config.configPath,
      );
      clients = await createRuntimeClients({
        workspaceRoot,
        config: loadedConfig.config,
        toolchain,
      });
      const receipt = await preparePrivatePackageRelease({
        sourceSha: options.source,
        releaseRoot: path.resolve(options.releaseRoot),
        verificationRoot: path.resolve(options.verificationRoot),
        clients,
        config: loadedConfig.config,
        configEvidence: { gitBlob, sha256: loadedConfig.sha256 },
        verifier,
      });
      validateReceipt(receipt, {
        config: loadedConfig.config,
        loadedConfig,
        verifier,
        expectedReleaseRoot: path.resolve(options.releaseRoot),
      });
      const receiptPath = path.resolve(options.receipt);
      await writeFile(receiptPath, `${canonicalize(receipt)}\n`, { mode: 0o600 });
      await chmod(receiptPath, 0o600);
      await writeActionOutputs(receipt);
      for (const candidate of receipt.packages) {
        process.stdout.write(
          `${candidate.packageName}@${candidate.version}: ${candidate.state}, ` +
            `${candidate.archiveSha256}, ${candidate.sbomEvidence.componentCount} components\n`,
        );
      }
      return;
    }

    const receiptPath = path.resolve(options.receipt);
    const expectedReleaseRoot = path.resolve(options.releaseRoot);
    const receipt = validateReceipt(JSON.parse(await readFile(receiptPath, "utf8")), {
      config: loadedConfig.config,
      loadedConfig,
      verifier,
      expectedReleaseRoot,
    });
    await assertPublishReceiptPaths(receiptPath, receipt, expectedReleaseRoot);
    await assertExactLocalSource(receipt.sourceSha, workspaceRoot);
    const currentConfigBlob = await gitBlobAtSource(
      workspaceRoot,
      receipt.sourceSha,
      loadedConfig.config.configPath,
    );
    if (currentConfigBlob !== receipt.config.gitBlob) {
      throw new Error("committed release config changed after preflight");
    }
    clients = await createRuntimeClients({
      workspaceRoot,
      config: loadedConfig.config,
      toolchain,
    });
    await publishPrivatePackageRelease({
      receipt,
      clients,
      config: loadedConfig.config,
    });
    for (const candidate of receipt.packages) {
      process.stdout.write(
        `${candidate.packageName}@${candidate.version}: exact registry and Gitea release verified\n`,
      );
    }
  } finally {
    await clients?.cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
