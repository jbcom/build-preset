import { readFile, realpath } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import canonicalize from "canonicalize";
import npa from "npm-package-arg";
import semver from "semver";
import { assertSafeHttpsUrl } from "./config.mjs";
import { assertExactToolchain, runExactTool } from "./toolchain.mjs";

export const DEPENDENCY_CURRENT_PROFILE = "arcade-cabinet/dependency-current-config/v1";
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 30_000;
const MAX_GRAPH_PACKAGES = 4_096;
const MAX_GRAPH_EDGES = 32_768;
const relativePathPattern = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[A-Za-z0-9._/-]+$";
const scopedWildcardPattern = "^@[a-z0-9][a-z0-9-]*/\\*$";
const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "profile",
    "configPath",
    "manifestPath",
    "policy",
    "registries",
    "privateScopes",
    "forbiddenScopes",
    "rootPackages",
    "baselines",
    "requireInstalledSections",
    "manifestToolchain",
  ],
  properties: {
    profile: { const: DEPENDENCY_CURRENT_PROFILE },
    configPath: { type: "string", pattern: relativePathPattern },
    manifestPath: {
      anyOf: [{ const: "package.json" }, { type: "string", pattern: relativePathPattern }],
    },
    policy: {
      enum: ["public-runtime-closure", "private-scopes-and-roots"],
    },
    registries: {
      type: "object",
      additionalProperties: false,
      required: ["public", "scopes"],
      properties: {
        public: { $ref: "#/$defs/registry" },
        scopes: {
          type: "object",
          patternProperties: {
            "^@[a-z0-9][a-z0-9-]*$": { $ref: "#/$defs/registry" },
          },
          additionalProperties: false,
        },
      },
    },
    privateScopes: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
    },
    forbiddenScopes: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
    },
    rootPackages: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 214 },
    },
    baselines: {
      type: "object",
      propertyNames: { minLength: 1, maxLength: 214 },
      additionalProperties: { type: "string" },
    },
    requireInstalledSections: {
      type: "array",
      uniqueItems: true,
      items: {
        enum: ["dependencies", "devDependencies", "optionalDependencies"],
      },
    },
    manifestToolchain: {
      type: "object",
      additionalProperties: false,
      required: ["packageManager", "nodeEngine"],
      properties: {
        packageManager: { enum: ["absent", "pnpm@11.21.0"] },
        nodeEngine: { enum: ["24.x", ">=24", "24.19.0"] },
      },
    },
  },
  $defs: {
    registry: {
      type: "object",
      additionalProperties: false,
      required: ["url", "access"],
      properties: {
        url: { type: "string", format: "uri" },
        access: { enum: ["anonymous", "private-npm-token"] },
      },
    },
  },
};
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

function scopeOf(name) {
  return name.startsWith("@") ? name.slice(0, name.indexOf("/")) : null;
}

function packageMatches(name, pattern) {
  return pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

function assertExactPackageName(name, label) {
  let parsed;
  try {
    parsed = npa(name);
  } catch {
    throw new Error(`${label} is not a valid npm package name`);
  }
  if (!parsed.registry || parsed.rawSpec !== "*" || parsed.name !== name) {
    throw new Error(`${label} is not an exact npm package name`);
  }
}

export class DependencyCurrentPolicyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DependencyCurrentPolicyError";
    this.exitCode = 2;
  }
}

export class DependencyCurrentInfrastructureError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DependencyCurrentInfrastructureError";
    this.exitCode = 3;
  }
}

