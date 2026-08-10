import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Version } from "@cyclonedx/cyclonedx-library/Spec";
import { JsonStrictValidator } from "@cyclonedx/cyclonedx-library/Validation";
import canonicalize from "canonicalize";
import { PackageURL } from "packageurl-js";
import semver from "semver";
import parseSpdxExpression from "spdx-expression-parse";
import { v5 as uuidv5 } from "uuid";
import { SBOM_PROFILE } from "./config.mjs";

export const SBOM_UUID_NAMESPACE = "9f1ed970-9b8a-583c-8204-6adaaa90c9b4";
export const PNPM_VERSION = "11.21.0";
export const NODE_VERSION = "v24.19.0";

const SBOM_SCHEMA = "http://cyclonedx.org/schema/bom-1.7.schema.json";
const validator = new JsonStrictValidator(Version.v1dot7);
const execute = promisify(execFile);
const secretEnvironmentKey = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)(?:_|$)/iu;
const forbiddenEnvironmentKey = /^(?:GITEA(?:_|$)|ACTIONS_|RUNNER_|NODE_PATH$)/iu;
const credentialNpmConfigKey = /^npm_config_.*(?:auth|token|password|username|cookie|cert|key)/iu;
const npmConfigPathKeys = new Set(["npm_config_userconfig", "npm_config_globalconfig"]);
const credentialNpmConfigText = /(?:auth|password|token|secret|credential|cookie)[^=\r\n]*=/iu;
const credentialText =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:npm|gh[pousr])_[A-Za-z0-9_-]{12,}|\b(?:token|secret|password|credential|authorization|cookie)\s*[=:]\s*\S+)/iu;
const managedPropertyNames = new Set([
  "arcade-cabinet:sbom-profile",
  "arcade-cabinet:source-sha",
  "arcade-cabinet:source-epoch",
  "arcade-cabinet:lockfile-blob-sha1",
  "arcade-cabinet:package-source-sha256",
  "arcade-cabinet:release-input-sha256",
  "arcade-cabinet:component-identity-sha256",
  "arcade-cabinet:dependency-adjacency-sha256",
]);

/**
 * RFC 4122 UUIDv5 namespace derived once as
 * uuid.v5('https://arcade-cabinet.dev/sbom/pnpm-package', uuid.v5.URL).
 * The UUID name is the documented profile, source commit, package purl,
 * lockfile Git blob identity, and sorted archive name/SHA-256 identities.
 */
function stableSerialNumber({ sourceSha, rootRef, lockfileBlob, archives }) {
  const seed = [
    SBOM_PROFILE,
    sourceSha,
    rootRef,
    lockfileBlob,
    ...archives.map(({ name, sha256 }) => `${name}:${sha256}`).sort(),
  ].join("\n");
  return `urn:uuid:${uuidv5(seed, SBOM_UUID_NAMESPACE)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  const result = canonicalize(value);
  if (typeof result !== "string") throw new Error("RFC 8785 canonicalization failed");
  return result;
}

function fullName(component) {
  return component?.group ? `${component.group}/${component.name}` : component?.name;
}

function packagePurl(packageName, version) {
  const slash = packageName.startsWith("@") ? packageName.indexOf("/") : -1;
  const namespace = slash > 0 ? packageName.slice(0, slash) : undefined;
  const name = slash > 0 ? packageName.slice(slash + 1) : packageName;
  return new PackageURL("npm", namespace, name, version).toString();
}

function requireHex(value, label, length) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value ?? "")) {
    throw new Error(`${label} must be ${length} lowercase hexadecimal characters`);
  }
}

function stableTimestamp(sourceEpoch) {
  const epoch = Number(sourceEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || String(epoch) !== String(sourceEpoch)) {
    throw new Error(`invalid source epoch: ${sourceEpoch}`);
  }
  try {
    return new Date(epoch * 1_000).toISOString();
  } catch {
    throw new Error(`invalid source epoch: ${sourceEpoch}`);
  }
}

function normalizeRepository(repository) {
  if (typeof repository === "string") return { url: repository };
  if (!repository || typeof repository !== "object" || typeof repository.url !== "string") {
    throw new Error("package manifest repository URL is required");
  }
  return { url: repository.url, directory: repository.directory };
}

function expectedLicense(license) {
  if (typeof license !== "string" || license.length === 0) {
    throw new Error("package manifest SPDX license is required");
  }
  if (license === "UNLICENSED") return [{ license: { name: "UNLICENSED" } }];
  let parsed;
  try {
    parsed = parseSpdxExpression(license);
  } catch {
    throw new Error(`package manifest license is not a valid SPDX expression: ${license}`);
  }
  return parsed.license && !parsed.conjunction && !parsed.left && !parsed.right
    ? [{ license: { id: parsed.license } }]
    : [{ expression: license }];
}

function assertOnlyMetadataTimestamp(value, location = "$") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertOnlyMetadataTimestamp(child, `${location}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (key === "timestamp" && childLocation !== "$.metadata.timestamp") {
      throw new Error(`unexpected volatile timestamp field: ${childLocation}`);
    }
    assertOnlyMetadataTimestamp(child, childLocation);
  }
}

