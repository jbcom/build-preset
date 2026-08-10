import type { PrivatePackageReleaseConfig, PrivatePackageSpec, SbomAdmission } from "./config.mjs";
import type { GitClient } from "./fingerprint.mjs";

export type { CommandResult, CommandRunner, ExactToolchain } from "./toolchain.mjs";

import type { CommandRunner, ExactToolchain } from "./toolchain.mjs";

export type RuntimeClients = {
  cleanup(): Promise<void>;
  registryInspect(packageName: string): Promise<{
    versions: string[];
    distTags: Record<string, string>;
  }>;
  pack(packageDirectory: string, destination: string): Promise<{ name: string; bytes: Buffer }>;
  publishArchive(archivePath: string): Promise<void>;
  giteaAssetBytes(asset: { name: string; downloadUrl: string }): Promise<Buffer>;
  [key: string]: unknown;
};
export function assertExactReleaseRuntime(
  workspaceRoot?: string,
  runCommand?: CommandRunner,
  toolchain?: ExactToolchain,
): Promise<ExactToolchain>;
export function assertExactLocalSource(
  sourceSha: string,
  workspaceRoot?: string,
  git?: GitClient,
): Promise<void>;
export function assertVerifierDependencyBinding(input: {
  workspaceRoot?: string;
  verifier: { packageName: string; version: string };
  runCommand?: CommandRunner;
  toolchain?: ExactToolchain;
}): Promise<void>;
export function assertCredentialFreeEnvironment(
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void;
export function assertPackedFileSet(input: {
  packageDirectory: string;
  generatedPaths: string[];
  trackedFiles: string[];
  packedFiles: Array<string | { path?: string }>;
}): void;
export function profilePackageAdmission(input: {
  workspaceRoot?: string;
  sourceSha: string;
  spec: PrivatePackageSpec;
  config: PrivatePackageReleaseConfig;
  toolchain?: ExactToolchain;
  runCommand?: CommandRunner;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<SbomAdmission>;
export function createRuntimeClients(options?: {
  workspaceRoot?: string;
  runCommand?: CommandRunner;
  fetchImplementation?: typeof fetch;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  config: PrivatePackageReleaseConfig;
  toolchain?: ExactToolchain;
}): Promise<RuntimeClients>;
