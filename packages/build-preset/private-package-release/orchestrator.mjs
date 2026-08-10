import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import canonicalize from "canonicalize";
import semver from "semver";
import { assertSafeHttpsUrl, RECEIPT_PROFILE } from "./config.mjs";
import {
  assertCreatedRelease,
  assertDistTagsAfter,
  assertReleaseMetadata,
  classifyRegistryState,
  classifyReleaseState,
  expectedReleaseMetadata,
  normalizeRegistrySnapshot,
  stateRequiresRegistryPublish,
  stateRequiresReleaseCreation,
} from "./state.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function equal(left, right) {
  return canonicalize(left) === canonicalize(right);
}

function assertSameBytes(left, right, label) {
  if (!left.equals(right)) throw new Error(`${label} bytes are not reproducible`);
}

function repositoryRecord(repository) {
  if (typeof repository === "string") return { url: repository };
  if (!repository || typeof repository !== "object") return {};
  return { url: repository.url, directory: repository.directory };
}

function assertManifestContract(manifest, spec, config) {
  if (
    manifest?.name !== spec.name ||
    !semver.valid(manifest?.version) ||
    typeof manifest?.description !== "string" ||
    typeof manifest?.license !== "string"
  ) {
    throw new Error(`manifest identity mismatch for ${spec.id}`);
  }
  const repository = repositoryRecord(manifest.repository);
  const repositoryUrl = assertSafeHttpsUrl(repository.url, `${spec.name} repository URL`);
  const registryUrl = assertSafeHttpsUrl(
    manifest.publishConfig?.registry,
    `${spec.name} publish registry`,
  );
  const expectedRepositoryPath = `/${config.repository}.git`;
  const publishConfigKeys = Object.keys(manifest.publishConfig ?? {}).sort();
  if (
    manifest.private === true ||
    !equal(publishConfigKeys, ["access", "registry"]) ||
    repositoryUrl.origin !== new URL(config.registry.url).origin ||
    repositoryUrl.pathname !== expectedRepositoryPath ||
    registryUrl.href !== config.registry.url ||
    manifest.publishConfig?.access !== "restricted"
  ) {
    throw new Error(`manifest repository/publishConfig mismatch for ${spec.name}`);
  }
  if (
    (spec.directory === "." && repository.directory !== undefined) ||
    (spec.directory !== "." && repository.directory !== spec.directory)
  ) {
    throw new Error(`manifest repository.directory mismatch for ${spec.name}`);
  }
}

function releaseAssetNames(candidate) {
  return [candidate.archiveName, candidate.sbomName, candidate.checksumName].sort();
}

async function assertExistingRelease(
  candidate,
  release,
  clients,
  { requireComplete = false } = {},
) {
  const expectedNames = releaseAssetNames(candidate);
  if (!release) return { existingAssetNames: [], missingAssetNames: expectedNames };
  assertReleaseMetadata(release, expectedReleaseMetadata(candidate));
  const actualNames = release.assets.map((asset) => asset.name).sort();
  if (new Set(actualNames).size !== actualNames.length) {
    throw new Error(`duplicate release asset for ${candidate.packageName}@${candidate.version}`);
  }
  const unexpectedNames = actualNames.filter((name) => !expectedNames.includes(name));
  if (unexpectedNames.length > 0) {
    throw new Error(
      `unexpected release assets for ${candidate.packageName}@${candidate.version}: ${unexpectedNames.join(", ")}`,
    );
  }
  const missingAssetNames = expectedNames.filter((name) => !actualNames.includes(name));
  if (requireComplete && missingAssetNames.length > 0) {
    throw new Error(
      `release asset set incomplete for ${candidate.packageName}@${candidate.version}: ${missingAssetNames.join(", ")}`,
    );
  }
  for (const asset of release.assets) {
    if (Number(asset.size) <= 0) throw new Error(`release asset ${asset.name} is empty`);
    const remoteBytes = await clients.giteaAssetBytes(asset);
    const localBytes = await readFile(path.join(candidate.releaseDirectory, asset.name));
    assertSameBytes(remoteBytes, localBytes, `release asset ${asset.name}`);
  }
  return { existingAssetNames: actualNames, missingAssetNames };
}

function assertChecksum(candidate, checksumBytes, archiveBytes, sbomBytes) {
  const expected = [
    `${sha256(archiveBytes)}  ${candidate.archiveName}`,
    `${sha256(sbomBytes)}  ${candidate.sbomName}`,
    "",
  ].join("\n");
  if (checksumBytes.toString("utf8") !== expected) {
    throw new Error(
      `checksum manifest for ${candidate.packageName} is not the exact two-entry form`,
    );
  }
}

