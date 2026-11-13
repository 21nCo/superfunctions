type Hook = (fn: () => unknown, timeout?: number) => void;

export declare function temporaryDirectories(hook: Hook): (prefix: string) => string;
