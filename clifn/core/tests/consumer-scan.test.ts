import fs from "node:fs";
import os from "node:os";
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
    // The statement expression locates every form of the closed set; the parser supplies what each one binds.
    expect(imports.every((scanned) => scanned.located)).toBe(true);
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
      startingWith('fail-closed-forms.ts:11: "@clifn/core/scaffold" is not a subpath in the @clifn/core consumer contract'),
      startingWith('fail-closed-forms.ts:12: "@clifn/core/prompt" is not a subpath in the @clifn/core consumer contract'),
      startingWith('fail-closed-forms.ts:13: "formatDiagnosticsText" from "@clifn/core/diagnostics" is not in'),
    ]);
  });

  it("accepts a zero-binding reference to a listed subpath and checks the subpath of every reference", () => {
    const source = [
      'import {} from "@clifn/core/runner";',
      'export {} from "@clifn/core/env";',
      'import "@clifn/core/exec";',
      'export * from "@clifn/core/ui";',
    ].join("\n");
    const imports = scanSource(source, "zero.ts");

    expect(imports.map(({ line, specifier, symbols }) => ({ line, specifier, symbols }))).toEqual([
      { line: 1, specifier: "@clifn/core/runner", symbols: [] },
      { line: 2, specifier: "@clifn/core/env", symbols: [] },
      { line: 3, specifier: "@clifn/core/exec", symbols: [] },
      { line: 4, specifier: "@clifn/core/ui", symbols: [] },
    ]);
    const violations = findContractViolations(imports, CONSUMER_CONTRACT_KEYS);
    expect(violations).toEqual([startingWith('zero.ts:4: `export * from "@clifn/core/ui"` is not a named import or export')]);
    expect(violations[0]).toContain('"@clifn/core/ui" is also not a subpath in');
  });

  // Each form is valid TypeScript the parser reads to the same reference; the listed variant must parse to
  // exactly its symbol and the unlisted variant must fail on its symbol, at the parser's line.
  const pairedForms: ReadonlyArray<readonly [form: string, build: (symbol: string, specifier: string) => string, line: number]> = [
    ["a byte order mark", (symbol, specifier) => `\uFEFFimport { ${symbol} } from "${specifier}";\n`, 1],
    ["CR line ends", (symbol, specifier) => `const a = 1;\r\rimport { ${symbol} } from "${specifier}";\r`, 3],
    ["CRLF line ends", (symbol, specifier) => `const a = 1;\r\nimport { ${symbol} } from "${specifier}";\r\n`, 2],
    ["a line separator", (symbol, specifier) => `const a = 1;\u2028import { ${symbol} } from "${specifier}";\n`, 2],
    ["a paragraph separator", (symbol, specifier) => `const a = 1;\u2029import { ${symbol} } from "${specifier}";\n`, 2],
    ["a statement after a block", (symbol, specifier) => `const ok = 1;\n{} import { ${symbol} } from "${specifier}";\n`, 2],
    ["an escaped specifier", (symbol, specifier) => `import { ${symbol} } from "${specifier.replace("@", "\\u0040")}";\n`, 1],
    ["a quoted name", (symbol, specifier) => `import { "${symbol}" as local } from "${specifier}";\n`, 1],
    ["a quoted alias", (symbol, specifier) => `export { ${symbol} as "local" } from "${specifier}";\n`, 1],
    ["an inline type specifier", (symbol, specifier) => `import { type ${symbol} as Local } from "${specifier}";\n`, 1],
    ["a template that looks like an import", (symbol, specifier) => `const t = \`\nimport { x } from "@clifn/core/\`; import { ${symbol} } from "${specifier}";\n`, 2],
  ];

  it.each(pairedForms)("reads a listed and an unlisted symbol through %s", (_form, build, line) => {
    const listed = scanSource(build("createOutput", "@clifn/core/output"), "listed.ts");
    expect(listed.map(({ line: at, specifier, symbols }) => ({ line: at, specifier, symbols: symbols.map((s) => s.symbol) }))).toEqual([
      { line, specifier: "@clifn/core/output", symbols: ["createOutput"] },
    ]);
    expect(findContractViolations(listed, CONSUMER_CONTRACT_KEYS)).toEqual([]);

    const unlisted = findContractViolations(scanSource(build("readIntEnv", "@clifn/core"), "unlisted.ts"), CONSUMER_CONTRACT_KEYS);
    expect(unlisted).toEqual([startingWith(`unlisted.ts:${line}: "readIntEnv" from "@clifn/core" is not in the @clifn/core consumer contract`)]);
  });

  it("checks inline import types against the contract and leaves runtime import() unscanned", () => {
    const source = [
      'export type Unlisted = import("@clifn/core/output").OutputOptions;',
      'import type { OutputOptions } from "@clifn/core/output";',
      'export type Listed = import("@clifn/core/exec").ExecService | typeof import("@clifn/core").createOutput;',
      'export type Whole = import("@clifn/core/output");',
      'export const lazy = () => import("@clifn/core/prompt");',
    ].join("\n");
    const imports = scanSource(source, "inline-types.ts");

    expect(imports.map(({ line, specifier, symbols, located }) => ({ line, specifier, symbols: symbols.map((s) => s.symbol), located }))).toEqual([
      { line: 1, specifier: "@clifn/core/output", symbols: ["OutputOptions"], located: false },
      { line: 2, specifier: "@clifn/core/output", symbols: ["OutputOptions"], located: true },
      { line: 3, specifier: "@clifn/core/exec", symbols: ["ExecService"], located: false },
      { line: 3, specifier: "@clifn/core", symbols: ["createOutput"], located: false },
      { line: 4, specifier: "@clifn/core/output", symbols: [], located: false },
    ]);
    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toEqual([
      startingWith('inline-types.ts:1: "OutputOptions" from "@clifn/core/output" is not in'),
      startingWith('inline-types.ts:2: "OutputOptions" from "@clifn/core/output" is not in'),
      startingWith('inline-types.ts:4: `import("@clifn/core/output")` names "@clifn/core/output" in a form the consumer scan does not parse'),
    ]);

    const jsDoc = scanSource('/** @type {import("@clifn/core/output").OutputOptions} */\nlet options;\n', "doc.js");
    expect(findContractViolations(jsDoc, CONSUMER_CONTRACT_KEYS)).toEqual([
      startingWith('doc.js:1: "OutputOptions" from "@clifn/core/output" is not in'),
    ]);
  });

  it("reports a statement match the parser does not read as a module reference", () => {
    const imports = scanSource('let o = { export { readIntEnv } from "@clifn/core" };\n', "malformed.ts");

    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toEqual([
      startingWith('malformed.ts:1: `export { readIntEnv } from "@clifn/core"` names "@clifn/core" in a form the consumer scan does not parse'),
    ]);
  });

  it("scans pathological input in bounded time", () => {
    const inputs = [
      `import ${" ".repeat(200_000)}`,
      `import {${"a,".repeat(100_000)}`,
      "import { a } from '".repeat(20_000),
      `export type${" ".repeat(200_000)}{`,
      `import * ${" ".repeat(200_000)}fro`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      scanSource(input, "large.ts");
      expect(performance.now() - started).toBeLessThan(5_000);
    }
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

  it("fails when a fixture consumer directory holds an unlisted import", () => {
    const imports = scanDirectory(fixturesDir, fixturesDir);

    expect(imports.map((scanned) => scanned.file)).toEqual(
      expect.arrayContaining(["fail-closed-forms.ts", "statement-boundary-forms.ts", "unlisted-imports.ts"]),
    );
    expect(findContractViolations(imports, CONSUMER_CONTRACT_KEYS)).toHaveLength(18);
  });

  it("lists files in a stable, case-insensitive alphabetical order", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clifn-consumer-scan-"));
    try {
      for (const name of ["B.ts", "a.ts", "c.ts"]) {
        fs.writeFileSync(path.join(directory, name), 'import { readIntEnv } from "@clifn/core";\n');
      }
      expect(scanDirectory(directory, directory).map((scanned) => scanned.file)).toEqual(["a.ts", "B.ts", "c.ts"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
