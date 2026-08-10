import type { CommandRunner, ExactToolchain } from "./toolchain.mjs";

export const EXACT_PNPM_VERSION: "11.21.0";

export function resolveCorepackHome(
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
  platform?: NodeJS.Platform,
  userHome?: string,
): string;

export function prepareAnonymousCorepackEnvironment(input: {
  home: string;
  userConfig: string;
  toolchain: ExactToolchain;
  baseEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sourceCorepackHome?: string;
  runCommand?: CommandRunner;
}): Promise<NodeJS.ProcessEnv>;
