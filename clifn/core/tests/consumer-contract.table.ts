/**
 * Closed table of every `@clifn/core` import that the workspace consumer CLIs use (CLI-11).
 *
 * Taken with `git grep "@clifn/core"` over the consumer packages at the reference commit (`dev` at the
 * SFNS-133 merge, 29d3294bc). `consumer-contract.test.ts` imports every runtime row from the built
 * subpath and asserts its kind; `consumer-contract.test-d.ts` imports every type row and asserts the
 * shapes the consumers use; `consumer-scan.test.ts` fails when a consumer imports a symbol or subpath
 * that is not listed here.
 *
 * Removing or changing a row is a breaking change for a published consumer (D2). Add a row when a
 * consumer starts importing a new symbol.
 */

export type ContractKind = "function" | "class" | "const" | "type";

export interface ContractEntry {
  readonly specifier: string;
  readonly symbol: string;
  readonly kind: ContractKind;
  /** Consumer packages that import this symbol from this specifier at the reference commit. */
  readonly usedBy: readonly string[];
}

/** Consumer package directories (relative to the repository root) whose imports the table covers. */
export const CONSUMER_PACKAGE_DIRS = [
  "extfn/cli",
  "plugfn/cli",
  "mailfn/cli",
  "devfn/cli",
  "devfn/config",
] as const;

export const CONSUMER_CONTRACT: readonly ContractEntry[] = [
  { specifier: "@clifn/core", symbol: "ConfigLoaderError", kind: "class", usedBy: ["@devfn/config"] },
  { specifier: "@clifn/core", symbol: "createOutput", kind: "function", usedBy: ["@devfn/cli", "@plugfn/cli"] },
  { specifier: "@clifn/core", symbol: "createScaffold", kind: "function", usedBy: ["@devfn/cli"] },
  { specifier: "@clifn/core", symbol: "loadConfig", kind: "function", usedBy: ["@devfn/config", "@plugfn/cli"] },
  { specifier: "@clifn/core", symbol: "redactValue", kind: "function", usedBy: ["@devfn/cli"] },
  { specifier: "@clifn/core", symbol: "runAction", kind: "function", usedBy: ["@mailfn/cli"] },
  { specifier: "@clifn/core", symbol: "RunnerContext", kind: "type", usedBy: ["@mailfn/cli"] },
  { specifier: "@clifn/core/diagnostics", symbol: "createDiagnostic", kind: "function", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/diagnostics", symbol: "redactValue", kind: "function", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/env", symbol: "readStringEnv", kind: "function", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/exec", symbol: "createExec", kind: "function", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/exec", symbol: "ExecService", kind: "type", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/output", symbol: "createOutput", kind: "function", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/runner", symbol: "runAction", kind: "function", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/runner", symbol: "RunnerActionResult", kind: "type", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/runner", symbol: "RunnerContext", kind: "type", usedBy: ["@extfn/cli"] },
  { specifier: "@clifn/core/runner", symbol: "RunnerOptions", kind: "type", usedBy: ["@extfn/cli"] },
];

export function contractKey(specifier: string, symbol: string): string {
  return `${specifier}#${symbol}`;
}

export const CONSUMER_CONTRACT_KEYS: ReadonlySet<string> = new Set(
  CONSUMER_CONTRACT.map((entry) => contractKey(entry.specifier, entry.symbol)),
);
