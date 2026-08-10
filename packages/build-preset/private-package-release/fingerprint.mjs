import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import canonicalize from "canonicalize";

const exec = promisify(execFile);
const CORE_RELEASE_INPUTS = [
  ".npmrc",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];

function canonical(value) {
  const result = canonicalize(value);
  if (typeof result !== "string") throw new Error("RFC 8785 canonicalization failed");
  return result;
}

function requireRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a safe non-root repo-relative path`);
  }
}

function requireHex(value, label, length) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value)) {
    throw new Error(`${label} is not a ${length}-character lowercase hex digest`);
  }
}

export function createGitClient(cwd = process.cwd()) {
  return async (...args) =>
    (
      await exec("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout.trim();
}

function parseTreeEntries(listing) {
  if (!listing) return [];
  return listing.split("\n").map((line) => {
    const match = line.match(/^([0-7]{6}) (blob|tree) ([0-9a-f]{40})\t(.+)$/u);
    if (!match) throw new Error(`malformed Git tree entry: ${line}`);
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
  });
}

async function sourceIdentity({ sourceSha, sourcePaths, git }) {
  const paths = [...new Set(sourcePaths)].sort();
  if (paths.length !== sourcePaths.length || paths.length === 0) {
    throw new Error("package sourcePaths must be a nonempty unique set");
  }
  for (const sourcePath of paths) requireRelativePath(sourcePath, "package source path");
  const listing = await git("ls-tree", "-r", "--full-tree", sourceSha, "--", ...paths);
  const entries = parseTreeEntries(listing).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const symlinks = entries.filter((entry) => entry.mode === "120000");
  if (symlinks.length > 0) {
    throw new Error(
      `package sourcePaths may not contain tracked symlinks: ${symlinks.map(({ path }) => path).join(", ")}`,
    );
  }
  for (const sourcePath of paths) {
    if (
      !entries.some((entry) => entry.path === sourcePath || entry.path.startsWith(`${sourcePath}/`))
    ) {
      throw new Error(`package source path has no tracked entries: ${sourcePath}`);
    }
  }
  return {
    sourcePaths: paths,
    packageSourceSha256: createHash("sha256").update(canonical(entries)).digest("hex"),
  };
}

export async function computeReleaseInput({
  sourceSha,
  packageDirectory,
  sourcePaths,
  configPath,
  workflowPath,
  releaseInputPaths = [],
  git = createGitClient(),
}) {
  requireHex(sourceSha, "source SHA", 40);
  if (
    packageDirectory !== "." &&
    (typeof packageDirectory !== "string" ||
      packageDirectory.startsWith("/") ||
      packageDirectory.includes("\\") ||
      packageDirectory.split("/").includes(".."))
  ) {
    throw new Error(`invalid private package directory: ${packageDirectory}`);
  }
  requireRelativePath(configPath, "release config path");
  requireRelativePath(workflowPath, "release workflow path");

  const source = await sourceIdentity({ sourceSha, sourcePaths, git });
  const sourceEpoch = await git("show", "-s", "--format=%ct", sourceSha);
  const inputFiles = [
    ...new Set([...CORE_RELEASE_INPUTS, configPath, workflowPath, ...releaseInputPaths]),
  ].sort();
  const blobs = {};
  for (const file of inputFiles) {
    requireRelativePath(file, "release input path");
    const entries = parseTreeEntries(
      await git("ls-tree", "--full-tree", sourceSha, "--", file),
    ).filter((entry) => entry.path === file);
    if (
      entries.length !== 1 ||
      entries[0].type !== "blob" ||
      !["100644", "100755"].includes(entries[0].mode)
    ) {
      throw new Error(`release input must be one tracked regular file: ${file}`);
    }
    blobs[file] = entries[0].object;
    requireHex(blobs[file], `release input blob ${file}`, 40);
  }
  const fingerprintInput = {
    profile: "arcade-cabinet/private-package-release-inputs/v2",
    packageDirectory,
    sourcePaths: source.sourcePaths,
    packageSourceSha256: source.packageSourceSha256,
    blobs,
  };
  const releaseInputSha256 = createHash("sha256").update(canonical(fingerprintInput)).digest("hex");
  requireHex(source.packageSourceSha256, "package source fingerprint", 64);
  requireHex(releaseInputSha256, "release-input fingerprint", 64);
  if (!/^\d+$/u.test(sourceEpoch)) throw new Error("source epoch is not an integer");

  return {
    sourceSha,
    sourceEpoch,
    packageDirectory,
    sourcePaths: source.sourcePaths,
    packageSourceSha256: source.packageSourceSha256,
    licenseBlob: blobs.LICENSE,
    lockfileBlob: blobs["pnpm-lock.yaml"],
    configBlob: blobs[configPath],
    workflowBlob: blobs[workflowPath],
    rootManifestBlob: blobs["package.json"],
    workspaceBlob: blobs["pnpm-workspace.yaml"],
    npmrcBlob: blobs[".npmrc"],
    releaseInputSha256,
    inputFiles,
  };
}
