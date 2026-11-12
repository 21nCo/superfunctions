type Hook = (fn: (...args: any[]) => unknown, timeout?: number) => void;

export declare const RUN_MARKER: string;
export declare const FILE_MARKER: string;
export declare const ROOT_VARIABLE: string;
export declare const ORIGINAL_TEMP_VARIABLE: string;
export declare function setup(project?: unknown): Promise<() => Promise<void>>;
export declare function guardTestFile(hooks: { beforeEach: Hook; afterEach: Hook; afterAll: Hook }): void;
export declare function guardDirectory(directory: string): void;
export declare function pathAliases(directory: string): string[];
export declare function removeTree(directory: string): boolean;
export declare function tempLeftovers(directory: string): string[];
export declare function stopProcessesUnder(directories: string[], sinceMs?: number): Promise<unknown[]>;
export declare function recordMachineLock(lockPath: string): void;
export declare function pathsNamedUnder(text: string, root: string, options?: { separated?: boolean; environment?: boolean }): string[];
type Listed = { pid: number; ppid: number; command: string; environment: string; cwd?: string; argv?: string; separated?: boolean };
type Scope<T> = { marker?: string; roots: string[]; parent?: number; excluded?: (entry: T) => boolean; vouch?: (entry: T) => boolean };
export declare function attributeProcesses<T extends Listed>(processes: T[], scope: Scope<T>): { owned: T[]; ambiguous: T[] };
export declare function ownedProcesses<T extends Listed>(processes: T[], scope: Scope<T>): T[];
