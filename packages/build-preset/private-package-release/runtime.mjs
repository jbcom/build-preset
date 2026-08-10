import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnonymousEnvironment } from "./anonymous-environment.mjs";
import { SBOM_PROFILE } from "./config.mjs";
import { prepareAnonymousCorepackEnvironment } from "./corepack-environment.mjs";
import { computeReleaseInput, createGitClient } from "./fingerprint.mjs";
import { generateAndValidatePnpmPackageSbom } from "./sbom.mjs";
import { assertCreatedRelease } from "./state.mjs";
import { assertExactToolchain, resolveExactToolchain, runExactTool } from "./toolchain.mjs";

const MAX_BUFFER = 32 * 1024 * 1024;
const CREDENTIAL_ENVIRONMENT_KEY =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)(?:_|$)|^GITEA(?:_|$)/iu;
const VCS_CONTROL_DIRECTORIES = new Set([".git", ".hg", ".jj", ".svn"]);

function assertSafeUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment`);
  }
  return url;
}

function requireEnvironment(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function run(command, args, options = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)(command, args, { maxBuffer: MAX_BUFFER, ...options });
}

function outputJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

function isContained(root, target, { allowRoot = false } = {}) {
  const relative = path.relative(root, target);
  return (
    (allowRoot || relative !== "") &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function packageRelative(packageDirectory, repositoryPath) {
  if (packageDirectory === ".") return repositoryPath;
  const prefix = `${packageDirectory}/`;
  return repositoryPath.startsWith(prefix) ? repositoryPath.slice(prefix.length) : null;
}

function assertSafePackPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    /\p{Cc}/u.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`npm pack reported an unsafe archive path: ${String(value)}`);
  }
}

export function assertPackedFileSet({
  packageDirectory,
  generatedPaths,
  trackedFiles,
  packedFiles,
}) {
  const tracked = new Set(
    trackedFiles
      .map((file) => packageRelative(packageDirectory, file))
      .filter((file) => file !== null),
  );
  const generated = generatedPaths.map((file) => packageRelative(packageDirectory, file));
  if (generated.some((file) => file === null || file === "")) {
    throw new Error("generated output root is outside the package");
  }
  const packed = packedFiles.map((entry) => (typeof entry === "string" ? entry : entry?.path));
  if (new Set(packed).size !== packed.length) {
    throw new Error("npm pack reported duplicate archive paths");
  }
  for (const file of packed) {
    assertSafePackPath(file);
    const generatedFile = generated.some((root) => file === root || file.startsWith(`${root}/`));
    if (!tracked.has(file) && !generatedFile) {
      throw new Error(`npm pack included an unbound file: ${file}`);
    }
  }
  for (const root of generated) {
    if (!packed.some((file) => file === root || file.startsWith(`${root}/`))) {
      throw new Error(`npm pack omitted every file from generated output root: ${root}`);
    }
  }
}

async function assertCanonicalExistingAncestor(target, floor, label) {
  let current = target;
  while (isContained(floor, current, { allowRoot: true })) {
    try {
      const resolved = await realpath(current);
      if (resolved !== current) throw new Error(`${label} traverses a symlink`);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === floor) break;
    current = path.dirname(current);
  }
  throw new Error(`${label} has no canonical ancestor inside its package`);
}

async function assertGeneratedTreeNoSymlinks(target, label) {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
  if (!metadata.isDirectory()) {
    if (!metadata.isFile()) throw new Error(`${label} contains a non-regular file`);
    return;
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
    if (entry.isDirectory()) await assertGeneratedTreeNoSymlinks(child, label);
  }
}

async function assertTrackedPackageBytes(workspaceRoot, spec, runCommand) {
  const files = await trackedWorkspaceFiles(workspaceRoot, spec, runCommand);
  for (const file of files) {
    let current;
    try {
      current = await readFile(path.resolve(workspaceRoot, file));
    } catch {
      throw new Error(`tracked package source is not a regular file after build: ${file}`);
    }
    const { stdout } = await runCommand("git", ["show", `HEAD:${file}`], {
      cwd: workspaceRoot,
      encoding: null,
      maxBuffer: MAX_BUFFER,
    });
    if (!current.equals(Buffer.from(stdout))) {
      throw new Error(`tracked package source bytes changed during build: ${file}`);
    }
  }
}

async function cleanAndBuildPackage({
  workspaceRoot,
  packageDirectory,
  spec,
  toolchain,
  runCommand,
  environment,
}) {
  const { stdout: headBeforeOutput } = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    maxBuffer: MAX_BUFFER,
  });
  const headBefore = Buffer.from(headBeforeOutput).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/u.test(headBefore)) {
    throw new Error("package build source HEAD is not a full Git commit SHA");
  }
  const generated = spec.generatedPaths.map((configuredPath) => {
    if (
      path.posix.normalize(configuredPath) !== configuredPath ||
      configuredPath
        .split("/")
        .some((segment) => VCS_CONTROL_DIRECTORIES.has(segment.toLowerCase()))
    ) {
      throw new Error(`${spec.id} generated output path is not canonical and safe`);
    }
    const target = path.resolve(workspaceRoot, configuredPath);
    if (!isContained(packageDirectory, target)) {
      throw new Error(`${spec.id} generated output escapes its package: ${configuredPath}`);
    }
    return { configuredPath, target };
  });
  for (const { configuredPath, target } of generated) {
    await assertCanonicalExistingAncestor(target, packageDirectory, configuredPath);
    const tracked = await runCommand("git", ["ls-files", "-z", "--", configuredPath], {
      cwd: workspaceRoot,
      maxBuffer: MAX_BUFFER,
    });
    if (Buffer.from(tracked.stdout).length > 0) {
      throw new Error(`generated output contains tracked files: ${configuredPath}`);
    }
    try {
      await runCommand("git", ["check-ignore", "--no-index", "--quiet", "--", configuredPath], {
        cwd: workspaceRoot,
        maxBuffer: MAX_BUFFER,
      });
    } catch (error) {
      if (error?.code === 1) {
        throw new Error(`generated output must be Git-ignored: ${configuredPath}`);
      }
      throw error;
    }
  }
  const statusBefore = await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: workspaceRoot,
    maxBuffer: MAX_BUFFER,
  });
  if (Buffer.from(statusBefore.stdout).length > 0) {
    throw new Error("package build requires a clean Git worktree");
  }
  for (const { target } of generated) {
    await rm(target, { recursive: true, force: true });
  }
  await runExactTool(
    toolchain,
    "pnpm",
    ["--dir", packageDirectory, "run", "build"],
    { cwd: workspaceRoot, env: environment },
    runCommand,
  );
  for (const { configuredPath, target } of generated) {
    let resolved;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`build did not recreate generated output: ${configuredPath}`);
      }
      throw error;
    }
    if (resolved !== target || !isContained(packageDirectory, resolved)) {
      throw new Error(`generated output traverses a symlink: ${configuredPath}`);
    }
    await assertGeneratedTreeNoSymlinks(target, configuredPath);
  }
  const { stdout: headAfterOutput } = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    maxBuffer: MAX_BUFFER,
  });
  if (Buffer.from(headAfterOutput).toString("utf8").trim() !== headBefore) {
    throw new Error("package build changed the exact source HEAD");
  }
  await assertTrackedPackageBytes(workspaceRoot, spec, runCommand);
  const statusAfter = await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: workspaceRoot,
    maxBuffer: MAX_BUFFER,
  });
  if (Buffer.from(statusAfter.stdout).length > 0) {
    throw new Error("package build modified files outside ignored generated outputs");
  }
}

async function trackedWorkspaceFiles(workspaceRoot, spec, runCommand) {
  const { stdout } = await runCommand("git", ["ls-files", "-z", "--", spec.directory], {
    cwd: workspaceRoot,
    maxBuffer: MAX_BUFFER,
  });
  return Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
}

function isNotFound(error) {
  const text = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  return error?.code === 1 && /(?:E404|404 Not Found)/u.test(text);
}

function releaseAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    downloadUrl: asset.browser_download_url ?? asset.download_url,
  };
}

function releaseRecord(release) {
  return {
    id: release.id,
    tagName: release.tag_name,
    name: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    targetCommitish: release.target_commitish,
    assets: (release.assets ?? []).map(releaseAsset),
  };
}

export async function assertExactReleaseRuntime(
  workspaceRoot = process.cwd(),
  runCommand = run,
  toolchain,
) {
  return assertExactToolchain(workspaceRoot, runCommand, toolchain);
}

export async function assertExactLocalSource(
  sourceSha,
  workspaceRoot = process.cwd(),
  git = createGitClient(workspaceRoot),
) {
  const [head, status] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("status", "--porcelain", "--untracked-files=all"),
  ]);
  if (head !== sourceSha)
    throw new Error(`local HEAD ${head} is not requested source ${sourceSha}`);
  if (status) throw new Error(`release checkout is dirty:\n${status}`);
}

export async function assertVerifierDependencyBinding({
  workspaceRoot = process.cwd(),
  verifier,
  runCommand = run,
  toolchain,
}) {
  toolchain ??= await resolveExactToolchain();
  const root = await realpath(workspaceRoot);
  const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const specs = ["dependencies", "devDependencies", "optionalDependencies"]
    .map((section) => rootManifest[section]?.[verifier.packageName])
    .filter((value) => value !== undefined);
  if (specs.length !== 1) {
    throw new Error(`root manifest must declare exactly one ${verifier.packageName} dependency`);
  }
  if (![verifier.version, `workspace:${verifier.version}`].includes(specs[0])) {
    throw new Error(
      `root manifest verifier spec ${specs[0]} does not exactly bind ${verifier.version}`,
    );
  }
  const result = await runExactTool(
    toolchain,
    "pnpm",
    ["list", verifier.packageName, "--depth=0", "--json"],
    { cwd: root },
    runCommand,
  );
  const payload = outputJson(result.stdout, "pnpm verifier dependency listing");
  const projects = Array.isArray(payload) ? payload : [payload];
  const rootProjects = projects.filter((candidate) => candidate?.path === root);
  if (rootProjects.length !== 1) {
    throw new Error("pnpm verifier dependency listing did not identify the exact workspace root");
  }
  const project = rootProjects[0];
  const installed =
    project?.dependencies?.[verifier.packageName] ??
    project?.devDependencies?.[verifier.packageName] ??
    project?.optionalDependencies?.[verifier.packageName];
  if (!installed || typeof installed !== "object") {
    throw new Error(`installed verifier ${verifier.packageName} is missing`);
  }
  if (
    typeof installed.path !== "string" ||
    !path.isAbsolute(installed.path) ||
    path.resolve(installed.path) !== installed.path
  ) {
    throw new Error("installed verifier path must be absolute and canonical");
  }
  const installedPath = await realpath(installed.path);
  if (installedPath !== installed.path || !isContained(root, installedPath)) {
    throw new Error("installed verifier path escapes the workspace or traverses a symlink");
  }
  const expectedPackageRoot = await realpath(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  );
  if (installedPath !== expectedPackageRoot) {
    throw new Error("installed verifier does not resolve to the executing package root");
  }
  const installedMetadata = await lstat(installedPath);
  if (!installedMetadata.isDirectory())
    throw new Error("installed verifier path is not a directory");
  const manifestPath = path.join(installedPath, "package.json");
  if ((await realpath(manifestPath)) !== manifestPath) {
    throw new Error("installed verifier manifest traverses a symlink");
  }
  const installedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    installedManifest.name !== verifier.packageName ||
    installedManifest.version !== verifier.version
  ) {
    throw new Error(
      `installed verifier manifest does not equal ${verifier.packageName}@${verifier.version}`,
    );
  }
  const linked =
    typeof installed.version === "string" && /^(?:link|workspace):/u.test(installed.version);
  if (linked) {
    if (specs[0] !== `workspace:${verifier.version}`) {
      throw new Error("linked verifier requires the exact matching workspace root spec");
    }
  } else if (installed.version !== verifier.version) {
    throw new Error(
      `installed verifier ${installed.version ?? "<missing>"} does not equal ${verifier.version}`,
    );
  }
}

export function assertCredentialFreeEnvironment(environment = process.env) {
  for (const [key, value] of Object.entries(environment)) {
    if (value && (CREDENTIAL_ENVIRONMENT_KEY.test(key) || /^(?:ACTIONS_|RUNNER_)/iu.test(key))) {
      throw new Error(
        `credential/runtime-bearing environment is forbidden for profile-sbom: ${key}`,
      );
    }
  }
}

export async function profilePackageAdmission({
  workspaceRoot = process.cwd(),
  sourceSha,
  spec,
  config,
  toolchain,
  runCommand = run,
  environment = process.env,
}) {
  toolchain ??= await resolveExactToolchain();
  assertCredentialFreeEnvironment(environment);
  const root = await realpath(workspaceRoot);
  const requestedPackage = path.resolve(root, spec.directory);
  const packageDirectory = await realpath(requestedPackage);
  const packageRelative = path.relative(root, packageDirectory);
  if (
    (packageRelative !== "" && packageRelative.startsWith(`..${path.sep}`)) ||
    path.isAbsolute(packageRelative) ||
    requestedPackage !== packageDirectory
  ) {
    throw new Error("profile package directory escapes the workspace or traverses a symlink");
  }
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  if (manifest.name !== spec.name) throw new Error("profile package manifest name mismatch");
  if (typeof manifest.scripts?.build !== "string" || manifest.scripts.build.length === 0) {
    throw new Error("profile package must declare a deterministic build script");
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "build-preset-profile-sbom-"));
  const anonymousHome = path.join(scratch, "anonymous-home");
  const userConfig = path.join(anonymousHome, "user.npmrc");
  await mkdir(anonymousHome, { recursive: true });
  await writeFile(userConfig, `${config.registry.scope}:registry=${config.registry.url}\n`, {
    mode: 0o600,
  });
  const anonymousEnvironment = await prepareAnonymousCorepackEnvironment({
    home: anonymousHome,
    userConfig,
    baseEnv: environment,
    toolchain,
    runCommand,
  });
  const trackedFiles = await trackedWorkspaceFiles(root, spec, runCommand);
  const pack = async (destination) => {
    await cleanAndBuildPackage({
      workspaceRoot: root,
      packageDirectory,
      spec,
      toolchain,
      runCommand,
      environment: anonymousEnvironment,
    });
    await mkdir(destination, { recursive: true });
    const { stdout } = await runExactTool(
      toolchain,
      "npm",
      ["pack", "--pack-destination", destination, "--json", "--ignore-scripts"],
      { cwd: packageDirectory, env: anonymousEnvironment },
      runCommand,
    );
    const names = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
    const reports = outputJson(stdout, "profile npm pack report");
    if (
      names.length !== 1 ||
      !Array.isArray(reports) ||
      reports.length !== 1 ||
      reports[0]?.filename !== names[0] ||
      !Array.isArray(reports[0]?.files)
    ) {
      throw new Error("profile npm pack did not create exactly one reported archive");
    }
    assertPackedFileSet({
      packageDirectory: spec.directory,
      generatedPaths: spec.generatedPaths,
      trackedFiles,
      packedFiles: reports[0].files,
    });
    return { name: names[0], bytes: await readFile(path.join(destination, names[0])) };
  };
  try {
    const first = await pack(path.join(scratch, "pack-one"));
    const second = await pack(path.join(scratch, "pack-two"));
    if (first.name !== second.name || !first.bytes.equals(second.bytes)) {
      throw new Error("profile npm pack bytes are not reproducible");
    }
    const releaseInput = await computeReleaseInput({
      sourceSha,
      packageDirectory: spec.directory,
      sourcePaths: spec.sourcePaths,
      configPath: config.configPath,
      workflowPath: config.workflowPath,
      releaseInputPaths: config.releaseInputPaths,
      git: createGitClient(root),
    });
    const sbomPath = path.join(scratch, "profile.cdx.json");
    const evidence = await generateAndValidatePnpmPackageSbom({
      outputPath: sbomPath,
      sourceSha,
      sourceEpoch: releaseInput.sourceEpoch,
      packageDirectory,
      workspaceRoot: root,
      registryUrl: config.registry.url,
      admission: null,
      enforceAdmission: false,
      lockfileBlob: releaseInput.lockfileBlob,
      packageSourceSha256: releaseInput.packageSourceSha256,
      releaseInputSha256: releaseInput.releaseInputSha256,
      archives: [
        { name: first.name, sha256: createHash("sha256").update(first.bytes).digest("hex") },
      ],
      pnpmExecutable: toolchain.nodeExecutable,
      pnpmArgumentsPrefix: [toolchain.pnpmCli],
      environment: anonymousEnvironment,
    });
    return {
      profile: SBOM_PROFILE,
      rootPurl: evidence.rootRef,
      componentCount: evidence.componentCount,
      dependencyCount: evidence.dependencyCount,
      componentIdentitySha256: evidence.componentIdentitySha256,
      dependencyAdjacencySha256: evidence.dependencyAdjacencySha256,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function createRuntimeClients({
  workspaceRoot = process.cwd(),
  runCommand = run,
  fetchImplementation = fetch,
  environment = process.env,
  config,
  toolchain,
} = {}) {
  toolchain ??= await resolveExactToolchain();
  workspaceRoot = await realpath(workspaceRoot);
  const registryUrl = assertSafeUrl(
    requireEnvironment("REGISTRY_URL", environment),
    "REGISTRY_URL",
  );
  if (registryUrl.href !== config?.registry?.url) {
    throw new Error("REGISTRY_URL does not match the committed release config");
  }
  const giteaServer = assertSafeUrl(
    requireEnvironment("GITEA_SERVER_URL", environment),
    "GITEA_SERVER_URL",
  );
  if (
    giteaServer.origin !== registryUrl.origin ||
    giteaServer.pathname !== "/" ||
    giteaServer.href !== `${registryUrl.origin}/`
  ) {
    throw new Error("GITEA_SERVER_URL does not match the committed registry origin");
  }
  const repository = requireEnvironment("GITEA_REPOSITORY", environment);
  if (repository !== config?.repository) {
    throw new Error("GITEA_REPOSITORY does not match the committed release config");
  }
  const repositoryParts = repository.split("/");
  if (
    repositoryParts.length !== 2 ||
    !repositoryParts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part))
  ) {
    throw new Error("invalid GITEA_REPOSITORY");
  }
  const giteaToken = requireEnvironment("GITEA_TOKEN", environment);
  const encodedRepository = repositoryParts.map(encodeURIComponent).join("/");
  const apiRoot = `${giteaServer.href.replace(/\/$/u, "")}/api/v1/repos/${encodedRepository}`;
  const scratchParent = environment.RUNNER_TEMP ?? tmpdir();
  const scratchRoot = await mkdtemp(path.join(scratchParent, "private-package-runtime-"));
  const anonymousHome = path.join(scratchRoot, "anonymous-home");
  const anonymousConfig = path.join(anonymousHome, "user.npmrc");
  await mkdir(anonymousHome, { recursive: true });
  await writeFile(anonymousConfig, `${config.registry.scope}:registry=${registryUrl.href}\n`, {
    mode: 0o600,
  });
  const anonymousEnvironment = createAnonymousEnvironment({
    home: anonymousHome,
    userConfig: anonymousConfig,
    baseEnv: environment,
  });
  let preparedAnonymousEnvironment;
  const ensurePreparedAnonymousEnvironment = async () => {
    preparedAnonymousEnvironment ??= prepareAnonymousCorepackEnvironment({
      home: anonymousHome,
      userConfig: anonymousConfig,
      baseEnv: environment,
      toolchain,
      runCommand,
    });
    return preparedAnonymousEnvironment;
  };

  async function giteaRequest(route, options = {}, { allowNotFound = false } = {}) {
    const response = await fetchImplementation(`${apiRoot}${route}`, {
      ...options,
      redirect: "manual",
      headers: {
        Authorization: `token ${giteaToken}`,
        ...(options.headers ?? {}),
      },
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
    }
    return response;
  }

  async function anonymousNpm(args, { allowNotFound = false } = {}) {
    try {
      return await runExactTool(
        toolchain,
        "npm",
        args,
        { cwd: anonymousHome, env: anonymousEnvironment },
        runCommand,
      );
    } catch (error) {
      if (allowNotFound && isNotFound(error)) return null;
      throw error;
    }
  }

  async function resolveTagTarget(tagName) {
    const encoded = encodeURIComponent(tagName);
    const response = await giteaRequest(`/git/refs/tags/${encoded}`, {}, { allowNotFound: true });
    if (!response) return null;
    const payload = await response.json();
    const refs = Array.isArray(payload) ? payload : [payload];
    const ref = refs.find((entry) => entry.ref === `refs/tags/${tagName}`);
    if (!ref) throw new Error(`${tagName} exact tag ref was not returned`);
    if (!ref?.object?.sha) throw new Error(`${tagName} ref has no target`);
    let target = ref.object;
    const seen = new Set();
    for (let depth = 0; depth < 16 && target.type === "tag"; depth += 1) {
      if (seen.has(target.sha)) throw new Error(`${tagName} annotated tag cycle detected`);
      seen.add(target.sha);
      const tagResponse = await giteaRequest(`/git/tags/${target.sha}`);
      const tag = await tagResponse.json();
      if (!tag.object?.sha || !tag.object?.type) {
        throw new Error(`${tagName} annotated tag has no typed target`);
      }
      target = tag.object;
    }
    if (target.type !== "commit") {
      throw new Error(`${tagName} does not resolve to a commit within 16 tag objects`);
    }
    return target.sha;
  }

  async function packagePath(packageDirectory) {
    const requested = path.resolve(workspaceRoot, packageDirectory);
    const resolved = await realpath(requested);
    const relative = path.relative(workspaceRoot, resolved);
    if (
      (relative !== "" && relative.startsWith(`..${path.sep}`)) ||
      path.isAbsolute(relative) ||
      resolved !== requested
    ) {
      throw new Error(
        `package directory escapes the workspace or traverses a symlink: ${packageDirectory}`,
      );
    }
    return resolved;
  }

  return {
    async cleanup() {
      await rm(scratchRoot, { recursive: true, force: true });
    },
    async manifest(packageDirectory) {
      return JSON.parse(
        await readFile(path.join(await packagePath(packageDirectory), "package.json"), "utf8"),
      );
    },
    async pack(packageDirectory, destination) {
      const buildEnvironment = await ensurePreparedAnonymousEnvironment();
      const resolvedPackage = await packagePath(packageDirectory);
      const spec = config.packages.find((candidate) => candidate.directory === packageDirectory);
      if (!spec) throw new Error(`package directory is not configured: ${packageDirectory}`);
      const manifest = JSON.parse(
        await readFile(path.join(resolvedPackage, "package.json"), "utf8"),
      );
      if (typeof manifest.scripts?.build !== "string" || manifest.scripts.build.length === 0) {
        throw new Error(`${manifest.name ?? packageDirectory} must declare a build script`);
      }
      await cleanAndBuildPackage({
        workspaceRoot,
        packageDirectory: resolvedPackage,
        spec,
        toolchain,
        runCommand,
        environment: buildEnvironment,
      });
      await mkdir(destination, { recursive: true });
      const before = new Set(await readdir(destination));
      const { stdout } = await runExactTool(
        toolchain,
        "npm",
        ["pack", "--pack-destination", destination, "--json", "--ignore-scripts"],
        {
          cwd: resolvedPackage,
          env: anonymousEnvironment,
        },
        runCommand,
      );
      const created = (await readdir(destination)).filter(
        (name) => name.endsWith(".tgz") && !before.has(name),
      );
      const reports = outputJson(stdout, "npm pack report");
      if (
        created.length !== 1 ||
        !Array.isArray(reports) ||
        reports.length !== 1 ||
        reports[0]?.filename !== created[0] ||
        !Array.isArray(reports[0]?.files)
      ) {
        throw new Error(`npm pack did not create exactly one reported archive in ${destination}`);
      }
      const trackedFiles = await trackedWorkspaceFiles(workspaceRoot, spec, runCommand);
      assertPackedFileSet({
        packageDirectory: spec.directory,
        generatedPaths: spec.generatedPaths,
        trackedFiles,
        packedFiles: reports[0].files,
      });
      return { name: created[0], bytes: await readFile(path.join(destination, created[0])) };
    },
    async registryInspect(packageName) {
      const versionsResponse = await anonymousNpm(
        ["view", packageName, "versions", "--json", "--silent"],
        { allowNotFound: true },
      );
      if (!versionsResponse) return { versions: [], distTags: {} };
      const versionPayload = outputJson(versionsResponse.stdout, `${packageName} versions`);
      const versions = Array.isArray(versionPayload) ? versionPayload : [versionPayload];
      const tagsResponse = await anonymousNpm([
        "view",
        packageName,
        "dist-tags",
        "--json",
        "--silent",
      ]);
      return {
        versions,
        distTags: outputJson(tagsResponse.stdout, `${packageName} dist-tags`),
      };
    },
    async registryArchive(packageName, version) {
      const directory = await mkdtemp(path.join(scratchRoot, "registry-archive-"));
      try {
        const before = new Set(await readdir(directory));
        const { stdout } = await anonymousNpm([
          "pack",
          `${packageName}@${version}`,
          "--pack-destination",
          directory,
          "--silent",
        ]);
        const created = (await readdir(directory)).filter(
          (name) => name.endsWith(".tgz") && !before.has(name),
        );
        if (created.length !== 1 || stdout.trim() !== created[0]) {
          throw new Error(`anonymous npm pack did not download exactly one ${packageName} archive`);
        }
        return await readFile(path.join(directory, created[0]));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async giteaTag(tagName) {
      const targetSha = await resolveTagTarget(tagName);
      return targetSha ? { targetSha } : null;
    },
    async giteaRelease(tagName) {
      const response = await giteaRequest(
        `/releases/tags/${encodeURIComponent(tagName)}`,
        {},
        { allowNotFound: true },
      );
      return response ? releaseRecord(await response.json()) : null;
    },
    async giteaAssetBytes(asset) {
      const downloadUrl = assertSafeUrl(asset.downloadUrl, `release asset ${asset.name} URL`);
      if (downloadUrl.origin !== giteaServer.origin) {
        throw new Error(`release asset ${asset.name} is hosted outside Gitea`);
      }
      const response = await fetchImplementation(downloadUrl, {
        redirect: "manual",
        headers: { Authorization: `token ${giteaToken}` },
      });
      if (!response.ok) {
        throw new Error(`release asset ${asset.name} returned ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async isAncestor(ancestor, descendant) {
      try {
        await runCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
          cwd: workspaceRoot,
        });
        return true;
      } catch (error) {
        if (error?.code === 1) return false;
        throw error;
      }
    },
    async releaseInput(sourceSha, spec, releaseConfig = config) {
      return computeReleaseInput({
        sourceSha,
        packageDirectory: spec.directory,
        sourcePaths: spec.sourcePaths,
        configPath: releaseConfig.configPath,
        workflowPath: releaseConfig.workflowPath,
        releaseInputPaths: releaseConfig.releaseInputPaths,
        git: createGitClient(workspaceRoot),
      });
    },
    async generateSbom(candidate, outputPath, { enforceAdmission = true } = {}) {
      const preparedEnvironment = await ensurePreparedAnonymousEnvironment();
      const credentialCanary = `PRIVATE_SBOM_CREDENTIAL_CANARY_${randomBytes(16).toString("hex")}`;
      const benignCanary = `ARCADE_SBOM_CANARY_${randomBytes(16).toString("hex")}`;
      const sbomBaseEnvironment = {
        ...environment,
        NPM_TOKEN: credentialCanary,
        ARCADE_SBOM_CANARY: benignCanary,
      };
      const sbomEnvironment = createAnonymousEnvironment({
        home: anonymousHome,
        userConfig: anonymousConfig,
        baseEnv: sbomBaseEnvironment,
        corepackHome: preparedEnvironment.COREPACK_HOME,
      });
      const evidence = await generateAndValidatePnpmPackageSbom({
        outputPath,
        sourceSha: candidate.sourceSha,
        sourceEpoch: candidate.sourceEpoch,
        packageDirectory: await packagePath(candidate.packageDirectory),
        workspaceRoot,
        registryUrl: config.registry.url,
        admission: candidate.admission,
        enforceAdmission,
        lockfileBlob: candidate.lockfileBlob,
        packageSourceSha256: candidate.packageSourceSha256,
        releaseInputSha256: candidate.releaseInputSha256,
        archives: candidate.archives,
        pnpmExecutable: toolchain.nodeExecutable,
        pnpmArgumentsPrefix: [toolchain.pnpmCli],
        environment: sbomEnvironment,
      });
      const bytes = await readFile(outputPath);
      if (bytes.includes(credentialCanary)) throw new Error("SBOM leaked the credential canary");
      if (bytes.includes(benignCanary))
        throw new Error("SBOM serialized the benign environment canary");
      if (/(?:_authToken|Bearer\s|Basic\s|https?:\/\/[^\s/@]+:[^\s/@]+@)/iu.test(bytes)) {
        throw new Error("SBOM contains authentication material");
      }
      return evidence;
    },
    async remoteMain() {
      const response = await giteaRequest("/branches/main");
      const branch = await response.json();
      if (!branch.commit?.id) throw new Error("Gitea main branch response has no commit ID");
      return branch.commit.id;
    },
    async publishArchive(archivePath) {
      const token = requireEnvironment("NPM_TOKEN", environment);
      const publishDirectory = await mkdtemp(path.join(scratchRoot, "authenticated-publish-"));
      try {
        const anonymousPublishConfig = path.join(publishDirectory, "anonymous.npmrc");
        const authConfig = path.join(publishDirectory, "publish.npmrc");
        await writeFile(
          anonymousPublishConfig,
          `${config.registry.scope}:registry=${registryUrl.href}\n`,
          {
            mode: 0o600,
          },
        );
        const publishEnvironment = createAnonymousEnvironment({
          home: publishDirectory,
          userConfig: anonymousPublishConfig,
          baseEnv: environment,
        });
        const authKey = `//${registryUrl.host}${registryUrl.pathname.replace(/\/?$/u, "/")}:_authToken`;
        await writeFile(
          authConfig,
          `${config.registry.scope}:registry=${registryUrl.href}\n${authKey}=${token}\n`,
          { mode: 0o600 },
        );
        publishEnvironment.npm_config_userconfig = authConfig;
        publishEnvironment.NPM_CONFIG_USERCONFIG = authConfig;
        if (publishEnvironment.NPM_TOKEN !== undefined) {
          throw new Error("publish token leaked into authenticated npm child environment");
        }
        await runExactTool(
          toolchain,
          "npm",
          [
            "publish",
            archivePath,
            "--tag",
            "latest",
            "--ignore-scripts",
            "--userconfig",
            authConfig,
          ],
          { cwd: publishDirectory, env: publishEnvironment },
          runCommand,
        );
      } finally {
        await rm(publishDirectory, { recursive: true, force: true });
      }
    },
    async createRelease({ tagName, targetSha, name, body, draft, prerelease }) {
      const response = await giteaRequest("/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: tagName,
          target_commitish: targetSha,
          name,
          body,
          draft,
          prerelease,
        }),
      });
      const release = releaseRecord(await response.json());
      assertCreatedRelease(release, { tagName, targetSha, name, body, draft, prerelease });
      const resolvedTarget = await resolveTagTarget(tagName);
      if (resolvedTarget !== targetSha) {
        throw new Error(`created release ${tagName} did not resolve to its requested source`);
      }
      const persistedResponse = await giteaRequest(`/releases/tags/${encodeURIComponent(tagName)}`);
      const persisted = releaseRecord(await persistedResponse.json());
      assertCreatedRelease(persisted, { tagName, targetSha, name, body, draft, prerelease });
      if (persisted.id !== release.id) {
        throw new Error(`created release persisted ID mismatch for ${tagName}`);
      }
      return persisted;
    },
    async uploadReleaseAsset(releaseId, name, localPath) {
      const bytes = await readFile(localPath);
      const form = new FormData();
      form.append("attachment", new Blob([bytes]), name);
      const response = await giteaRequest(
        `/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        { method: "POST", body: form },
      );
      const asset = releaseAsset(await response.json());
      if (asset.name !== name || Number(asset.size) !== bytes.length) {
        throw new Error(`uploaded release asset ${name} metadata mismatch`);
      }
    },
  };
}