async function buildCandidate({ spec, config, sourceSha, releaseRoot, verificationRoot, clients }) {
  const releaseDirectory = path.join(releaseRoot, spec.id);
  const verificationDirectory = path.join(verificationRoot, spec.id);
  await mkdir(releaseDirectory, { recursive: true });
  await mkdir(verificationDirectory, { recursive: true });

  const manifest = await clients.manifest(spec.directory);
  assertManifestContract(manifest, spec, config);
  const firstPack = await clients.pack(spec.directory, releaseDirectory);
  const secondPack = await clients.pack(spec.directory, verificationDirectory);
  if (firstPack.name !== secondPack.name)
    throw new Error(`archive name drift for ${manifest.name}`);
  assertSameBytes(firstPack.bytes, secondPack.bytes, `${manifest.name} npm pack`);
  const archivePath = path.join(releaseDirectory, firstPack.name);
  await writeFile(archivePath, firstPack.bytes);

  const registrySnapshot = await clients.registryInspect(manifest.name);
  const registry = classifyRegistryState({
    candidateVersion: manifest.version,
    versions: registrySnapshot.versions,
    distTags: registrySnapshot.distTags,
  });
  const tagName = `${spec.tagPrefix}${manifest.version}`;
  const tag = await clients.giteaTag(tagName);
  const release = await clients.giteaRelease(tagName);
  const state = classifyReleaseState({ registry, tag, release });
  if (registry.versionExists) {
    const registryArchive = await clients.registryArchive(manifest.name, manifest.version);
    assertSameBytes(
      registryArchive,
      firstPack.bytes,
      `${manifest.name}@${manifest.version} registry`,
    );
  }

  const currentInput = await clients.releaseInput(sourceSha, spec, config);
  let releaseInput = currentInput;
  if (tag) {
    if (!(await clients.isAncestor(tag.targetSha, sourceSha))) {
      throw new Error(`${tagName} target is not an ancestor of current main`);
    }
    releaseInput = await clients.releaseInput(tag.targetSha, spec, config);
    if (releaseInput.packageSourceSha256 !== currentInput.packageSourceSha256) {
      throw new Error(`${tagName} package source changed after immutable publication`);
    }
    if (releaseInput.releaseInputSha256 !== currentInput.releaseInputSha256) {
      throw new Error(`${tagName} release-input fingerprint changed after publication`);
    }
  }

  return {
    id: spec.id,
    packageDirectory: spec.directory,
    generatedPaths: spec.generatedPaths,
    sourcePaths: spec.sourcePaths,
    admission: spec.admission,
    packageName: manifest.name,
    version: manifest.version,
    tagName,
    state,
    latestMode: registry.latestMode,
    distTagsBefore: registry.distTags,
    versionsBefore: registry.versions,
    sourceSha: releaseInput.sourceSha,
    sourceEpoch: releaseInput.sourceEpoch,
    packageSourceSha256: releaseInput.packageSourceSha256,
    licenseBlob: releaseInput.licenseBlob,
    lockfileBlob: releaseInput.lockfileBlob,
    configBlob: releaseInput.configBlob,
    workflowBlob: releaseInput.workflowBlob,
    rootManifestBlob: releaseInput.rootManifestBlob,
    workspaceBlob: releaseInput.workspaceBlob,
    npmrcBlob: releaseInput.npmrcBlob,
    releaseInputSha256: releaseInput.releaseInputSha256,
    archiveName: firstPack.name,
    archivePath,
    archiveSha256: sha256(firstPack.bytes),
    releaseDirectory,
    verificationDirectory,
    release,
    tag,
    registryUrl: config.registry.url,
  };
}

