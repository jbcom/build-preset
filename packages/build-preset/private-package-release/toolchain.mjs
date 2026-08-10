import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

async function run(command, arguments_, options = {}) {
  return execute(command, arguments_, { maxBuffer: MAX_BUFFER, ...options });
}

export async function resolveExactToolchain() {
  const nodeExecutable = await realpath(process.execPath);
  const nodeRoot = path.dirname(path.dirname(nodeExecutable));
  const npmCli = path.join(nodeRoot, "lib/node_modules/npm/bin/npm-cli.js");
  const pnpmCli = path.join(nodeRoot, "lib/node_modules/corepack/dist/pnpm.js");
  await Promise.all([access(npmCli), access(pnpmCli)]);
  return Object.freeze({ nodeExecutable, npmCli, pnpmCli });
}

export async function runExactTool(toolchain, tool, arguments_, options, runCommand = run) {
  const cli = tool === "npm" ? toolchain.npmCli : toolchain.pnpmCli;
  return runCommand(toolchain.nodeExecutable, [cli, ...arguments_], options);
}

export async function assertExactToolchain(
  workspaceRoot = process.cwd(),
  runCommand = run,
  toolchain,
) {
  toolchain ??= await resolveExactToolchain();
  const [{ stdout: npmVersion }, { stdout: pnpmVersion }] = await Promise.all([
    runExactTool(toolchain, "npm", ["--version"], { cwd: workspaceRoot }, runCommand),
    runExactTool(toolchain, "pnpm", ["--version"], { cwd: workspaceRoot }, runCommand),
  ]);
  if (process.version !== "v24.19.0") throw new Error("Node v24.19.0 is required");
  if (npmVersion.trim() !== "11.17.0") throw new Error("npm 11.17.0 is required");
  if (pnpmVersion.trim() !== "11.21.0") throw new Error("pnpm 11.21.0 is required");
  return toolchain;
}
