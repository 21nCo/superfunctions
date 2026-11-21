import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONSUMER_CONTRACT_KEYS, CONSUMER_PACKAGE_DIRS } from "./consumer-contract.table.js";
import { findContractViolations, scanDirectory, scanSource, type ScannedImport } from "./consumer-import-scanner.js";

// Non-goal: dynamic `import()` and `require()` of @clifn/core are not scanned; no consumer uses them at the
// reference commit.
//
// Known limitation (deferred to CLI-3): clifn/core/turbo.json declares the consumer trees as inputs of
// @clifn/core#test, so a consumer change invalidates its cache, but the root CI planner (ci-plan) schedules
// @clifn/core#test only when clifn/core or one of its dependencies changes. A consumer-only PR therefore
// does not run this scan in CI; the next PR that touches @clifn/core does.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturesDir = fileURLToPath(new URL("./fixtures/consumer-scan", import.meta.url));

function startingWith(prefix: string): unknown {
  return expect.stringMatching(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
}

function scanFixture(name: string): ScannedImport[] {
  return scanSource(fs.readFileSync(path.join(fixturesDir, name), "utf8"), name);
}

describe("@clifn/core consumer import scan", () => {
  it.each(CONSUMER_PACKAGE_DIRS)("finds only contract imports in %s", (consumerDir) => {
    const imports = scanDirectory(path.join(repoRoot, consumerDir), repoRoot);

    // A consumer without any match would mean the scan stopped seeing its imports.
    expect(imports.flatMap((scanned) => scanned.symbols).length).toBeGreaterThan(0);
    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toEqual([]);
  });

  it("parses every supported static form", () => {
    const imports = scanFixture("listed-forms.ts");

    expect(
      imports.map(({ line, statement, specifier, symbols }) => ({ line, statement, specifier, symbols })),
    ).toEqual([
      {
        line: 2,
        statement: "import",
        specifier: "@clifn/core",
        symbols: [
          { symbol: "createOutput", typeOnly: false },
          { symbol: "loadConfig", typeOnly: false },
        ],
      },
      {
        line: 3,
        statement: "import",
        specifier: "@clifn/core/diagnostics",
        symbols: [
          { symbol: "createDiagnostic", typeOnly: false },
          { symbol: "redactValue", typeOnly: false },
        ],
      },
      {
        line: 8,
        statement: "import",
        specifier: "@clifn/core/exec",
        symbols: [{ symbol: "ExecService", typeOnly: true }],
      },
      {
        line: 9,
        statement: "import",
        specifier: "@clifn/core",
        symbols: [
          { symbol: "runAction", typeOnly: false },
          { symbol: "RunnerContext", typeOnly: true },
        ],
      },
      {
        line: 10,
        statement: "export",
        specifier: "@clifn/core/env",
        symbols: [{ symbol: "readStringEnv", typeOnly: false }],
      },
      {
        line: 11,
        statement: "export",
        specifier: "@clifn/core/runner",
        symbols: [
          { symbol: "RunnerActionResult", typeOnly: true },
          { symbol: "RunnerOptions", typeOnly: true },
        ],
      },
      {
        line: 15,
        statement: "import",
        specifier: "@clifn/core/exec",
        symbols: [{ symbol: "createExec", typeOnly: false }],
      },
      {
        line: 16,
        statement: "import",
        specifier: "@clifn/core",
        symbols: [{ symbol: "createScaffold", typeOnly: false }],
      },
      {
        line: 21,
        statement: "import",
        specifier: "@clifn/core",
        symbols: [{ symbol: "ConfigLoaderError", typeOnly: false }],
      },
    ]);
    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toEqual([]);
  });

  it("fails on an unlisted symbol, an unlisted subpath and a non-named clause", () => {
    const violations = findContractViolations(scanFixture("unlisted-imports.ts"), CONSUMER_CONTRACT_KEYS);

    const addRow = "to clifn/core/tests/consumer-contract.table.ts";
    expect(violations).toEqual([
      startingWith('unlisted-imports.ts:2: "readIntEnv" from "@clifn/core" is not in the @clifn/core consumer contract'),
      startingWith('unlisted-imports.ts:3: "createPrompt" from "@clifn/core/prompt" is not in'),
      startingWith('unlisted-imports.ts:6: "OutputOptions" from "@clifn/core/output" is not in'),
      startingWith('unlisted-imports.ts:7: "formatDiagnosticsJson" from "@clifn/core/diagnostics" is not in'),
      startingWith('unlisted-imports.ts:8: `import * as runner from "@clifn/core/runner"` is not a named import'),
    ]);
    for (const message of violations.slice(0, 4)) {
      expect(message).toContain(`add { specifier: "`);
      expect(message).toContain(addRow);
    }
  });

  it("fails closed on compact, commented, empty and side-effect forms", () => {
    const violations = findContractViolations(scanFixture("fail-closed-forms.ts"), CONSUMER_CONTRACT_KEYS);

    expect(violations).toEqual([
      startingWith('fail-closed-forms.ts:2: "readIntEnv" from "@clifn/core" is not in'),
      startingWith('fail-closed-forms.ts:3: "createPrompt" from "@clifn/core/prompt" is not in'),
      startingWith('fail-closed-forms.ts:7: "readNumberEnv" from "@clifn/core/env" is not in'),
      startingWith('fail-closed-forms.ts:11: `import {} from "@clifn/core/scaffold"` is not a named import'),
      startingWith('fail-closed-forms.ts:12: `import "@clifn/core/runner";` names "@clifn/core/runner" in a form the consumer scan does not parse'),
      startingWith('fail-closed-forms.ts:13: "formatDiagnosticsText" from "@clifn/core/diagnostics" is not in'),
    ]);
    expect(violations[3]).toContain('"@clifn/core/scaffold" is also not a subpath in');
  });

  it("reports a declaration the statement expression did not consume", () => {
    // A listed symbol after a block on the same line is valid at module scope but does not start a line or
    // follow `;`, so only the parser-side reconciliation sees it.
    const imports = scanSource('const ok = 1;\n{} import { createOutput } from "@clifn/core/output";\n', "inline.ts");

    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toEqual([
      startingWith('inline.ts:2: `import { createOutput } from "@clifn/core/output";` names "@clifn/core/output"'),
    ]);
  });

  it("keeps each statement to its own symbols across export lists, comments and literals", () => {
    const violations = findContractViolations(scanFixture("statement-boundary-forms.ts"), CONSUMER_CONTRACT_KEYS);

    expect(violations).toEqual([
      startingWith('statement-boundary-forms.ts:4: "readIntEnv" from "@clifn/core" is not in'),
      startingWith('statement-boundary-forms.ts:6: "OutputOptions" from "@clifn/core/output" is not in'),
      startingWith('statement-boundary-forms.ts:7: "readNumberEnv" from "@clifn/core/env" is not in'),
      startingWith('statement-boundary-forms.ts:8: "createPrompt" from "@clifn/core/prompt" is not in'),
      startingWith('statement-boundary-forms.ts:9: "formatDiagnosticsJson" from "@clifn/core/diagnostics" is not in'),
      startingWith('statement-boundary-forms.ts:12: `import core = require("@clifn/core");` names "@clifn/core" in a form'),
      startingWith('statement-boundary-forms.ts:14: "readStringEnv" from "@clifn/core" is not in'),
    ]);
  });

  it("parses listed symbols exactly, including after a template that looks like an import, and ignores commented-out and string-embedded imports", () => {
    const imports = scanFixture("boundary-listed-forms.ts");

    expect(imports.map(({ line, specifier, symbols }) => ({ line, specifier, symbols }))).toEqual([
      { line: 2, specifier: "@clifn/core", symbols: [{ symbol: "createOutput", typeOnly: false }] },
      { line: 4, specifier: "@clifn/core", symbols: [{ symbol: "loadConfig", typeOnly: false }] },
      { line: 5, specifier: "@clifn/core/exec", symbols: [{ symbol: "createExec", typeOnly: false }] },
      { line: 6, specifier: "@clifn/core/diagnostics", symbols: [{ symbol: "createDiagnostic", typeOnly: false }] },
      { line: 13, specifier: "@clifn/core/runner", symbols: [{ symbol: "runAction", typeOnly: false }] },
      { line: 15, specifier: "@clifn/core/diagnostics", symbols: [{ symbol: "redactValue", typeOnly: false }] },
    ]);
    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toEqual([]);
  });

  it("reports a statement match whose symbols differ from the parsed declaration", () => {
    // A quoted specifier name is valid syntax the brace-list parse reads differently from the parser.
    const imports = scanSource('import { "createOutput" as out } from "@clifn/core";\n', "quoted.ts");

    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toEqual([
      startingWith('quoted.ts:1: `import { "createOutput" as out } from "@clifn/core";` names "@clifn/core" in a form'),
    ]);
  });

  it("fails when a fixture consumer directory holds an unlisted import", () => {
    const imports = scanDirectory(fixturesDir, fixturesDir);

    expect(imports.map((scanned) => scanned.file)).toEqual(
      expect.arrayContaining(["fail-closed-forms.ts", "statement-boundary-forms.ts", "unlisted-imports.ts"]),
    );
    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toHaveLength(18);
  });
});
