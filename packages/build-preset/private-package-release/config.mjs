import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";
import npa from "npm-package-arg";

export const CONFIG_PROFILE = "arcade-cabinet/private-package-release-config/v2";
export const RECEIPT_PROFILE = "arcade-cabinet/private-package-release-receipt/v2";
export const SBOM_PROFILE =
  "arcade-cabinet/pnpm-11.21.0/cyclonedx-1.7/lockfile-only-prod-no-peers-no-optional/v1";

const relativePathPattern = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[A-Za-z0-9._/-]+$";
const hex64 = "^[0-9a-f]{64}$";
const vcsControlDirectories = new Set([".git", ".hg", ".jj", ".svn"]);
const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "profile",
    "repository",
    "configPath",
    "workflowPath",
    "mainBranch",
    "releaseInputPaths",
    "registry",
    "packages",
  ],
  properties: {
    profile: { const: CONFIG_PROFILE },
    repository: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
    configPath: { type: "string", pattern: relativePathPattern },
    workflowPath: { type: "string", pattern: relativePathPattern },
    mainBranch: { const: "main" },
    releaseInputPaths: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: relativePathPattern },
    },
    registry: {
      type: "object",
      additionalProperties: false,
      required: ["url", "scope"],
      properties: {
        url: { type: "string", format: "uri" },
        scope: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
      },
    },
    packages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "directory",
          "generatedPaths",
          "sourcePaths",
          "name",
          "tagPrefix",
          "admission",
        ],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
          directory: {
            anyOf: [{ const: "." }, { type: "string", pattern: relativePathPattern }],
          },
          generatedPaths: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", pattern: relativePathPattern },
          },
          sourcePaths: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", pattern: relativePathPattern },
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 214,
          },
          tagPrefix: { type: "string", pattern: "^[A-Za-z0-9._-]*$" },
          admission: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "profile",
                  "rootPurl",
                  "componentCount",
                  "dependencyCount",
                  "componentIdentitySha256",
                  "dependencyAdjacencySha256",
                ],
                properties: {
                  profile: { const: SBOM_PROFILE },
                  rootPurl: { type: "string", pattern: "^pkg:npm/" },
                  componentCount: { type: "integer", minimum: 0 },
                  dependencyCount: { type: "integer", minimum: 1 },
                  componentIdentitySha256: { type: "string", pattern: hex64 },
                  dependencyAdjacencySha256: { type: "string", pattern: hex64 },
                },
              },
            ],
          },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