function urlTokens(value) {
  return value.match(/(?:https?|git\+https|git\+ssh|ssh|git):\/\/[^\s<>"']+/giu) ?? [];
}

function assertSafeStrings(value, forbiddenValues, location = "$") {
  if (typeof value === "string") {
    if (credentialText.test(value)) throw new Error(`credential-like text at ${location}`);
    for (const forbidden of forbiddenValues) {
      if (forbidden && value.includes(forbidden)) {
        throw new Error(`forbidden environment/canary value at ${location}`);
      }
    }
    if (value.startsWith("pkg:") && /[?#]/u.test(value)) {
      throw new Error(`purl query or fragment at ${location}`);
    }
    for (const token of urlTokens(value)) {
      const trimmed = token.replace(/[),.;]+$/u, "");
      let parsed;
      try {
        parsed = new URL(trimmed.replace(/^git\+/u, ""));
      } catch {
        throw new Error(`unparseable URL at ${location}`);
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`URL auth, query, or fragment at ${location}`);
      }
      if (parsed.protocol !== "https:" && trimmed !== SBOM_SCHEMA) {
        throw new Error(`non-HTTPS URL at ${location}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertSafeStrings(child, forbiddenValues, `${location}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assertSafeStrings(key, forbiddenValues, `${location}.<key>`);
    assertSafeStrings(child, forbiddenValues, `${location}.${key}`);
  }
}

async function validateSchema(text, label) {
  const error = await validator.validate(text);
  if (error) {
    const detail = typeof error === "string" ? error : JSON.stringify(error);
    throw new Error(`${label} CycloneDX 1.7 strict validation failed: ${detail}`);
  }
}

async function workspacePackageNames(workspaceRoot) {
  const names = new Set();
  const packagesRoot = path.join(workspaceRoot, "packages");
  let entries;
  try {
    entries = await readdir(packagesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return names;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(packagesRoot, entry.name, "package.json"), "utf8"),
      );
      if (typeof manifest.name === "string") names.add(manifest.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return names;
}

function assertRootIdentity(sbom, manifest, packageDirectory, workspaceRoot) {
  const root = sbom.metadata?.component;
  const rootRef = packagePurl(manifest.name, manifest.version);
  const repository = normalizeRepository(manifest.repository);
  const externalReferences = [{ type: "vcs", url: repository.url }];
  if (typeof manifest.bugs?.url === "string") {
    externalReferences.push({ type: "issue-tracker", url: manifest.bugs.url });
  }
  const expectedRepositoryDirectory = path.relative(workspaceRoot, packageDirectory);
  if (
    sbom.$schema !== SBOM_SCHEMA ||
    sbom.bomFormat !== "CycloneDX" ||
    sbom.specVersion !== "1.7" ||
    root?.type !== "library" ||
    root?.purl !== rootRef ||
    root?.["bom-ref"] !== rootRef ||
    root?.version !== manifest.version ||
    fullName(root) !== manifest.name ||
    root?.description !== manifest.description ||
    canonical(root?.licenses) !== canonical(expectedLicense(manifest.license)) ||
    canonical(root?.externalReferences) !== canonical(externalReferences)
  ) {
    throw new Error(
      `SBOM root identity does not exactly match ${manifest.name}@${manifest.version}`,
    );
  }
  if (repository.directory && repository.directory !== expectedRepositoryDirectory) {
    throw new Error("manifest repository.directory does not match the package subtree");
  }
  if (
    canonical(sbom.metadata?.lifecycles) !== canonical([{ phase: "pre-build" }]) ||
    canonical(sbom.metadata?.tools?.components) !==
      canonical([{ type: "application", name: "pnpm", version: PNPM_VERSION }])
  ) {
    throw new Error("SBOM is not the exact pnpm 11.21.0 lockfile-only pre-build profile");
  }
  return { root, rootRef };
}

function validateGraph(sbom, rootRef, registryUrl) {
  if (!Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    throw new Error("SBOM components/dependencies must be arrays");
  }
  if ((sbom.services?.length ?? 0) > 0) throw new Error("unexpected service graph in npm SBOM");
  const componentsByRef = new Map();
  const identities = new Set();
  for (const component of sbom.components) {
    const reference = component["bom-ref"];
    if (!reference || componentsByRef.has(reference)) {
      throw new Error(`duplicate or missing component bom-ref: ${reference ?? "<missing>"}`);
    }
    if (component.purl !== reference) throw new Error(`component ${reference} purl/ref mismatch`);
    let parsed;
    try {
      parsed = PackageURL.fromString(reference);
    } catch {
      throw new Error(`component ${reference} is not a valid package URL`);
    }
    if (
      parsed.type !== "npm" ||
      parsed.version !== component.version ||
      packagePurl(fullName(component), component.version) !== reference
    ) {
      throw new Error(`component ${reference} identity fields disagree`);
    }
    const identity = `${fullName(component)}@${component.version}`;
    if (identities.has(identity)) throw new Error(`duplicate component identity: ${identity}`);
    identities.add(identity);
    if (component.scope !== undefined && component.scope !== "required") {
      throw new Error(`mandatory component ${reference} is not required scope`);
    }
    const externalReferences = component.externalReferences ?? [];
    let distributionUrl;
    try {
      distributionUrl = new URL(externalReferences[0]?.url);
    } catch {
      distributionUrl = undefined;
    }
    const isPublicRegistry = distributionUrl?.origin === "https://registry.npmjs.org";
    const privateRegistry = new URL(registryUrl);
    const isPrivateRegistry =
      distributionUrl?.origin === privateRegistry.origin &&
      distributionUrl.pathname.startsWith(privateRegistry.pathname);
    if (
      externalReferences.length !== 1 ||
      externalReferences[0]?.type !== "distribution" ||
      (!isPublicRegistry && !isPrivateRegistry) ||
      distributionUrl.username ||
      distributionUrl.password ||
      distributionUrl.search ||
      distributionUrl.hash ||
      !distributionUrl.pathname.endsWith(".tgz") ||
      !(externalReferences[0].hashes ?? []).some(
        (hash) => hash.alg === "SHA-512" && /^[0-9a-f]{128}$/u.test(hash.content ?? ""),
      )
    ) {
      throw new Error(
        `component ${reference} lacks exact registry distribution SHA-512 provenance`,
      );
    }
    componentsByRef.set(reference, component);
  }

  const knownRefs = new Set([rootRef, ...componentsByRef.keys()]);
  const graph = new Map();
  for (const dependency of sbom.dependencies) {
    if (!knownRefs.has(dependency.ref) || graph.has(dependency.ref)) {
      throw new Error(`duplicate or unresolved dependency graph ref: ${dependency.ref}`);
    }
    const dependsOn = dependency.dependsOn ?? [];
    const provides = dependency.provides ?? [];
    if (
      new Set(dependsOn).size !== dependsOn.length ||
      new Set(provides).size !== provides.length
    ) {
      throw new Error(`duplicate outgoing dependency edge at ${dependency.ref}`);
    }
    const outgoing = [...dependsOn, ...provides];
    if (new Set(outgoing).size !== outgoing.length) {
      throw new Error(`dependency edge repeated across dependsOn/provides at ${dependency.ref}`);
    }
    for (const reference of outgoing) {
      if (!knownRefs.has(reference)) {
        throw new Error(`dependency graph edge ${dependency.ref} -> ${reference} is unresolved`);
      }
      if (reference === dependency.ref)
        throw new Error(`self dependency edge at ${dependency.ref}`);
    }
    graph.set(dependency.ref, outgoing);
  }
  if (graph.size !== knownRefs.size)
    throw new Error("dependency graph does not cover every component");

  const reachable = new Set([rootRef]);
  const queue = [rootRef];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of graph.get(current) ?? []) {
      if (reachable.has(child)) continue;
      reachable.add(child);
      queue.push(child);
    }
  }
  if (reachable.size !== knownRefs.size)
    throw new Error("dependency graph contains unreachable refs");
  return { componentsByRef, graph };
}

function directManifestContract(manifest) {
  const dependencies = new Map(Object.entries(manifest.dependencies ?? {}));
  return { dependencies };
}

function validateMandatoryProfile(sbom, manifest, rootRef, componentsByRef) {
  const rootEdge = sbom.dependencies.find((dependency) => dependency.ref === rootRef);
  if (!rootEdge) throw new Error("dependency graph is missing the package root edge");
  if ((rootEdge.provides?.length ?? 0) > 0)
    throw new Error("package root unexpectedly provides refs");
  const { dependencies } = directManifestContract(manifest);
  const actualNames = [];
  for (const reference of rootEdge.dependsOn ?? []) {
    const component = componentsByRef.get(reference);
    const name = fullName(component);
    const range = dependencies.get(name);
    if (!range) throw new Error(`unexpected mandatory package root edge: ${reference}`);
    if (
      !semver.validRange(range) ||
      !semver.satisfies(component.version, range, { includePrerelease: true })
    ) {
      throw new Error(`${name}@${component.version} does not satisfy dependency ${range}`);
    }
    actualNames.push(name);
  }
  const expectedNames = [...dependencies.keys()].sort();
  actualNames.sort();
  if (canonical(actualNames) !== canonical(expectedNames)) {
    throw new Error(
      `mandatory root edge mismatch: expected ${expectedNames.join(", ")}, got ${actualNames.join(", ")}`,
    );
  }
}

function normalizeSetOrdering(sbom) {
  sbom.components.sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));
  for (const dependency of sbom.dependencies) {
    dependency.dependsOn?.sort((left, right) => left.localeCompare(right));
    dependency.provides?.sort((left, right) => left.localeCompare(right));
  }
  sbom.dependencies.sort((left, right) => left.ref.localeCompare(right.ref));
}

function mergeRootProperties(root, expectedProperties) {
  const existing = root.properties ?? [];
  const expectedByName = new Map(
    expectedProperties.map((property) => [property.name, property.value]),
  );
  const byName = new Map();
  for (const property of existing) {
    if (typeof property?.name !== "string" || typeof property?.value !== "string") {
      throw new Error("root component property must contain string name/value");
    }
    if (byName.has(property.name)) throw new Error(`duplicate root property: ${property.name}`);
    if (property.name.startsWith("arcade-cabinet:") && !expectedByName.has(property.name)) {
      throw new Error(`unknown preexisting arcade-cabinet root property: ${property.name}`);
    }
    byName.set(property.name, property.value);
  }
  for (const property of expectedProperties) {
    if (byName.has(property.name) && byName.get(property.name) !== property.value) {
      throw new Error(`root property conflicts with release evidence: ${property.name}`);
    }
    if (!byName.has(property.name)) existing.push(property);
  }
  root.properties = existing;
}

function validateEvidenceInput({
  sourceSha,
  lockfileBlob,
  packageSourceSha256,
  releaseInputSha256,
  archives,
}) {
  requireHex(sourceSha, "source SHA", 40);
  requireHex(lockfileBlob, "lockfile blob", 40);
  requireHex(packageSourceSha256, "package source fingerprint", 64);
  requireHex(releaseInputSha256, "release-input fingerprint", 64);
  if (!Array.isArray(archives) || archives.length === 0) {
    throw new Error("at least one release archive identity is required");
  }
  const archiveNames = new Set();
  for (const archive of archives) {
    if (path.basename(archive.name) !== archive.name || archiveNames.has(archive.name)) {
      throw new Error(`archive name must be a unique basename: ${archive.name}`);
    }
    archiveNames.add(archive.name);
    requireHex(archive.sha256, `archive ${archive.name} SHA-256`, 64);
  }
}

function identityDigest(sbom) {
  const { properties: ignored, ...rootIdentity } = sbom.metadata.component;
  return sha256(canonical({ root: rootIdentity, components: sbom.components }));
}

function assertExactMandatoryProfile(
  admission,
  rootRef,
  componentCount,
  dependencyCount,
  componentIdentitySha256,
  dependencyAdjacencySha256,
) {
  if (!admission) throw new Error(`unsupported exact mandatory SBOM profile: ${rootRef}`);
  if (admission.profile !== SBOM_PROFILE || admission.rootPurl !== rootRef) {
    throw new Error(`SBOM admission identity drift for ${rootRef}`);
  }
  const expected = {
    componentCount: admission.componentCount,
    dependencyCount: admission.dependencyCount,
    componentIdentitySha256: admission.componentIdentitySha256,
    dependencyAdjacencySha256: admission.dependencyAdjacencySha256,
  };
  const actual = {
    componentCount,
    dependencyCount,
    componentIdentitySha256,
    dependencyAdjacencySha256,
  };
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`exact mandatory SBOM profile drift for ${rootRef}`);
  }
}

