export declare const stampFile: string;
export declare function sourceDigest(root: string): string;
export declare function writeBuildStamp(root: string): void;
export declare function distIsFresh(root: string): boolean;
export declare function ensureFreshDist(root: string, build: () => void): "fresh" | "rebuilt";