function canonical(value) {
  const result = canonicalize(value);
  if (typeof result !== "string") throw new Error("RFC 8785 canonicalization failed");
  return result;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSafeHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment`);
  }
  return url;
}

export function validateReleaseConfig(value, { requireAdmissions = true } = {}) {
  if (!validateSchema(value)) {
    throw new Error(
      `invalid private-package release config: ${ajv.errorsText(validateSchema.errors)}`,
    );
  }
  const config = structuredClone(value);
  const configuredPaths = [
    config.configPath,
    config.workflowPath,
    ...config.releaseInputPaths,
    ...config.packages.flatMap((spec) => [
      spec.directory,
      ...spec.generatedPaths,
      ...spec.sourcePaths,
    ]),
  ];
  if (configuredPaths.some((configuredPath) => /\p{Cc}/u.test(configuredPath))) {
    throw new Error("release config paths may not contain control characters");
  }
  if (
    configuredPaths.some(
      (configuredPath) =>
        configuredPath !== "." && path.posix.normalize(configuredPath) !== configuredPath,
    )
  ) {
    throw new Error("release config paths must be canonical POSIX paths");
  }
  const registry = assertSafeHttpsUrl(config.registry.url, "registry URL");
  if (!registry.pathname.endsWith("/")) throw new Error("registry URL must end with /");
  if (registry.pathname !== `/api/packages/${config.registry.scope.slice(1)}/npm/`) {
    throw new Error("registry URL owner and configured scope disagree");
  }
  if (config.configPath === config.workflowPath) {
    throw new Error("config and workflow paths must differ");
  }
  const automaticInputs = new Set([
    ".npmrc",
    "LICENSE",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    config.configPath,
    config.workflowPath,
  ]);
  if (config.releaseInputPaths.some((input) => automaticInputs.has(input))) {
    throw new Error("releaseInputPaths must not duplicate automatic release inputs");
  }
  config.releaseInputPaths.sort();

  const ids = new Set();
  const names = new Set();
  const directories = new Set();
  const tagPrefixes = new Set();
  const allSourcePaths = [];
  for (const spec of config.packages) {
    let parsedName;
    try {
      parsedName = npa(spec.name);
    } catch {
      throw new Error(`${spec.id} name is not a valid npm package name`);
    }
    if (
      !parsedName.registry ||
      parsedName.rawSpec !== "*" ||
      parsedName.name !== spec.name ||
      !spec.name.startsWith(`${config.registry.scope}/`)
    ) {
      throw new Error(`${spec.id} name is not an exact package in ${config.registry.scope}`);
    }
    if (
      ids.has(spec.id) ||
      names.has(spec.name) ||
      directories.has(spec.directory) ||
      tagPrefixes.has(spec.tagPrefix)
    ) {
      throw new Error(`duplicate package identity in release config: ${spec.id}`);
    }
    ids.add(spec.id);
    names.add(spec.name);
    directories.add(spec.directory);
    tagPrefixes.add(spec.tagPrefix);
    if (
      spec.tagPrefix.startsWith("-") ||
      spec.tagPrefix.endsWith(".") ||
      spec.tagPrefix.includes("..") ||
      spec.tagPrefix.endsWith(".lock")
    ) {
      throw new Error(`${spec.id} tagPrefix can form an unsafe Git ref`);
    }
    spec.sourcePaths.sort();
    spec.generatedPaths.sort();
    if (spec.sourcePaths.includes(".")) {
      throw new Error(`${spec.id} sourcePaths must not bind the whole repository`);
    }
    if (spec.directory !== "." && !spec.sourcePaths.includes(spec.directory)) {
      throw new Error(`${spec.id} sourcePaths must include its package directory`);
    }
    for (const generatedPath of spec.generatedPaths) {
      if (
        generatedPath === spec.directory ||
        (spec.directory !== "." && !generatedPath.startsWith(`${spec.directory}/`)) ||
        generatedPath.split("/").some((segment) => vcsControlDirectories.has(segment.toLowerCase()))
      ) {
        throw new Error(`${spec.id} generatedPaths must be safe strict descendants of its package`);
      }
    }
    for (const sourcePath of spec.sourcePaths) {
      const overlap = allSourcePaths.find(
        (existing) =>
          existing.path === sourcePath ||
          existing.path.startsWith(`${sourcePath}/`) ||
          sourcePath.startsWith(`${existing.path}/`),
      );
      if (overlap) {
        throw new Error(
          `overlapping package source paths: ${overlap.id}:${overlap.path} and ${spec.id}:${sourcePath}`,
        );
      }
      allSourcePaths.push({ id: spec.id, path: sourcePath });
    }
    if (requireAdmissions && spec.admission === null) {
      throw new Error(`${spec.id} has no committed exact SBOM admission`);
    }
    if (spec.admission && spec.admission.dependencyCount !== spec.admission.componentCount + 1) {
      throw new Error(`${spec.id} admission dependency count must include exactly the root node`);
    }
  }
  config.packages.sort((left, right) => left.id.localeCompare(right.id));
  return config;
}

export async function loadReleaseConfig({ workspaceRoot, configPath, requireAdmissions = true }) {
  const root = await realpath(workspaceRoot);
  const absolute = path.resolve(root, configPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("release config must be a repo-relative file inside the workspace");
  }
  const resolved = await realpath(absolute);
  if (resolved !== absolute) throw new Error("release config may not traverse a symlink");
  const raw = await readFile(absolute, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("private-package release config is not valid JSON");
  }
  const config = validateReleaseConfig(parsed, { requireAdmissions });
  if (config.configPath !== relative.split(path.sep).join("/")) {
    throw new Error(`configPath ${config.configPath} does not identify the loaded config`);
  }
  return {
    config,
    absolutePath: absolute,
    bytes: Buffer.from(raw),
    sha256: sha256(canonical(config)),
  };
}

const implementationFiles = [
  "anonymous-environment.mjs",
  "cli.mjs",
  "config.mjs",
  "fingerprint.mjs",
  "index.mjs",
  "orchestrator.mjs",
  "dependency-current.mjs",
  "runtime.mjs",
  "sbom.mjs",
  "state.mjs",
  "toolchain.mjs",
];

export async function runningVerifierIdentity() {
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.dirname(moduleRoot);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@arcade-cabinet/build-preset" || typeof manifest.version !== "string") {
    throw new Error("release verifier is not running from @arcade-cabinet/build-preset");
  }
  const files = [];
  for (const name of implementationFiles) {
    files.push({ name, sha256: sha256(await readFile(path.join(moduleRoot, name))) });
  }
  return {
    packageName: manifest.name,
    version: manifest.version,
    receiptProfile: RECEIPT_PROFILE,
    configProfile: CONFIG_PROFILE,
    sbomProfile: SBOM_PROFILE,
    implementationSha256: sha256(canonical(files)),
  };
}