function evidenceProperties({
  sourceSha,
  sourceEpoch,
  lockfileBlob,
  packageSourceSha256,
  releaseInputSha256,
  archives,
  componentIdentitySha256,
  dependencyAdjacencySha256,
}) {
  return [
    { name: "arcade-cabinet:sbom-profile", value: SBOM_PROFILE },
    { name: "arcade-cabinet:source-sha", value: sourceSha },
    { name: "arcade-cabinet:source-epoch", value: String(sourceEpoch) },
    { name: "arcade-cabinet:lockfile-blob-sha1", value: lockfileBlob },
    { name: "arcade-cabinet:package-source-sha256", value: packageSourceSha256 },
    { name: "arcade-cabinet:release-input-sha256", value: releaseInputSha256 },
    { name: "arcade-cabinet:component-identity-sha256", value: componentIdentitySha256 },
    { name: "arcade-cabinet:dependency-adjacency-sha256", value: dependencyAdjacencySha256 },
    ...archives.map(({ name, sha256: archiveSha }) => ({
      name: `arcade-cabinet:archive-sha256:${name}`,
      value: archiveSha,
    })),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

export async function normalizeAndValidatePnpmSbom({
  inputPath,
  sourceSha,
  sourceEpoch,
  packageDirectory,
  workspaceRoot,
  registryUrl,
  admission,
  enforceAdmission = true,
  lockfileBlob,
  packageSourceSha256,
  releaseInputSha256,
  archives = [],
  forbiddenValues = [],
}) {
  validateEvidenceInput({
    sourceSha,
    lockfileBlob,
    packageSourceSha256,
    releaseInputSha256,
    archives,
  });
  const timestamp = stableTimestamp(sourceEpoch);
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  const raw = await readFile(inputPath, "utf8");
  await validateSchema(raw, "raw");
  const sbom = JSON.parse(raw);
  assertOnlyMetadataTimestamp(sbom);
  assertSafeStrings(sbom, forbiddenValues);
  const { root, rootRef } = assertRootIdentity(sbom, manifest, packageDirectory, workspaceRoot);
  const { componentsByRef } = validateGraph(sbom, rootRef, registryUrl);
  validateMandatoryProfile(sbom, manifest, rootRef, componentsByRef);

  const workspaceNames = await workspacePackageNames(workspaceRoot);
  workspaceNames.delete(manifest.name);
  for (const component of sbom.components) {
    if (workspaceNames.has(fullName(component))) {
      throw new Error(`workspace package leaked into mandatory graph: ${fullName(component)}`);
    }
  }

  normalizeSetOrdering(sbom);
  const componentIdentitySha256 = identityDigest(sbom);
  const dependencyAdjacencySha256 = sha256(canonical(sbom.dependencies));
  if (enforceAdmission) {
    assertExactMandatoryProfile(
      admission,
      rootRef,
      sbom.components.length,
      sbom.dependencies.length,
      componentIdentitySha256,
      dependencyAdjacencySha256,
    );
  }
  mergeRootProperties(
    root,
    evidenceProperties({
      sourceSha,
      sourceEpoch,
      lockfileBlob,
      packageSourceSha256,
      releaseInputSha256,
      archives,
      componentIdentitySha256,
      dependencyAdjacencySha256,
    }),
  );
  sbom.serialNumber = stableSerialNumber({ sourceSha, rootRef, lockfileBlob, archives });
  sbom.metadata.timestamp = timestamp;

  const bytes = `${canonical(sbom)}\n`;
  assertSafeStrings(sbom, forbiddenValues);
  await validateSchema(bytes, "normalized");
  const normalized = JSON.parse(bytes);
  const normalizedGraph = validateGraph(normalized, rootRef, registryUrl);
  validateMandatoryProfile(normalized, manifest, rootRef, normalizedGraph.componentsByRef);
  await writeFile(inputPath, bytes);
  return {
    packageName: manifest.name,
    version: manifest.version,
    rootRef,
    componentCount: normalized.components.length,
    dependencyCount: normalized.dependencies.length,
    serialNumber: normalized.serialNumber,
    sbomSha256: sha256(bytes),
    componentIdentitySha256,
    dependencyAdjacencySha256,
  };
}

async function assertCleanEnvironment(environment) {
  const configPaths = new Map();
  for (const [key, value] of Object.entries(environment)) {
    const lowerKey = key.toLowerCase();
    if (
      value &&
      (secretEnvironmentKey.test(key) ||
        forbiddenEnvironmentKey.test(key) ||
        credentialNpmConfigKey.test(key))
    ) {
      throw new Error(`refusing to invoke pnpm with credential-bearing environment key: ${key}`);
    }
    if (value && lowerKey.startsWith("npm_config_")) {
      assertSafeStrings(String(value), [], `environment.${key}`);
    }
    if (value && npmConfigPathKeys.has(lowerKey)) {
      const previous = configPaths.get(lowerKey);
      if (previous && previous !== value) {
        throw new Error(`conflicting npm config paths for ${key}`);
      }
      configPaths.set(lowerKey, value);
    }
  }
  for (const [key, configPath] of configPaths) {
    if (!path.isAbsolute(configPath)) throw new Error(`${key} must be an absolute path`);
    const contents = await readFile(configPath, "utf8");
    if (credentialNpmConfigText.test(contents)) {
      throw new Error(`npm config contains authentication material: ${key}`);
    }
    assertSafeStrings(contents, [], `environment.${key}.contents`);
  }
}

function canaryValues(environment) {
  return Object.entries(environment)
    .filter(([key, value]) => /(?:^|_)CANARY(?:_|$)/iu.test(key) && value)
    .map(([, value]) => String(value));
}

export async function generateAndValidatePnpmPackageSbom({
  outputPath,
  sourceSha,
  sourceEpoch,
  packageDirectory,
  workspaceRoot,
  registryUrl,
  admission,
  enforceAdmission = true,
  lockfileBlob,
  packageSourceSha256,
  releaseInputSha256,
  archives = [],
  pnpmExecutable = "pnpm",
  pnpmArgumentsPrefix = [],
  environment = process.env,
  execFileImpl = execute,
}) {
  if (process.version !== NODE_VERSION) {
    throw new Error(`private-package SBOM requires Node ${NODE_VERSION}, got ${process.version}`);
  }
  await assertCleanEnvironment(environment);
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  const versionResult = await execFileImpl(pnpmExecutable, [...pnpmArgumentsPrefix, "--version"], {
    cwd: workspaceRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (String(versionResult.stdout).trim() !== PNPM_VERSION) {
    throw new Error(`private-package SBOM requires pnpm ${PNPM_VERSION}`);
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "arcade-cabinet-pnpm-sbom-"));
  const normalizedRuns = [];
  const evidenceRuns = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const freshPath = path.join(scratch, `run-${index + 1}.cdx.json`);
      const args = [
        "--filter",
        manifest.name,
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
        freshPath,
      ];
      await execFileImpl(pnpmExecutable, [...pnpmArgumentsPrefix, ...args], {
        cwd: workspaceRoot,
        env: environment,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      evidenceRuns.push(
        await normalizeAndValidatePnpmSbom({
          inputPath: freshPath,
          sourceSha,
          sourceEpoch,
          packageDirectory,
          workspaceRoot,
          registryUrl,
          admission,
          enforceAdmission,
          lockfileBlob,
          packageSourceSha256,
          releaseInputSha256,
          archives,
          forbiddenValues: canaryValues(environment),
        }),
      );
      normalizedRuns.push(await readFile(freshPath, "utf8"));
    }
    if (normalizedRuns[1] !== normalizedRuns[0] || normalizedRuns[2] !== normalizedRuns[0]) {
      throw new Error("three independent pnpm SBOM generations were not byte-identical");
    }
    if (
      canonical(evidenceRuns[1]) !== canonical(evidenceRuns[0]) ||
      canonical(evidenceRuns[2]) !== canonical(evidenceRuns[0])
    ) {
      throw new Error("three independent pnpm SBOM evidence results disagreed");
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, normalizedRuns[0]);
    return evidenceRuns[0];
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

export function managedSbomPropertyNames() {
  return new Set(managedPropertyNames);
}
