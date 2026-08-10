export type DependencyCurrentConfig = {
  profile: string;
  configPath: string;
  manifestPath: string;
  policy: "public-runtime-closure" | "private-scopes-and-roots";
  registries: {
    public: { url: string; access: "anonymous" };
    scopes: Record<string, { url: string; access: "anonymous" | "private-npm-token" }>;
  };
  privateScopes: string[];
  forbiddenScopes: string[];
  rootPackages: string[];
  baselines: Record<string, string>;
  requireInstalledSections: Array<"dependencies" | "devDependencies" | "optionalDependencies">;
  manifestToolchain: {
    packageManager: "absent" | "pnpm@11.21.0";
    nodeEngine: "24.x" | ">=24" | "24.19.0";
  };
};
export type DependencyManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  [key: string]: unknown;
};
export type RegistryPackageMetadata = {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, DependencyManifest>;
  [key: string]: unknown;
};
export type InstalledResolutionGraph = {
  rootIdentity: string;
  resolve(ownerIdentity: string, dependencyName: string): string | null;
};
export type VerifiedDependencyEdge = {
  kind: string;
  name: string;
  spec: string;
  peerSpec?: string;
  depth: number;
  owner: string;
  ownerIdentity: string;
  ownerPath: string;
  installPath: string;
  latest: string;
  selected: string;
};
export class DependencyCurrentPolicyError extends Error {
  readonly exitCode: 2;
}
export class DependencyCurrentInfrastructureError extends Error {
  readonly exitCode: 3;
}
export const DEPENDENCY_CURRENT_PROFILE: string;
export function validateDependencyCurrentConfig(value: unknown): DependencyCurrentConfig;
export function loadDependencyCurrentConfig(input: {
  workspaceRoot: string;
  configPath: string;
}): Promise<DependencyCurrentConfig>;
export function installedPackageNames(manifest: Record<string, unknown>): Set<string>;
export function collectRuntimeEdges(
  manifest: DependencyManifest,
  installedNames: Set<string> | ((name: string) => boolean),
): { edges: Array<{ kind: string; name: string; spec: string }>; skippedOptionalPeers: string[] };
export function verifyDependencyCurrent(input: {
  manifest: DependencyManifest;
  installationManifest?: DependencyManifest;
  installedNames?: Set<string>;
  isInstalled?: (name: string) => boolean;
  installedGraph?: InstalledResolutionGraph;
  config: DependencyCurrentConfig;
  readMetadata: (
    packageName: string,
    registry: { url: string; access: "anonymous" | "private-npm-token" },
  ) => Promise<RegistryPackageMetadata>;
}): Promise<{ verified: VerifiedDependencyEdge[]; skipped: string[]; packageCount: number }>;
export function createInstalledResolutionGraph(pnpmList: unknown): InstalledResolutionGraph;
export function runDependencyCurrent(input: {
  workspaceRoot?: string;
  configPath: string;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchImplementation?: typeof fetch;
  runCommand?: import("./toolchain.mjs").CommandRunner;
  toolchain?: import("./toolchain.mjs").ExactToolchain;
}): Promise<{ verified: VerifiedDependencyEdge[]; skipped: string[]; packageCount: number }>;
export function createRegistryMetadataReader(input?: {
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  maxMetadataBytes?: number;
}): (
  packageName: string,
  registry: { url: string; access: "anonymous" | "private-npm-token" },
) => Promise<RegistryPackageMetadata>;
export function dependencyCurrentMain(arguments_?: string[]): Promise<void>;