async function attestCandidate(candidate, clients) {
  candidate.sbomName = `${candidate.tagName}-sbom.cdx.json`;
  candidate.checksumName = `${candidate.tagName}-SHA256SUMS.txt`;
  const sbomPath = path.join(candidate.releaseDirectory, candidate.sbomName);
  const verificationSbomPath = path.join(candidate.verificationDirectory, candidate.sbomName);
  const archives = [{ name: candidate.archiveName, sha256: candidate.archiveSha256 }];
  const sbomInput = { ...candidate, archives };
  candidate.sbomEvidence = await clients.generateSbom(sbomInput, sbomPath);
  const verificationEvidence = await clients.generateSbom(sbomInput, verificationSbomPath);
  if (!equal(candidate.sbomEvidence, verificationEvidence)) {
    throw new Error(`SBOM evidence drift for ${candidate.packageName}`);
  }
  const sbomBytes = await readFile(sbomPath);
  const verificationSbomBytes = await readFile(verificationSbomPath);
  assertSameBytes(sbomBytes, verificationSbomBytes, `${candidate.packageName} SBOM`);

  const archiveBytes = await readFile(candidate.archivePath);
  const checksum = Buffer.from(
    [
      `${candidate.archiveSha256}  ${candidate.archiveName}`,
      `${sha256(sbomBytes)}  ${candidate.sbomName}`,
      "",
    ].join("\n"),
  );
  const checksumPath = path.join(candidate.releaseDirectory, candidate.checksumName);
  const verificationChecksumPath = path.join(
    candidate.verificationDirectory,
    candidate.checksumName,
  );
  await writeFile(checksumPath, checksum);
  await writeFile(verificationChecksumPath, checksum);
  assertChecksum(candidate, checksum, archiveBytes, sbomBytes);

  candidate.sbomPath = sbomPath;
  candidate.sbomSha256 = sha256(sbomBytes);
  candidate.checksumPath = checksumPath;
  candidate.checksumSha256 = sha256(checksum);
  candidate.localAssets = [
    { name: candidate.archiveName, sha256: candidate.archiveSha256 },
    { name: candidate.sbomName, sha256: candidate.sbomSha256 },
    { name: candidate.checksumName, sha256: candidate.checksumSha256 },
  ].sort((left, right) => left.name.localeCompare(right.name));
  const releaseAssets = await assertExistingRelease(candidate, candidate.release, clients);
  candidate.existingReleaseAssets = releaseAssets.existingAssetNames;
  candidate.missingReleaseAssets = releaseAssets.missingAssetNames;
}

function receiptCandidate(candidate) {
  const { release, tag, verificationDirectory, registryUrl, ...receipt } = candidate;
  return {
    ...receipt,
    releaseId: release?.id ?? null,
    tagTargetSha: tag?.targetSha ?? null,
  };
}

