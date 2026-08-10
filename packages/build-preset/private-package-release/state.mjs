import canonicalize from "canonicalize";
import semver from "semver";

export const RELEASE_STATES = Object.freeze({
  NEW: "NEW",
  REGISTRY_ONLY: "REGISTRY_ONLY",
  TAG_ONLY: "TAG_ONLY",
  EXISTING: "EXISTING",
});

function requireVersion(version, label) {
  if (!semver.valid(version)) throw new Error(`${label} is not valid SemVer: ${version}`);
}

export function normalizeRegistrySnapshot({ versions, distTags }) {
  if (!Array.isArray(versions) || !distTags || typeof distTags !== "object") {
    throw new Error("registry versions and dist-tags are required");
  }
  const normalizedVersions = [...new Set(versions)];
  for (const version of normalizedVersions) requireVersion(version, "registry version");
  normalizedVersions.sort(semver.compare);

  const normalizedDistTags = {};
  for (const [tag, version] of Object.entries(distTags).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (version === undefined) continue;
    requireVersion(version, `${tag} dist-tag`);
    normalizedDistTags[tag] = version;
  }
  return { versions: normalizedVersions, distTags: normalizedDistTags };
}

export function classifyRegistryState({ candidateVersion, versions, distTags }) {
  requireVersion(candidateVersion, "candidate version");
  const normalized = normalizeRegistrySnapshot({ versions, distTags });
  const versionExists = normalized.versions.includes(candidateVersion);
  const latest = normalized.distTags.latest;

  if (!versionExists) {
    const blockingVersion = normalized.versions.find(
      (version) => !semver.lt(version, candidateVersion),
    );
    if (blockingVersion || (latest !== undefined && !semver.lt(latest, candidateVersion))) {
      throw new Error(
        `new ${candidateVersion} must be greater than every registry version and latest dist-tag; ` +
          `found ${blockingVersion ?? latest}; refusing mutation`,
      );
    }
    return { ...normalized, versionExists: false, latestMode: "new", latest };
  }

  if (latest === candidateVersion) {
    return { ...normalized, versionExists: true, latestMode: "candidate", latest };
  }
  if (latest !== undefined && semver.gt(latest, candidateVersion)) {
    return { ...normalized, versionExists: true, latestMode: "successor", latest };
  }
  throw new Error(
    `existing ${candidateVersion} requires latest to equal it or be a greater successor, got ${latest ?? "<missing>"}`,
  );
}

export function classifyReleaseState({ registry, tag, release }) {
  if (!registry.versionExists) {
    if (tag || release)
      throw new Error("new registry version conflicts with an existing tag/release");
    return RELEASE_STATES.NEW;
  }
  if (release && !tag) throw new Error("release exists without its immutable package tag");
  if (!tag && !release) return RELEASE_STATES.REGISTRY_ONLY;
  if (tag && !release) return RELEASE_STATES.TAG_ONLY;
  return RELEASE_STATES.EXISTING;
}

export function expectedReleaseMetadata(candidate) {
  const name = `${candidate.packageName} v${candidate.version}`;
  const body = [
    `Exact private npm release for ${candidate.packageName}@${candidate.version}.`,
    `Source: ${candidate.sourceSha}`,
    `Package source SHA-256: ${candidate.packageSourceSha256}`,
    `Release-input SHA-256: ${candidate.releaseInputSha256}`,
    `Archive SHA-256: ${candidate.archiveSha256}`,
  ].join("\n");
  return { name, body, draft: false, prerelease: false };
}

export function assertReleaseMetadata(actual, expected) {
  for (const field of ["name", "body", "draft", "prerelease"]) {
    if (actual?.[field] !== expected[field]) {
      throw new Error(`release ${field} mismatch`);
    }
  }
}

export function assertCreatedRelease(actual, expected) {
  assertReleaseMetadata(actual, expected);
  if (
    !Number.isSafeInteger(actual?.id) ||
    actual.id <= 0 ||
    actual.tagName !== expected.tagName ||
    actual.targetCommitish !== expected.targetSha
  ) {
    throw new Error(`created release response mismatch for ${expected.tagName}`);
  }
}

export function assertDistTagsAfter({ before, after, candidateVersion, state }) {
  const beforeWithoutLatest = { ...before };
  const afterWithoutLatest = { ...after };
  delete beforeWithoutLatest.latest;
  delete afterWithoutLatest.latest;
  if (canonicalize(beforeWithoutLatest) !== canonicalize(afterWithoutLatest)) {
    throw new Error("non-latest dist-tags changed during package release");
  }

  if (state === RELEASE_STATES.NEW) {
    if (after.latest !== candidateVersion) {
      throw new Error(`new package latest ${after.latest ?? "<missing>"} != ${candidateVersion}`);
    }
    return;
  }
  if (after.latest !== before.latest) throw new Error("existing package latest dist-tag moved");
}

export function stateRequiresRegistryPublish(state) {
  return state === RELEASE_STATES.NEW;
}

export function stateRequiresReleaseCreation(release) {
  return release == null;
}
