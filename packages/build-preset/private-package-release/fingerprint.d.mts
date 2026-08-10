export type ReleaseInput = {
  sourceSha: string;
  sourceEpoch: string;
  packageDirectory: string;
  sourcePaths: string[];
  packageSourceSha256: string;
  licenseBlob: string;
  lockfileBlob: string;
  configBlob: string;
  workflowBlob: string;
  rootManifestBlob: string;
  workspaceBlob: string;
  npmrcBlob: string;
  releaseInputSha256: string;
  inputFiles: string[];
};
export type GitClient = (...arguments_: string[]) => Promise<string>;
export function createGitClient(cwd?: string): GitClient;
export function computeReleaseInput(input: {
  sourceSha: string;
  packageDirectory: string;
  sourcePaths: string[];
  configPath: string;
  workflowPath: string;
  releaseInputPaths?: string[];
  git?: GitClient;
}): Promise<ReleaseInput>;