export async function preparePrivatePackageRelease({
  sourceSha,
  releaseRoot,
  verificationRoot,
  clients,
  config,
  configEvidence,
  verifier,
}) {
  if ((await clients.remoteMain()) !== sourceSha) {
    throw new Error("requested source is not exact main");
  }
  const candidates = [];
  for (const spec of config.packages) {
    candidates.push(
      await buildCandidate({
        spec,
        config,
        sourceSha,
        releaseRoot,
        verificationRoot,
        clients,
      }),
    );
  }
  for (const candidate of candidates) await attestCandidate(candidate, clients);
  if (candidates.some((candidate) => candidate.configBlob !== configEvidence.gitBlob)) {
    throw new Error("loaded config does not match the exact source config blob");
  }
  return {
    profile: RECEIPT_PROFILE,
    releaseRoot,
    sourceSha,
    repository: config.repository,
    registry: config.registry,
    config: {
      path: config.configPath,
      gitBlob: configEvidence.gitBlob,
      sha256: configEvidence.sha256,
    },
    verifier,
    packages: candidates
      .map(receiptCandidate)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function revalidatePrivatePackageRelease({ receipt, clients, config }) {
  const specs = new Map(config.packages.map((spec) => [spec.id, spec]));
  if (receipt.packages.length !== specs.size)
    throw new Error("release receipt package count drift");
  for (const candidate of receipt.packages) {
    const spec = specs.get(candidate.id);
    if (
      !spec ||
      candidate.packageName !== spec.name ||
      candidate.packageDirectory !== spec.directory ||
      candidate.tagName !== `${spec.tagPrefix}${candidate.version}` ||
      !equal(candidate.generatedPaths, spec.generatedPaths) ||
      !equal(candidate.sourcePaths, spec.sourcePaths) ||
      !equal(candidate.admission, spec.admission)
    ) {
      throw new Error(`release receipt/config mismatch for ${candidate.id}`);
    }
    const localInput = await clients.releaseInput(receipt.sourceSha, spec, config);
    if (
      localInput.packageSourceSha256 !== candidate.packageSourceSha256 ||
      localInput.releaseInputSha256 !== candidate.releaseInputSha256 ||
      localInput.licenseBlob !== candidate.licenseBlob ||
      localInput.configBlob !== candidate.configBlob ||
      localInput.workflowBlob !== candidate.workflowBlob
    ) {
      throw new Error(`${candidate.packageName} release inputs changed after preflight`);
    }
    const registrySnapshot = normalizeRegistrySnapshot(
      await clients.registryInspect(candidate.packageName),
    );
    if (
      !equal(registrySnapshot.versions, candidate.versionsBefore) ||
      !equal(registrySnapshot.distTags, candidate.distTagsBefore)
    ) {
      throw new Error(`${candidate.packageName} registry state changed after preflight`);
    }
    const tag = await clients.giteaTag(candidate.tagName);
    const release = await clients.giteaRelease(candidate.tagName);
    if ((tag?.targetSha ?? null) !== candidate.tagTargetSha) {
      throw new Error(`${candidate.tagName} changed after preflight`);
    }
    if ((release?.id ?? null) !== candidate.releaseId) {
      throw new Error(`${candidate.tagName} release changed after preflight`);
    }
    const releaseAssets = await assertExistingRelease(candidate, release, clients);
    if (!equal(releaseAssets.existingAssetNames, candidate.existingReleaseAssets)) {
      throw new Error(`${candidate.tagName} release assets changed after preflight`);
    }
    for (const asset of candidate.localAssets) {
      const bytes = await readFile(path.join(candidate.releaseDirectory, asset.name));
      if (sha256(bytes) !== asset.sha256) throw new Error(`local asset ${asset.name} changed`);
    }
  }
  if ((await clients.remoteMain()) !== receipt.sourceSha) {
    throw new Error("main moved after read-only package preflight");
  }
}

export async function publishPrivatePackageRelease({ receipt, clients, config }) {
  await revalidatePrivatePackageRelease({ receipt, clients, config });
  for (const candidate of receipt.packages) {
    if (!stateRequiresRegistryPublish(candidate.state)) continue;
    const snapshot = await clients.registryInspect(candidate.packageName);
    if (snapshot.versions.includes(candidate.version)) {
      throw new Error(`${candidate.packageName}@${candidate.version} appeared after preflight`);
    }
    await clients.publishArchive(candidate.archivePath);
  }
  for (const candidate of receipt.packages) {
    const registrySnapshot = normalizeRegistrySnapshot(
      await clients.registryInspect(candidate.packageName),
    );
    if (!registrySnapshot.versions.includes(candidate.version)) {
      throw new Error(`${candidate.packageName}@${candidate.version} is absent after publication`);
    }
    const registryArchive = await clients.registryArchive(candidate.packageName, candidate.version);
    const localArchive = await readFile(candidate.archivePath);
    assertSameBytes(registryArchive, localArchive, `${candidate.packageName} published archive`);
    assertDistTagsAfter({
      before: candidate.distTagsBefore,
      after: registrySnapshot.distTags,
      candidateVersion: candidate.version,
      state: candidate.state,
    });
  }

  const releasePlans = [];
  for (const candidate of receipt.packages) {
    const tag = await clients.giteaTag(candidate.tagName);
    if ((tag?.targetSha ?? null) !== candidate.tagTargetSha) {
      throw new Error(`${candidate.tagName} target changed before release mutation`);
    }
    const release = await clients.giteaRelease(candidate.tagName);
    if ((release?.id ?? null) !== candidate.releaseId) {
      throw new Error(`${candidate.tagName} release changed before release mutation`);
    }
    const releaseAssets = await assertExistingRelease(candidate, release, clients);
    releasePlans.push({ candidate, release, missingAssetNames: releaseAssets.missingAssetNames });
  }
  if ((await clients.remoteMain()) !== receipt.sourceSha) {
    throw new Error("main moved before tag/release mutation");
  }
  for (const plan of releasePlans) {
    const { candidate } = plan;
    let release = plan.release;
    if (stateRequiresReleaseCreation(release)) {
      release = await clients.createRelease({
        tagName: candidate.tagName,
        targetSha: candidate.sourceSha,
        ...expectedReleaseMetadata(candidate),
      });
      assertCreatedRelease(release, {
        tagName: candidate.tagName,
        targetSha: candidate.sourceSha,
        ...expectedReleaseMetadata(candidate),
      });
      const createdTag = await clients.giteaTag(candidate.tagName);
      if (createdTag?.targetSha !== candidate.sourceSha) {
        throw new Error(`${candidate.tagName} target mismatch after release creation`);
      }
      const persistedRelease = await clients.giteaRelease(candidate.tagName);
      assertCreatedRelease(persistedRelease, {
        tagName: candidate.tagName,
        targetSha: candidate.sourceSha,
        ...expectedReleaseMetadata(candidate),
      });
      if (persistedRelease.id !== release.id) {
        throw new Error(`${candidate.tagName} persisted release ID mismatch`);
      }
      release = persistedRelease;
    }
    for (const asset of candidate.localAssets.filter(({ name }) =>
      plan.missingAssetNames.includes(name),
    )) {
      await clients.uploadReleaseAsset(
        release.id,
        asset.name,
        path.join(candidate.releaseDirectory, asset.name),
      );
    }
  }
  for (const candidate of receipt.packages) {
    const tag = await clients.giteaTag(candidate.tagName);
    if (tag?.targetSha !== candidate.sourceSha)
      throw new Error(`${candidate.tagName} target moved`);
    const release = await clients.giteaRelease(candidate.tagName);
    if (!release) throw new Error(`${candidate.tagName} release is missing after publication`);
    await assertExistingRelease(candidate, release, clients, { requireComplete: true });
  }
}