export function validateDependencyCurrentConfig(value) {
  if (!validateSchema(value)) {
    throw new Error(`invalid dependency-current config: ${ajv.errorsText(validateSchema.errors)}`);
  }
  const config = structuredClone(value);
  for (const configPath of [config.configPath, config.manifestPath]) {
    if (/\p{Cc}/u.test(configPath)) {
      throw new Error("dependency-current paths may not contain control characters");
    }
  }
  assertSafeHttpsUrl(config.registries.public.url, "public registry");
  if (
    config.registries.public.url !== "https://registry.npmjs.org/" ||
    config.registries.public.access !== "anonymous"
  ) {
    throw new Error("public registry must be the canonical npm registry");
  }
  for (const [scope, registry] of Object.entries(config.registries.scopes)) {
    const url = assertSafeHttpsUrl(registry.url, `${scope} registry`);
    if (!url.pathname.endsWith("/")) throw new Error(`${scope} registry must end with /`);
    if (url.pathname !== `/api/packages/${scope.slice(1)}/npm/`) {
      throw new Error(`${scope} registry path does not match its package owner`);
    }
    const canonical = {
      "@arcade-cabinet": {
        url: "https://registry.npmjs.org/",
        access: "anonymous",
      },
      "@jbcom": {
        url: "https://registry.npmjs.org/",
        access: "private-npm-token",
      },
    }[scope];
    if (!canonical || registry.url !== canonical.url || registry.access !== canonical.access) {
      throw new Error(`${scope} registry access is not an approved exact fleet endpoint`);
    }
  }
  const privateSet = new Set(config.privateScopes);
  if (
    config.policy === "public-runtime-closure" &&
    (config.privateScopes.length > 0 ||
      config.rootPackages.length > 0 ||
      Object.keys(config.baselines).length > 0)
  ) {
    throw new Error("public-runtime-closure cannot declare private/root/baseline selections");
  }
  if (
    config.policy === "public-runtime-closure" &&
    Object.keys(config.registries.scopes).length > 0
  ) {
    throw new Error("public-runtime-closure cannot declare private scope registries");
  }
  if (
    config.policy === "private-scopes-and-roots" &&
    (Object.keys(config.registries.scopes).length !== config.privateScopes.length ||
      Object.keys(config.registries.scopes).some((scope) => !privateSet.has(scope)))
  ) {
    throw new Error("private scope registry mapping must exactly match privateScopes");
  }
  if (
    config.policy === "private-scopes-and-roots" &&
    (config.privateScopes.length === 0 ||
      config.privateScopes.some((scope) => !config.registries.scopes[scope]))
  ) {
    throw new Error("private policy scopes require an exact configured registry");
  }
  if (config.forbiddenScopes.some((scope) => privateSet.has(scope))) {
    throw new Error("a dependency scope cannot be both private and forbidden");
  }
  for (const [name, version] of Object.entries(config.baselines)) {
    assertExactPackageName(name, `${name} baseline`);
    if (!semver.valid(version) || version !== semver.clean(version)) {
      throw new Error(`${name} baseline must be an exact published version`);
    }
  }
  for (const selection of config.rootPackages) {
    if (selection.endsWith("/*")) {
      if (!new RegExp(scopedWildcardPattern, "u").test(selection)) {
        throw new Error(`${selection} root package wildcard must be an exact @scope/* selector`);
      }
      try {
        assertExactPackageName(
          `${selection.slice(0, -1)}arcade-wildcard-probe`,
          `${selection} wildcard scope`,
        );
      } catch {
        throw new Error(`${selection} root package wildcard has an invalid npm scope`);
      }
    } else {
      assertExactPackageName(selection, `${selection} root package`);
    }
  }
  config.privateScopes.sort();
  config.forbiddenScopes.sort();
  config.rootPackages.sort();
  return config;
}

export async function loadDependencyCurrentConfig({ workspaceRoot, configPath }) {
  const root = await realpath(workspaceRoot);
  const absolute = path.resolve(root, configPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("dependency-current config must be inside the workspace");
  }
  const resolved = await realpath(absolute);
  if (resolved !== absolute)
    throw new Error("dependency-current config may not traverse a symlink");
  const config = validateDependencyCurrentConfig(JSON.parse(await readFile(absolute, "utf8")));
  if (config.configPath !== relative.split(path.sep).join("/")) {
    throw new Error("dependency-current configPath does not identify the loaded file");
  }
  return config;
}

