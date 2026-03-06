/**
 * `apifn test` command implementation.
 *
 * Loads a collection directory, resolves environment, runs the collection
 * through runCollection(), and reports results via a configurable reporter.
 *
 * Exit codes (CLI-011):
 *   0 — all tests passed
 *   1 — one or more test failures
 *   2 — error (invalid collection, missing env, etc.)
 */

import path from "node:path";
import {
    readCollection,
    runCollection,
    createConsoleReporter,
    createJsonReporter,
    createSilentReporter,
} from "@apifn/collections";
import type { RunReporter } from "@apifn/collections";
import type { Output } from "../utils/output.js";

export type ReporterName = "console" | "json" | "silent";

export interface TestCommandOptions {
    /** Directory containing the OpenCollection (default: cwd) */
    collectionDir?: string;
    /** Environment name to use */
    env?: string;
    /** Stop on first failure */
    bail?: boolean;
    /** Run requests in parallel */
    parallel?: boolean;
    /** Max concurrent requests when parallel=true */
    concurrency?: number;
    /** Per-request timeout in ms */
    timeout?: number;
    /** Reporter type */
    reporter?: ReporterName;
    /** Whether color output is enabled */
    color?: boolean;
    /** Current working directory */
    cwd?: string;
    /** Output helper (used for error messages) */
    output: Output;
    /** Custom stdout write function for reporter output (default: process.stdout.write) */
    writeStdout?: (text: string) => void;
}

/**
 * Runs the `apifn test` command.
 *
 * @returns exit code: 0 (pass), 1 (failures), 2 (error)
 */
export async function runTestCommand(options: TestCommandOptions): Promise<number> {
    const cwd = options.cwd ?? process.cwd();
    const collectionDir = options.collectionDir
        ? path.resolve(cwd, options.collectionDir)
        : cwd;

    const reporterName: ReporterName = options.reporter ?? "console";
    const stdoutWrite = options.writeStdout ?? ((text: string) => process.stdout.write(text));

    let reporter: RunReporter;
    if (reporterName === "json") {
        reporter = createJsonReporter({ write: stdoutWrite });
    } else if (reporterName === "silent") {
        reporter = createSilentReporter();
    } else {
        reporter = createConsoleReporter({
            color: options.color ?? true,
            write: stdoutWrite,
        });
    }

    let collection;
    try {
        collection = await readCollection(collectionDir);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.output.error(`Failed to load collection from '${collectionDir}': ${message}`);
        return 2;
    }

    const envName = options.env ?? Object.keys(collection.environments)[0];
    if (!envName) {
        options.output.error(
            "No environment specified and collection has no environments. Use --env <name>."
        );
        return 2;
    }

    let report;
    try {
        report = await runCollection(collection, {
            environment: envName,
            bail: options.bail,
            parallel: options.parallel,
            concurrency: options.concurrency,
            timeout: options.timeout,
            reporter,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.output.error(`Collection run failed: ${message}`);
        return 2;
    }

    const { summary } = report;
    if (summary.failed > 0 || summary.errors > 0) {
        return 1;
    }

    return 0;
}
