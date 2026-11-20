import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONSUMER_CONTRACT_KEYS, CONSUMER_PACKAGE_DIRS } from "./consumer-contract.table.js";
import { findContractViolations, scanDirectory, scanSource, type ScannedImport } from "./consumer-import-scanner.js";

// Non-goal: dynamic `import()` and `require()` of @clifn/core are not scanned; no consumer uses them at the
// reference commit.

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

  it("fails when a fixture consumer directory holds an unlisted import", () => {
    const imports = scanDirectory(fixturesDir, fixturesDir);

    expect(imports.map((scanned) => scanned.file)).toContain("unlisted-imports.ts");
    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toHaveLength(5);
  });
});
