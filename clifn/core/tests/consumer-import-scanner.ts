import fs from "node:fs";
import path from "node:path";

import { contractKey } from "./consumer-contract.table.js";

/**
 * Static `@clifn/core` import scanner for the consumer contract (CLI-11).
 *
 * One regular expression matches the closed form set of static statements: single-line and multi-line
 * named imports, `import type`, inline `type` specifiers and `export ... from`. A statement that names
 * an `@clifn/core` specifier with any other clause (default import, namespace import, `export *`) is
 * reported as an unsupported form so it cannot slip past the contract.
 *
 * Non-goal: dynamic `import()` and `require()` are not scanned; no consumer uses them for
 * `@clifn/core` at the reference commit.
 */
export const CLIFN_IMPORT_STATEMENT =
  /(?:^|[;\n])[ \t]*(import|export)\s+(type\s+)?([^;'"`=()]*?)\s*from\s*(['"])(@clifn\/core(?:\/[^'"\n]*)?)\4/g;

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);

export interface ScannedSymbol {
  readonly symbol: string;
  readonly typeOnly: boolean;
}

export interface ScannedImport {
  readonly file: string;
  readonly line: number;
  readonly statement: "import" | "export";
  readonly specifier: string;
  readonly symbols: readonly ScannedSymbol[];
  /** Set when the clause is not a named list, such as `* as core` or a default import. */
  readonly unsupportedClause?: string;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function parseNamedClause(clause: string, statementTypeOnly: boolean): ScannedSymbol[] | undefined {
  const trimmed = stripComments(clause).trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((element) => element.trim())
    .filter((element) => element.length > 0)
    .map((element) => {
      const inlineType = /^type\s+/.test(element);
      const name = element.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      return { symbol: name, typeOnly: statementTypeOnly || inlineType };
    });
}

export function scanSource(source: string, file: string): ScannedImport[] {
  const found: ScannedImport[] = [];
  for (const match of source.matchAll(CLIFN_IMPORT_STATEMENT)) {
    const [whole, statement, typeKeyword, clause, , specifier] = match;
    const keywordOffset = (match.index ?? 0) + whole.search(/import|export/);
    const line = source.slice(0, keywordOffset).split("\n").length;
    const symbols = parseNamedClause(clause, typeKeyword !== undefined);
    found.push({
      file,
      line,
      statement: statement as "import" | "export",
      specifier,
      symbols: symbols ?? [],
      ...(symbols === undefined ? { unsupportedClause: stripComments(clause).trim() } : {}),
    });
  }
  return found;
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(entryPath));
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

/** Scans every source file under `directory`, reporting files relative to `relativeTo`. */
export function scanDirectory(directory: string, relativeTo: string): ScannedImport[] {
  return listSourceFiles(directory).flatMap((file) =>
    scanSource(fs.readFileSync(file, "utf8"), path.relative(relativeTo, file).split(path.sep).join("/")),
  );
}

const CONTRACT_TABLE_PATH = "clifn/core/tests/consumer-contract.table.ts";

/** Returns one message per import that the contract table does not cover. */
export function findContractViolations(imports: readonly ScannedImport[], contractKeys: ReadonlySet<string>): string[] {
  const violations: string[] = [];
  for (const scanned of imports) {
    const where = `${scanned.file}:${scanned.line}`;
    if (scanned.unsupportedClause !== undefined) {
      violations.push(
        `${where}: \`${scanned.statement} ${scanned.unsupportedClause} from "${scanned.specifier}"\` is not a named import or export; ` +
          `import named symbols so the consumer contract can check them, or extend the scanner and ${CONTRACT_TABLE_PATH}.`,
      );
      continue;
    }
    for (const { symbol } of scanned.symbols) {
      if (!contractKeys.has(contractKey(scanned.specifier, symbol))) {
        violations.push(
          `${where}: "${symbol}" from "${scanned.specifier}" is not in the @clifn/core consumer contract; ` +
            `add { specifier: "${scanned.specifier}", symbol: "${symbol}", kind, usedBy } to ${CONTRACT_TABLE_PATH} ` +
            `and cover it in consumer-contract.test-d.ts when it is a type.`,
        );
      }
    }
  }
  return violations;
}
