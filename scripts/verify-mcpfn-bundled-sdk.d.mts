export declare const SDK_NAME: "@modelcontextprotocol/sdk";

export declare class BundledSdkError extends Error {
  readonly details: Record<string, unknown>;
  constructor(message: string, details?: Record<string, unknown>);
}

export interface BundledSdkReport {
  name: string;
  pinned: string;
  bundles: Array<{
    bundle: string;
    stamped: string;
    sdkRoots: string[];
    versions: string[];
    sources: number;
  }>;
}

export declare function resolveInstalledSdk(packageRoot: string): { root: string; version: string };

export declare function bundledSdkBanner(packageRoot: string): string;

export declare function verifyBundledSdk(packageRoot: string): BundledSdkReport;
