import * as path from "path";
import * as fs from "fs";
import type {
    TestCase,
    TestResult,
    RunOptions,
    TestStatus,
    TestError,
    TestProgress,
} from "@testfn/core";
import { BaseAdapter } from "@testfn/core";

// Duck-typing collection types to avoid circular dependency
interface CollectionItem { kind: string; name: string; path: string; children?: CollectionItem[];[key: string]: any; }
interface CollectionInfo { name: string;[key: string]: any; }
interface Collection { info: CollectionInfo; items: CollectionItem[]; environments: Record<string, any>;[key: string]: any; }
interface AssertionResult { passed: boolean; name: string;[key: string]: any; }
interface RequestResult { path: string; status: "passed" | "failed" | "error" | "skipped"; duration: number; assertions: AssertionResult[]; error?: string; statusCode?: number;[key: string]: any; }
interface RunReport { results: RequestResult[];[key: string]: any; }

const REQUEST_ID_PREFIX = "apifn:";

function requestId(directory: string, requestPath: string): string {
    return REQUEST_ID_PREFIX + JSON.stringify([directory, requestPath]);
}

function isRequestPathId(id: string): boolean {
    if (!id.startsWith(REQUEST_ID_PREFIX)) return false;
    try {
        const parts: unknown = JSON.parse(id.slice(REQUEST_ID_PREFIX.length));
        return Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === "string");
    } catch {
        return false;
    }
}

function visitRequests(
    collection: Collection,
    visit: (item: CollectionItem, suite: string) => void,
): void {
    function walk(items: CollectionItem[], suitePath: string[]): void {
        for (const item of items) {
            if (item.kind === "request") {
                visit(item, suitePath.length ? suitePath.join(" > ") : collection.info.name);
            } else if (item.kind === "folder" && item.children) {
                walk(item.children, [...suitePath, item.name]);
            }
        }
    }
    walk(collection.items, []);
}

export interface ApifnTestAdapterOptions {
    /** Execute scripts from trusted collections. Defaults to false. */
    allowScripts?: boolean;
    /** Explicit values for collection templates that use {{process.env.NAME}}. */
    processEnv?: NodeJS.ProcessEnv;
}

export class ApifnTestAdapter extends BaseAdapter {
    name = "apifn";

    constructor(private readonly collectionOptions: ApifnTestAdapterOptions = {}) {
        super();
    }

    supports(framework: string): boolean {
        return framework.toLowerCase() === "apifn";
    }

    async discover(patterns: string[]): Promise<TestCase[]> {
        // Dynamic import to avoid circular dependency
        let glob: ((pattern: string | string[], options?: { absolute?: boolean }) => Promise<string[]>) | undefined;
        try {
            // @testfn/core depends on fast-glob, so reuse it when available.
            const fg = await import("fast-glob");
            glob = (fg as any).default ?? (fg as any);
        } catch {
            console.warn("[apifn/testfn] fast-glob not found, using basic fs discovery");
        }

        // @ts-ignore
        const { readCollection } = await import("@apifn/collections");
        const testCases: TestCase[] = [];
        const discoveredDirs = new Set<string>();

        for (const pattern of patterns) {
            if (glob) {
                // Find opencollection.yml files matching the pattern
                const files: string[] = await glob(
                    pattern.endsWith(".yml") || pattern.endsWith(".yaml")
                        ? pattern
                        : `${pattern}/**/opencollection.yml`,
                    { absolute: true }
                );
                for (const f of files) {
                    discoveredDirs.add(path.dirname(f));
                }
            } else {
                // Fallback if no glob (unlikely since testfn has it)
                try {
                    if (fs.existsSync(pattern)) {
                        const stat = fs.statSync(pattern);
                        if (stat.isDirectory()) {
                            if (fs.existsSync(path.join(pattern, "opencollection.yml"))) {
                                discoveredDirs.add(pattern);
                            }
                        } else if (pattern.endsWith("opencollection.yml")) {
                            discoveredDirs.add(path.dirname(pattern));
                        }
                    }
                } catch {
                    // ignore
                }
            }
        }

        for (const dir of discoveredDirs) {
            try {
                const collection: Collection = await readCollection(dir);

                visitRequests(collection, (item, suite) => {
                    testCases.push({
                        id: requestId(dir, item.path),
                        file: dir,
                        name: item.name,
                        suite,
                        tags: ["api"],
                    });
                });
            } catch (err) {
                console.warn(`[apifn/testfn] Failed to read collection at ${dir}:`, err);
            }
        }

        return testCases;
    }

