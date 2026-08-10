export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  arguments_: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; [key: string]: unknown },
) => Promise<CommandResult>;
export type ExactToolchain = {
  nodeExecutable: string;
  npmCli: string;
  corepackCli: string;
  pnpmCli: string;
};

export function resolveExactToolchain(): Promise<ExactToolchain>;
export function runExactTool(
  toolchain: ExactToolchain,
  tool: "npm" | "pnpm",
  arguments_: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; [key: string]: unknown },
  runCommand?: CommandRunner,
): Promise<CommandResult>;
export function assertExactToolchain(
  workspaceRoot?: string,
  runCommand?: CommandRunner,
  toolchain?: ExactToolchain,
): Promise<ExactToolchain>;
