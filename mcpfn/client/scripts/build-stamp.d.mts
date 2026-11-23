export declare const stampFile: string;
export declare function requiredArtifacts(root: string): string[];
export declare function sourceDigest(root: string): string;
export declare function distArtifacts(root: string): Record<string, string>;
export declare function writeBuildStamp(root: string, digest?: string): void;
export declare function buildWithStamp(root: string, build: () => void): void;
export declare function distIsFresh(root: string): boolean;
export declare function ensureFreshDist(root: string, build: () => void): "fresh" | "rebuilt";
