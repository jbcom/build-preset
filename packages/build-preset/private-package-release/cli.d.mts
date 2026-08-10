import type { PrivatePackageReleaseConfig } from "./config.mjs";
import type { ReleaseReceipt } from "./orchestrator.mjs";
export function parseArguments(arguments_: string[]): Record<string, string> & {
  phase: "prepare" | "publish" | "profile-sbom";
};
export function validateReceipt(
  receipt: unknown,
  options: {
    config: PrivatePackageReleaseConfig;
    loadedConfig: { sha256: string };
    verifier: Record<string, string>;
    expectedReleaseRoot?: string;
  },
): ReleaseReceipt;
export function assertSafeOutputPaths(
  options: { receipt?: string; releaseRoot?: string; verificationRoot?: string },
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<void>;
export function assertPublishReceiptPaths(
  receiptPath: string,
  receipt: ReleaseReceipt,
  expectedReleaseRoot: string,
): Promise<void>;
export function main(arguments_?: string[]): Promise<void>;
