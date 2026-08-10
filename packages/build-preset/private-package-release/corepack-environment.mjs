import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAnonymousEnvironment } from "./anonymous-environment.mjs";
import { runExactTool } from "./toolchain.mjs";

const execute = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;
export const EXACT_PNPM_VERSION = "11.21.0";

async function run(command, arguments_, options = {}) {
  return execute(command, arguments_, { maxBuffer: MAX_BUFFER, ...options });
}

export function resolveCorepackHome(
  environment = process.env,
  platform = process.platform,
  userHome = homedir(),
) {
  if (environment.COREPACK_HOME) return environment.COREPACK_HOME;
  const cacheRoot =
    environment.XDG_CACHE_HOME ??
    environment.LOCALAPPDATA ??
    path.join(
      environment.HOME ?? environment.USERPROFILE ?? userHome,
      platform === "win32" ? "AppData/Local" : ".cache",
    );
  return path.join(cacheRoot, "node/corepack");
}

export async function prepareAnonymousCorepackEnvironment({
  home,
  userConfig,
  toolchain,
  baseEnv = process.env,
  sourceCorepackHome = resolveCorepackHome(baseEnv),
  runCommand = run,
}) {
  if (
    !path.isAbsolute(sourceCorepackHome) ||
    path.resolve(sourceCorepackHome) !== sourceCorepackHome
  ) {
    throw new Error("source Corepack cache path must be absolute and canonical");
  }
  if (!toolchain?.corepackCli) {
    throw new Error("exact Corepack CLI is unavailable");
  }

  const targetCorepackHome = path.join(home, ".cache/node/corepack");
  if (path.resolve(sourceCorepackHome) === path.resolve(targetCorepackHome)) {
    throw new Error("source and verifier-owned Corepack caches must be distinct");
  }
  const archive = path.join(home, `corepack-pnpm-${EXACT_PNPM_VERSION}.tgz`);
  const exportHome = path.join(home, ".corepack-export-home");
  const sourceEnvironment = createAnonymousEnvironment({
    home: exportHome,
    userConfig,
    baseEnv,
    corepackHome: sourceCorepackHome,
  });
  const targetEnvironment = createAnonymousEnvironment({
    home,
    userConfig,
    baseEnv,
    corepackHome: targetCorepackHome,
  });

  try {
    try {
      await runCommand(
        toolchain.nodeExecutable,
        [toolchain.corepackCli, "pack", `pnpm@${EXACT_PNPM_VERSION}`, "--output", archive],
        { cwd: exportHome, env: sourceEnvironment },
      );
    } catch (error) {
      throw new Error(
        `pnpm ${EXACT_PNPM_VERSION} is not prepared in the caller Corepack cache; ` +
          `prepare it before invoking the release verifier`,
        { cause: error },
      );
    }
    await runCommand(
      toolchain.nodeExecutable,
      [toolchain.corepackCli, "install", "--global", "--cache-only", archive],
      { cwd: home, env: targetEnvironment },
    );
    await runCommand(
      toolchain.nodeExecutable,
      [toolchain.corepackCli, "install", "--global", `pnpm@${EXACT_PNPM_VERSION}`],
      { cwd: home, env: targetEnvironment },
    );
    const { stdout } = await runExactTool(
      toolchain,
      "pnpm",
      ["--version"],
      { cwd: home, env: targetEnvironment },
      runCommand,
    );
    if (stdout.trim() !== EXACT_PNPM_VERSION) {
      throw new Error(
        `verifier-owned Corepack cache selected pnpm ${stdout.trim() || "<missing>"}; ` +
          `expected ${EXACT_PNPM_VERSION}`,
      );
    }
    return targetEnvironment;
  } finally {
    await Promise.all([
      rm(archive, { force: true }),
      rm(exportHome, { recursive: true, force: true }),
    ]);
  }
}
