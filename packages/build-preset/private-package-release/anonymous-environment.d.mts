export function assertAnonymousNpmConfig(userConfig: string): void;

export function createAnonymousEnvironment(input: {
  home: string;
  userConfig: string;
  baseEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): NodeJS.ProcessEnv;