    async run(tests: TestCase[], options: RunOptions): Promise<TestResult[]> {
        // @ts-ignore
        const { runCollection, readCollection, COLLECTION_RUNNER_TRUST_OPTIONS } = await import("@apifn/collections");
        if (COLLECTION_RUNNER_TRUST_OPTIONS !== true) {
            throw new Error("The ApiFn TestFn adapter requires @apifn/collections 0.0.5 or later.");
        }
        const results: TestResult[] = [];

        // Group tests by collection file/directory
        const collectionsToRun = new Map<string, TestCase[]>();
        for (const t of tests) {
            const list = collectionsToRun.get(t.file) || [];
            list.push(t);
            collectionsToRun.set(t.file, list);
        }

        let completedCount = 0;
        const updateProgress = (tc: TestCase) => {
            completedCount++;
            options.onProgress?.({
                completed: completedCount,
                total: tests.length,
                current: tc,
            });
        };

        for (const [dir, testsInCollection] of collectionsToRun.entries()) {
            const completedCases = new Set<TestCase>();
            try {
                const collection = await readCollection(dir);
                const requestsByName = new Map<string, Array<{ path: string; suite: string }>>();
                const pathsById = new Map<string, string>();
                const casesByPath = new Map<string, TestCase[]>();
                visitRequests(collection, (item, suite) => {
                    const matches = requestsByName.get(item.name) ?? [];
                    matches.push({ path: item.path, suite });
                    requestsByName.set(item.name, matches);
                    pathsById.set(requestId(dir, item.path), item.path);
                });

                for (const test of testsInCollection) {
                    const matches = isRequestPathId(test.id)
                        ? []
                        : requestsByName.get(test.name)?.filter((request) => !test.suite || test.suite === request.suite) ?? [];
                    const selectedPath = pathsById.get(test.id) ?? (matches.length === 1 ? matches[0].path : undefined);
                    if (selectedPath !== undefined) {
                        const known = casesByPath.get(selectedPath) ?? [];
                        known.push(test);
                        casesByPath.set(selectedPath, known);
                    } else {
                        completedCases.add(test);
                        const ambiguous = matches.length > 1;
                        results.push({
                            id: test.id,
                            status: ambiguous ? "failed" : "skipped",
                            duration: 0,
                            error: {
                                message: ambiguous
                                    ? "Multiple collection requests match this test. Discover the tests again to select a request by path."
                                    : "Test not found in collection",
                            },
                        });
                        updateProgress(test);
                    }
                }

                const runOptions = {
                    // Default to the first environment or a dummy one if none exists
                    environment: Object.keys(collection.environments)[0] ?? "default",
                    parallel: options.parallel !== undefined && options.parallel > 1,
                    concurrency: typeof options.parallel === "number" ? options.parallel : undefined,
                    timeout: options.timeout,
                    retries: options.retries,
                    overrides: options.env,
                    allowScripts: this.collectionOptions.allowScripts === true,
                    processEnv: this.collectionOptions.processEnv,
                    includePaths: [...casesByPath.keys()],
                };
                const report: RunReport = casesByPath.size
                    ? await runCollection(collection, runOptions)
                    : { results: [] };

                // Map collection results to testfn TestResults
                for (const reqRes of report.results) {
                    for (const tc of casesByPath.get(reqRes.path) ?? []) {
                        completedCases.add(tc);
                        let status: TestStatus = "passed";
                        let testError: TestError | undefined;

                        if (reqRes.status === "failed" || reqRes.status === "error") {
                            status = "failed";

                            if (reqRes.status === "failed") {
                                const failedAsserts = reqRes.assertions.filter((a: any) => !a.passed);
                                const msg = failedAsserts.map((a: any) => `- ${a.name}`).join("\n");
                                testError = {
                                    message: `Assertions failed:\n${msg}`,
                                };
                            } else if (reqRes.status === "error") {
                                testError = {
                                    message: reqRes.error || "Unknown Request Error",
                                    actual: reqRes.statusCode,
                                };
                            }
                        } else if (reqRes.status === "skipped") {
                            status = "skipped";
                        }

                        results.push({
                            id: tc.id,
                            status,
                            duration: reqRes.duration,
                            error: testError,
                        });
                        updateProgress(tc);
                    }
                }

                // Handle skipped/omitted tests from collection that were requested
                for (const tc of testsInCollection) {
                    if (!completedCases.has(tc)) {
                        results.push({
                            id: tc.id,
                            status: "skipped",
                            duration: 0,
                            error: { message: "Test not found or excluded in collection run" },
                        });
                        updateProgress(tc);
                    }
                }
            } catch (err) {
                // Collection load or execution failure applies error to all tests in it
                for (const tc of testsInCollection) {
                    if (completedCases.has(tc)) continue;
                    results.push({
                        id: tc.id,
                        status: "failed",
                        duration: 0,
                        error: {
                            message: err instanceof Error ? err.message : String(err),
                            stack: err instanceof Error ? err.stack : undefined,
                        },
                    });
                    updateProgress(tc);
                }
            }
        }

        return results;
    }
}