export function installedPackageNames(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

export function collectRuntimeEdges(manifest, installedNames) {
  const isInstalled =
    typeof installedNames === "function" ? installedNames : (name) => installedNames.has(name);
  const edges = new Map();
  const skippedOptionalPeers = [];
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    edges.set(name, { kind: "dependency", name, spec });
  }
  for (const [name, spec] of Object.entries(manifest.optionalDependencies ?? {})) {
    edges.set(name, { kind: "optional-dependency", name, spec });
  }
  for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) {
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    if (!optional) {
      if (!edges.has(name)) edges.set(name, { kind: "required-peer", name, spec });
    } else if (isInstalled(name)) {
      if (!edges.has(name)) edges.set(name, { kind: "installed-optional-peer", name, spec });
    } else {
      skippedOptionalPeers.push(name);
    }
  }
  return {
    edges: [...edges.values()].sort((left, right) => left.name.localeCompare(right.name)),
    skippedOptionalPeers: skippedOptionalPeers.sort(),
  };
}

function assertRegistrySpec({ name, spec }, { exact }) {
  let parsed;
  try {
    parsed = npa.resolve(name, spec);
  } catch {
    throw new Error(`cannot prove ${name}@${String(spec)} against a package registry`);
  }
  if (!parsed.registry || !["version", "range"].includes(parsed.type)) {
    throw new Error(`cannot prove ${name}@${String(spec)} against a package registry`);
  }
  if (exact && (parsed.type !== "version" || !semver.valid(spec) || spec !== semver.clean(spec))) {
    throw new Error(`${name} must use an exact published version, found ${spec}`);
  }
  return parsed;
}

function directVersions(manifest) {
  const versions = new Map();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      const prior = versions.get(name);
      if (prior && prior !== version) {
        throw new Error(`${name} is declared as both ${prior} and ${version}`);
      }
      versions.set(name, version);
    }
  }
  for (const [name, peerRange] of Object.entries(manifest.peerDependencies ?? {})) {
    const adopted = versions.get(name);
    if (adopted === undefined) {
      versions.set(name, peerRange);
      continue;
    }
    if (
      !semver.valid(adopted) ||
      !semver.validRange(peerRange) ||
      !semver.satisfies(adopted, peerRange)
    ) {
      throw new Error(`${name} adoption ${adopted} does not satisfy peer contract ${peerRange}`);
    }
  }
  return versions;
}

export function createInstalledResolutionGraph(pnpmList) {
  const projects = Array.isArray(pnpmList) ? pnpmList : [pnpmList];
  if (projects.length !== 1 || !projects[0]?.name || !projects[0]?.version) {
    throw new Error("pnpm list must identify exactly one installed package project");
  }
  const project = projects[0];
  const rootIdentity = `${project.name}@${project.version}`;
  const resolutions = new Map();
  const observed = new Map();
  const visitedObjects = new Set();

  const remember = (ownerIdentity, dependencyName, version) => {
    if (!semver.valid(version)) {
      throw new Error(`${ownerIdentity} has an invalid installed ${dependencyName} version`);
    }
    const key = `${ownerIdentity}\0${dependencyName}`;
    const existing = observed.get(key) ?? new Set();
    existing.add(version);
    observed.set(key, existing);
    if (existing.size > 1) {
      throw new Error(
        `${ownerIdentity} resolves ${dependencyName} to conflicting installed versions`,
      );
    }
    resolutions.set(key, version);
  };

  const walk = (ownerIdentity, owner) => {
    if (!owner || typeof owner !== "object" || visitedObjects.has(owner)) return;
    visitedObjects.add(owner);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, child] of Object.entries(owner[section] ?? {})) {
        remember(ownerIdentity, name, child.version);
        walk(`${name}@${child.version}`, child);
      }
    }
  };
  walk(rootIdentity, project);
  return Object.freeze({
    rootIdentity,
    resolve(ownerIdentity, dependencyName) {
      return resolutions.get(`${ownerIdentity}\0${dependencyName}`) ?? null;
    },
  });
}

