export const RELEASE_STATES: Readonly<{
  NEW: "NEW";
  REGISTRY_ONLY: "REGISTRY_ONLY";
  TAG_ONLY: "TAG_ONLY";
  EXISTING: "EXISTING";
}>;

export type ReleaseState = (typeof RELEASE_STATES)[keyof typeof RELEASE_STATES];
export type RegistrySnapshot = { versions: string[]; distTags: Record<string, string> };
export type RegistryState = RegistrySnapshot & {
  versionExists: boolean;
  latestMode: "new" | "candidate" | "successor";
  latest: string | undefined;
};

export function normalizeRegistrySnapshot(snapshot: RegistrySnapshot): RegistrySnapshot;
export function classifyRegistryState(input: {
  candidateVersion: string;
  versions: string[];
  distTags: Record<string, string | undefined>;
}): RegistryState;
export function classifyReleaseState(input: {
  registry: { versionExists: boolean };
  tag: unknown;
  release: unknown;
}): ReleaseState;
export function expectedReleaseMetadata(candidate: {
  packageName: string;
  version: string;
  sourceSha: string;
  packageSourceSha256: string;
  releaseInputSha256: string;
  archiveSha256: string;
}): { name: string; body: string; draft: false; prerelease: false };
export function assertReleaseMetadata(actual: unknown, expected: unknown): void;
export function assertCreatedRelease(
  actual: unknown,
  expected: {
    tagName: string;
    targetSha: string;
    name: string;
    body: string;
    draft: boolean;
    prerelease: boolean;
  },
): void;
export function assertDistTagsAfter(input: {
  before: Record<string, string>;
  after: Record<string, string>;
  candidateVersion: string;
  state: ReleaseState;
}): void;
export function stateRequiresRegistryPublish(state: ReleaseState): boolean;
export function stateRequiresReleaseCreation(release: unknown): boolean;
