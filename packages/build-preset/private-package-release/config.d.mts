export type SbomAdmission = {
  profile: string;
  rootPurl: string;
  componentCount: number;
  dependencyCount: number;
  componentIdentitySha256: string;
  dependencyAdjacencySha256: string;
};
export type PrivatePackageSpec = {
  id: string;
  directory: string;
  generatedPaths: string[];
  sourcePaths: string[];
  name: string;
  tagPrefix: string;
  admission: SbomAdmission | null;
};
export type PrivatePackageReleaseConfig = {
  profile: string;
  repository: string;
  configPath: string;
  workflowPath: string;
  mainBranch: "main";
  releaseInputPaths: string[];
  registry: { url: string; scope: string };
  packages: PrivatePackageSpec[];
};
export const CONFIG_PROFILE: string;
export const RECEIPT_PROFILE: string;
export const SBOM_PROFILE: string;
export function sha256(value: Uint8Array | string): string;
export function assertSafeHttpsUrl(value: string, label: string): URL;
export function validateReleaseConfig(
  value: unknown,
  options?: { requireAdmissions?: boolean },
): PrivatePackageReleaseConfig;
export function loadReleaseConfig(input: {
  workspaceRoot: string;
  configPath: string;
  requireAdmissions?: boolean;
}): Promise<{
  config: PrivatePackageReleaseConfig;
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
}>;
export function runningVerifierIdentity(): Promise<{
  packageName: string;
  version: string;
  receiptProfile: string;
  configProfile: string;
  sbomProfile: string;
  implementationSha256: string;
}>;