export async function verifyDependencyCurrent({
  manifest,
  installationManifest = manifest,
  installedNames,
  isInstalled,
  installedGraph,
  config,
  readMetadata,
}) {
  const installed = installedNames ?? installedPackageNames(installationManifest);
  const installedPredicate = isInstalled ?? ((name) => installed.has(name));
  const rootVersions = directVersions(manifest);
  const skipped = [];
  const verified = [];
  const traversed = new Set();
  const isPrivate = (name) => config.privateScopes.includes(scopeOf(name));
  const forbidden = (name) => config.forbiddenScopes.includes(scopeOf(name));
  for (const name of directVersions(manifest).keys()) {
    if (forbidden(name)) {
      throw new Error(`dependency-current refuses direct forbidden dependency ${name}`);
    }
  }

  let queue;
  if (config.policy === "public-runtime-closure") {
    const initial = collectRuntimeEdges(manifest, installedPredicate);
    queue = initial.edges.map((edge) => ({
      ...edge,
      depth: 0,
      owner: manifest.name,
      ownerIdentity: installedGraph?.rootIdentity ?? `${manifest.name}@${manifest.version}`,
      ownerPath: "$",
    }));
    skipped.push(...initial.skippedOptionalPeers.map((name) => `${manifest.name} -> ${name}`));
  } else {
    queue = [];
    for (const [name, spec] of rootVersions) {
      if (isPrivate(name) || config.rootPackages.some((pattern) => packageMatches(name, pattern))) {
        queue.push({
          kind: isPrivate(name) ? "private" : "root-package",
          name,
          spec,
          depth: 0,
          owner: manifest.name,
          ownerIdentity: installedGraph?.rootIdentity ?? `${manifest.name}@${manifest.version}`,
          ownerPath: "$",
        });
      }
    }
    for (const [name, spec] of Object.entries(config.baselines)) {
      queue.push({
        kind: "baseline",
        name,
        spec,
        depth: 0,
        owner: "configured baseline",
        ownerIdentity: installedGraph?.rootIdentity ?? `${manifest.name}@${manifest.version}`,
        ownerPath: "$",
      });
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (queue.length > MAX_GRAPH_EDGES) {
      throw new Error(`dependency graph exceeds ${MAX_GRAPH_EDGES} edges`);
    }
    const edge = queue[cursor];
    const exact = config.policy === "private-scopes-and-roots";
    if (forbidden(edge.name)) {
      throw new Error(`dependency-current refuses private/forbidden edge ${edge.name}`);
    }
    const parsedSpec = assertRegistrySpec(edge, { exact });
    const registry = config.registries.scopes[scopeOf(edge.name)] ?? config.registries.public;
    const metadata = await readMetadata(edge.name, registry);
    const latest = metadata?.["dist-tags"]?.latest;
    if (!semver.valid(latest)) throw new Error(`${edge.name} has no readable latest dist-tag`);
    const versions = Object.keys(metadata?.versions ?? {}).filter((version) =>
      semver.valid(version),
    );
    const selected =
      parsedSpec.type === "version"
        ? semver.clean(parsedSpec.fetchSpec)
        : semver.maxSatisfying(versions, parsedSpec.fetchSpec);
    if (!selected) {
      throw new Error(`${edge.name}@${edge.spec} does not select a published registry version`);
    }
    const mustSelectGlobalLatest = config.policy === "private-scopes-and-roots" || edge.depth === 0;
    if (mustSelectGlobalLatest && selected !== latest) {
      throw new Error(
        `${edge.owner} ${edge.kind} ${edge.name}@${edge.spec} selects ${selected}; latest is ${latest}`,
      );
    }
    const installedVersion = installedGraph?.resolve(edge.ownerIdentity, edge.name);
    if (installedGraph && edge.kind !== "baseline" && installedVersion !== selected) {
      throw new Error(
        `${edge.ownerPath} -> ${edge.name}@${edge.spec} selects ${selected}; ` +
          `frozen install resolves ${installedVersion ?? "<missing>"}`,
      );
    }
    const installPath = `${edge.ownerPath}>${edge.name}@${selected}`;
    verified.push({ ...edge, installPath, latest, selected });
    const identity = `${edge.name}@${selected}`;
    if (traversed.has(identity)) continue;
    traversed.add(identity);
    if (traversed.size > MAX_GRAPH_PACKAGES) {
      throw new Error(`dependency graph exceeds ${MAX_GRAPH_PACKAGES} packages`);
    }
    const publishedManifest = metadata?.versions?.[selected];
    if (!publishedManifest) throw new Error(`${identity} has no readable published manifest`);

    if (config.policy === "public-runtime-closure") {
      const nested = collectRuntimeEdges(
        publishedManifest,
        installedGraph
          ? (name) => installedGraph.resolve(identity, name) !== null
          : installedPredicate,
      );
      queue.push(
        ...nested.edges.map((child) => {
          const rootSpec = child.kind.includes("peer") ? rootVersions.get(child.name) : undefined;
          if (
            rootSpec &&
            (!semver.validRange(rootSpec) ||
              !semver.validRange(child.spec) ||
              !semver.intersects(rootSpec, child.spec))
          ) {
            throw new Error(
              `${identity} peer ${child.name}@${child.spec} conflicts with root adoption ${rootSpec}`,
            );
          }
          return {
            ...child,
            ...(rootSpec ? { peerSpec: child.spec, spec: rootSpec } : {}),
            depth: edge.depth + 1,
            owner: identity,
            ownerIdentity: identity,
            ownerPath: installPath,
          };
        }),
      );
      skipped.push(...nested.skippedOptionalPeers.map((name) => `${identity} -> ${name}`));
    } else if (isPrivate(edge.name)) {
      const nested = collectRuntimeEdges(
        publishedManifest,
        installedGraph
          ? (name) => installedGraph.resolve(identity, name) !== null
          : new Set(rootVersions.keys()),
      );
      for (const child of nested.edges) {
        if (child.kind === "required-peer") {
          const rootVersion = rootVersions.get(child.name);
          if (!rootVersion) {
            if (child.kind === "required-peer") {
              throw new Error(
                `${identity} requires peer ${child.name}@${child.spec}, but the root does not declare it`,
              );
            }
            continue;
          }
          if (
            !semver.valid(rootVersion) ||
            !semver.satisfies(rootVersion, child.spec, { includePrerelease: true })
          ) {
            throw new Error(
              `${identity} requires peer ${child.name}@${child.spec}, but root adopts ${rootVersion}`,
            );
          }
          queue.push({
            ...child,
            spec: rootVersion,
            depth: edge.depth + 1,
            owner: identity,
            ownerIdentity: identity,
            ownerPath: installPath,
          });
        } else if (child.kind === "installed-optional-peer") {
          const adopted = installedGraph?.resolve(identity, child.name);
          if (!adopted) continue;
          if (!semver.satisfies(adopted, child.spec)) {
            throw new Error(
              `${identity} optional peer ${child.name}@${child.spec} conflicts with installed ${adopted}`,
            );
          }
          queue.push({
            ...child,
            spec: adopted,
            depth: edge.depth + 1,
            owner: identity,
            ownerIdentity: identity,
            ownerPath: installPath,
          });
        } else {
          queue.push({
            ...child,
            depth: edge.depth + 1,
            owner: identity,
            ownerIdentity: identity,
            ownerPath: installPath,
          });
        }
      }
      skipped.push(...nested.skippedOptionalPeers.map((name) => `${identity} -> ${name}`));
    }
  }
  verified.sort((left, right) =>
    `${left.owner}/${left.name}`.localeCompare(`${right.owner}/${right.name}`),
  );
  skipped.sort();
  return { verified, skipped, packageCount: traversed.size };
}

async function readInstalledManifest(workspaceRoot, manifestPath) {
  const absolute = path.resolve(workspaceRoot, manifestPath);
  const resolved = await realpath(absolute);
  if (resolved !== absolute || !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("dependency manifest escapes the workspace or traverses a symlink");
  }
  return { absolutePath: resolved, manifest: JSON.parse(await readFile(resolved, "utf8")) };
}

function registryDocumentUrl(packageName, registry) {
  const base = new URL(registry.url);
  const escapedName = encodeURIComponent(packageName).replace(/^%40/u, "@");
  const url = new URL(escapedName, base);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(`registry URL construction escaped configured origin/path for ${packageName}`);
  }
  return url;
}

