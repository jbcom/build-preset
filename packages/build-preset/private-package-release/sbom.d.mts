import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import type { SbomAdmission } from "./config.mjs";

export type PackageArchiveIdentity = Readonly<{
  name: string;
  sha256: string;
}>;

export type PnpmSbomEvidence = Readonly<{
  packageName: string;
  version: string;
  rootRef: string;
  componentCount: number;
  dependencyCount: number;
  serialNumber: string;
  sbomSha256: string;
  componentIdentitySha256: string;
  dependencyAdjacencySha256: string;
}>;

export type PnpmSbomEvidenceInput = Readonly<{
  sourceSha: string;
  sourceEpoch: string | number;
  packageDirectory: string;
  workspaceRoot: string;
  registryUrl: string;
  admission: SbomAdmission | null;
  enforceAdmission?: boolean;
  lockfileBlob: string;
  packageSourceSha256: string;
  releaseInputSha256: string;
  archives: readonly PackageArchiveIdentity[];
}>;

export type NormalizePnpmSbomInput = PnpmSbomEvidenceInput &
  Readonly<{
    inputPath: string;
    forbiddenValues?: readonly string[];
  }>;

export type PnpmSbomExecFile = (
  executable: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export type GeneratePnpmSbomInput = PnpmSbomEvidenceInput &
  Readonly<{
    outputPath: string;
    pnpmExecutable?: string;
    pnpmArgumentsPrefix?: readonly string[];
    environment?: NodeJS.ProcessEnv;
    execFileImpl?: PnpmSbomExecFile;
  }>;

export const SBOM_UUID_NAMESPACE: string;
export const PNPM_VERSION: "11.21.0";
export const NODE_VERSION: "v24.19.0";
export function normalizeAndValidatePnpmSbom(
  input: NormalizePnpmSbomInput,
): Promise<PnpmSbomEvidence>;

export function generateAndValidatePnpmPackageSbom(
  input: GeneratePnpmSbomInput,
): Promise<PnpmSbomEvidence>;

export function managedSbomPropertyNames(): Set<string>;
