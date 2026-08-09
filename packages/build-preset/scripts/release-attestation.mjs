import { createHash } from "node:crypto";

const SHA_PATTERN = /^[a-f0-9]{40}$/;

function requireSha(value, label) {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} is not a full commit SHA: ${value}`);
}

export async function assertCommitAncestor({
  ancestorSha,
  headSha,
  loadCommit,
  maxCommits = 4096,
}) {
  requireSha(ancestorSha, "ancestor");
  requireSha(headSha, "head");

  const pending = [headSha];
  const visited = new Set();
  for (let index = 0; index < pending.length; index += 1) {
    const sha = pending[index];
    if (sha === ancestorSha) return;
    if (visited.has(sha)) continue;
    if (visited.size >= maxCommits) {
      throw new Error(`commit ancestry proof exceeded ${maxCommits} commits`);
    }
    visited.add(sha);

    const commit = await loadCommit(sha);
    if (commit?.sha !== sha || !Array.isArray(commit.parents)) {
      throw new Error(`Gitea returned malformed commit ancestry for ${sha}`);
    }
    for (const parent of commit.parents) {
      requireSha(parent?.sha, `parent of ${sha}`);
      if (!visited.has(parent.sha)) pending.push(parent.sha);
    }
  }

  throw new Error(`tag commit ${ancestorSha} is not an ancestor of current Gitea main ${headSha}`);
}

export function assertExactChecksums({ contents, expectedAssets, assets }) {
  const lines = contents.trim().split(/\r?\n/);
  const checksums = new Map();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (!match) throw new Error(`malformed checksum line: ${line}`);
    const [, expectedSha, name] = match;
    if (checksums.has(name)) throw new Error(`duplicate checksum asset: ${name}`);
    checksums.set(name, expectedSha);
  }

  const expectedNames = [...expectedAssets].sort();
  const actualNames = [...checksums.keys()].sort();
  if (
    lines.length !== expectedNames.length ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(
      `checksum asset set mismatch: expected ${expectedNames.join(", ")}, got ` +
        `${actualNames.join(", ")}`,
    );
  }
  for (const name of expectedNames) {
    const bytes = assets.get(name);
    if (!bytes) throw new Error(`checksum target is missing release bytes: ${name}`);
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    if (checksums.get(name) !== actualSha) {
      throw new Error(`checksum mismatch for release asset ${name}`);
    }
  }
}

export function assertCycloneDxPackageIdentity(sbom, { packageName, version }) {
  const separator = packageName.indexOf("/");
  const group = packageName.startsWith("@") && separator > 0 ? packageName.slice(0, separator) : "";
  const name = group ? packageName.slice(separator + 1) : packageName;
  const expectedPurl = `pkg:npm/${group ? `${encodeURIComponent(group)}/` : ""}${name}@${version}`;
  const component = sbom?.metadata?.component;
  if (
    sbom?.bomFormat !== "CycloneDX" ||
    component?.group !== group ||
    component?.name !== name ||
    component?.version !== version ||
    component?.purl !== expectedPurl
  ) {
    throw new Error(
      `CycloneDX component mismatch for ${packageName}@${version}: ` +
        `${JSON.stringify(component ?? null)}`,
    );
  }
}