function assertRegistryReadRoute(packageName, registry) {
  const parsed = npa(packageName);
  if (!parsed.registry || parsed.rawSpec !== "*" || parsed.name !== packageName) {
    throw new DependencyCurrentPolicyError(`invalid registry package name: ${packageName}`);
  }
  const scope = scopeOf(packageName);
  if (
    !["@arcade-cabinet", "@jbcom"].includes(scope) &&
    registry.url === "https://registry.npmjs.org/" &&
    registry.access === "anonymous"
  ) {
    return;
  }
  if (
    scope === "@arcade-cabinet" &&
    registry.url === "https://registry.npmjs.org/" &&
    registry.access === "anonymous"
  ) {
    return;
  }
  if (
    scope === "@jbcom" &&
    registry.url === "https://registry.npmjs.org/" &&
    registry.access === "private-npm-token"
  ) {
    return;
  }
  throw new DependencyCurrentPolicyError(`registry route is not approved for ${packageName}`);
}

async function boundedJson(response, label, maxMetadataBytes = MAX_METADATA_BYTES) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxMetadataBytes) {
    await response.body?.cancel("metadata size limit exceeded");
    throw new DependencyCurrentInfrastructureError(`${label} exceeds the metadata size limit`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/json" && contentType !== "application/vnd.npm.install-v1+json") {
    await response.body?.cancel("invalid metadata content type");
    throw new DependencyCurrentInfrastructureError(`${label} returned an invalid content type`);
  }
  if (!response.body) {
    throw new DependencyCurrentInfrastructureError(`${label} returned an empty body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxMetadataBytes) {
        await reader.cancel("metadata size limit exceeded");
        throw new DependencyCurrentInfrastructureError(`${label} exceeds the metadata size limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel("metadata stream failed").catch(() => {});
    if (error instanceof DependencyCurrentInfrastructureError) throw error;
    throw new DependencyCurrentInfrastructureError(`${label} stream failed`, {
      cause: error,
    });
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DependencyCurrentInfrastructureError(`${label} did not return JSON`);
  }
}

export function createRegistryMetadataReader({
  environment = process.env,
  fetchImplementation = fetch,
  timeoutMs = METADATA_TIMEOUT_MS,
  maxMetadataBytes = MAX_METADATA_BYTES,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > METADATA_TIMEOUT_MS) {
    throw new DependencyCurrentPolicyError("invalid registry metadata timeout");
  }
  if (
    !Number.isInteger(maxMetadataBytes) ||
    maxMetadataBytes < 1 ||
    maxMetadataBytes > MAX_METADATA_BYTES
  ) {
    throw new DependencyCurrentPolicyError("invalid registry metadata byte limit");
  }
  const cache = new Map();
  return async (packageName, registry) => {
    assertRegistryReadRoute(packageName, registry);
    const url = registryDocumentUrl(packageName, registry);
    const cacheKey = `${registry.access}:${url.href}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const headers = { accept: "application/vnd.npm.install-v1+json, application/json" };
    if (registry.access === "private-npm-token") {
      const token = environment.PRIVATE_NPM_TOKEN;
      if (!token) {
        throw new DependencyCurrentInfrastructureError(
          `PRIVATE_NPM_TOKEN is required for ${packageName}`,
        );
      }
      headers.authorization = `Bearer ${token}`;
    }
    const promise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await fetchImplementation(url, {
            method: "GET",
            redirect: "manual",
            headers,
            signal: controller.signal,
          });
        } catch (error) {
          throw new DependencyCurrentInfrastructureError(
            `registry metadata GET failed for ${packageName}`,
            { cause: error },
          );
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel("redirect refused");
          throw new DependencyCurrentInfrastructureError(
            `registry redirect refused for ${packageName}`,
          );
        }
        if (!response.ok) {
          await response.body?.cancel("non-success response");
          throw new DependencyCurrentInfrastructureError(
            `registry metadata GET failed for ${packageName}: HTTP ${response.status}`,
          );
        }
        if (response.url && response.url !== url.href) {
          await response.body?.cancel("response URL changed");
          throw new DependencyCurrentInfrastructureError(
            `registry response origin/path changed for ${packageName}`,
          );
        }
        return await boundedJson(response, `${packageName} registry metadata`, maxMetadataBytes);
      } finally {
        clearTimeout(timeout);
      }
    })();
    cache.set(cacheKey, promise);
    try {
      return await promise;
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    }
  };
}

export async function runDependencyCurrent({
  workspaceRoot = process.cwd(),
  configPath,
  environment = process.env,
  fetchImplementation = fetch,
  runCommand,
  toolchain,
}) {
  const root = await realpath(workspaceRoot);
  let config;
  try {
    config = await loadDependencyCurrentConfig({ workspaceRoot: root, configPath });
    toolchain = await assertExactToolchain(root, runCommand, toolchain);
  } catch (error) {
    if (error instanceof DependencyCurrentInfrastructureError) throw error;
    throw new DependencyCurrentPolicyError(error.message, { cause: error });
  }
  const { absolutePath: manifestAbsolutePath, manifest } = await readInstalledManifest(
    root,
    config.manifestPath,
  );
  const installationManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (
    config.manifestToolchain.packageManager === "absent"
      ? installationManifest.packageManager !== undefined
      : installationManifest.packageManager !== config.manifestToolchain.packageManager
  ) {
    throw new Error("root packageManager does not match dependency-current config");
  }
  if (installationManifest.engines?.node !== config.manifestToolchain.nodeEngine) {
    throw new Error("root Node engine does not match dependency-current config");
  }
  const requireFromTarget = createRequire(manifestAbsolutePath);
  const isInstalled = (name) => {
    try {
      const installedManifest = findPackageJSON(name, pathToFileURL(manifestAbsolutePath).href);
      if (installedManifest) return true;
    } catch {
      // Fall through to CommonJS-compatible resolution for packages without ESM metadata.
    }
    try {
      requireFromTarget.resolve(name);
      return true;
    } catch {
      try {
        requireFromTarget.resolve(`${name}/package.json`);
        return true;
      } catch {
        return false;
      }
    }
  };
  for (const section of config.requireInstalledSections) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (!isInstalled(name)) {
        throw new Error(`${name} is declared in ${section} but is not installed`);
      }
    }
  }
  const readMetadata = createRegistryMetadataReader({ environment, fetchImplementation });
  let installedGraph;
  try {
    const { stdout } = await runExactTool(
      toolchain,
      "pnpm",
      ["--filter", manifest.name, "list", "--depth", "Infinity", "--json"],
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      runCommand,
    );
    installedGraph = createInstalledResolutionGraph(JSON.parse(stdout));
  } catch (error) {
    throw new DependencyCurrentPolicyError("cannot prove the frozen installed dependency graph", {
      cause: error,
    });
  }
  try {
    return await verifyDependencyCurrent({
      manifest,
      installationManifest,
      isInstalled,
      installedGraph,
      config,
      readMetadata,
    });
  } catch (error) {
    if (error instanceof DependencyCurrentInfrastructureError) throw error;
    throw new DependencyCurrentPolicyError(error.message, { cause: error });
  }
}

export async function dependencyCurrentMain(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");
  if (positional.length !== 2 || positional[0] !== "--config") {
    throw new DependencyCurrentPolicyError(
      "usage: build-preset dependency-current --config <path> [--json]",
    );
  }
  const result = await runDependencyCurrent({ configPath: positional[1] });
  if (json) {
    process.stdout.write(
      `${canonicalize({
        packageCount: result.packageCount,
        profile: DEPENDENCY_CURRENT_PROFILE,
        skipped: result.skipped,
        verified: result.verified,
      })}\n`,
    );
    return;
  }
  for (const edge of result.verified) {
    process.stdout.write(`CURRENT ${edge.owner} ${edge.kind} ${edge.name}@${edge.latest}\n`);
  }
  for (const description of result.skipped) {
    process.stdout.write(`SKIP uninstalled optional peer ${description}\n`);
  }
  process.stdout.write(
    `Dependency-current closure passed: ${result.verified.length} edge(s), ${result.packageCount} package(s).\n`,
  );
}
