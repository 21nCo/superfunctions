type Hook = (fn: (...args: any[]) => unknown, timeout?: number) => void;

export declare const RUN_MARKER: string;
export declare const FILE_MARKER: string;
export declare const ROOT_VARIABLE: string;
export declare function setup(project?: unknown): Promise<() => Promise<void>>;
export declare function guardTestFile(hooks: { beforeEach: Hook; afterEach: Hook; afterAll: Hook }): void;
export declare function guardDirectory(directory: string): void;
export declare function pathAliases(directory: string): string[];
export declare function removeTree(directory: string): boolean;
export declare function tempLeftovers(directory: string): string[];
export declare function stopProcessesUnder(directories: string[], sinceMs?: number): Promise<unknown[]>;
