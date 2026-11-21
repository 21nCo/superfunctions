import fs from "node:fs";
import path from "node:path";

import { contractKey } from "./consumer-contract.table.js";

/**
 * Static `@clifn/core` import scanner for the consumer contract (CLI-11).
 *
 * One regular expression matches the closed form set of static statements: single-line and multi-line
 * named imports, `import type`, inline `type` specifiers and `export ... from`. It runs over the source
 * with comments blanked to spaces (newlines kept, so offsets and line numbers stay those of the file).
 * A statement that names an `@clifn/core` specifier with any other clause (default import, namespace
 * import, `export *`, an empty `{}`) is reported as an unsupported form so it cannot slip past the
 * contract.
 *
 * The scan fails closed: a second pass over the original source reports every `from "@clifn/core..."`
 * or `import "@clifn/core..."` occurrence that the statement expression did not consume, including
 * side-effect imports and anything the comment blanking got wrong.
 *
 * Non-goal: dynamic `import()` and `require()` are not scanned; no consumer uses them for
 * `@clifn/core` at the reference commit.
 */
export const CLIFN_IMPORT_STATEMENT =
  /(?:^|[;\n])[ \t]*(import|export)\b\s*(?:(type)(?=[\s{*])\s*)?([^;'"`=()]*?)\s*\bfrom\s*(['"])(@clifn\/core(?:\/[^'"\n]*)?)\4/dg;

/** Every static occurrence of an `@clifn/core` specifier after `from` or a bare `import`. */
const CLIFN_SPECIFIER_OCCURRENCE = /\b(?:from|import)\s*(['"])(@clifn\/core(?:\/[^'"\n]*)?)\1/dg;

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
  /** Set when the clause is not a non-empty named list, such as `* as core`, a default import or `{}`. */
  readonly unsupportedClause?: string;
  /** Set when the fail-closed pass found the specifier outside any statement the expression matched. */
  readonly unrecognized?: string;
}

/**
 * Replaces line and block comments with spaces, keeping newlines and string, template and character
 * content, so a comment holding quotes, parentheses or `=` cannot hide or break a statement.
 */
export function blankComments(source: string): string {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out[index] = " ";
        index += 1;
      }
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; index < stop; index += 1) {
        if (source[index] !== "\n") {
          out[index] = " ";
        }
      }
    } else if (char === "'" || char === '"' || char === "`") {
      index += 1;
      while (index < source.length && source[index] !== char) {
        // A newline ends an unterminated single-line string so one stray quote cannot swallow the file.
        if (source[index] === "\n" && char !== "`") {
          break;
        }
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
    } else {
      index += 1;
    }
  }
  return out.join("");
}

function parseNamedClause(clause: string, statementTypeOnly: boolean): ScannedSymbol[] | undefined {
  const trimmed = clause.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  const symbols = trimmed
    .slice(1, -1)
    .split(",")
    .map((element) => element.trim())
    .filter((element) => element.length > 0)
    .map((element) => {
      const inlineType = /^type\s+/.test(element);
      const name = element.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      return { symbol: name, typeOnly: statementTypeOnly || inlineType };
    });
  return symbols.length > 0 ? symbols : undefined;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

export function scanSource(source: string, file: string): ScannedImport[] {
  const blanked = blankComments(source);
  const found: { offset: number; scanned: ScannedImport }[] = [];
  const consumedSpecifiers = new Set<number>();

  for (const match of blanked.matchAll(CLIFN_IMPORT_STATEMENT)) {
    const [, statement, typeKeyword, clause, , specifier] = match;
    const keywordOffset = match.indices?.[1]?.[0] ?? match.index ?? 0;
    consumedSpecifiers.add(match.indices?.[5]?.[0] ?? -1);
    const symbols = parseNamedClause(clause, typeKeyword !== undefined);
    const typePrefix = typeKeyword === undefined ? "" : "type ";
    found.push({
      offset: keywordOffset,
      scanned: {
        file,
        line: lineAt(source, keywordOffset),
        statement: statement as "import" | "export",
        specifier,
        symbols: symbols ?? [],
        ...(symbols === undefined ? { unsupportedClause: `${typePrefix}${clause.replace(/\s+/g, " ").trim()}` } : {}),
      },
    });
  }

  // Fail-closed pass over the original text: any specifier occurrence no statement consumed is reported.
  for (const match of source.matchAll(CLIFN_SPECIFIER_OCCURRENCE)) {
    const specifierOffset = match.indices?.[2]?.[0] ?? -1;
    if (consumedSpecifiers.has(specifierOffset)) {
      continue;
    }
    const offset = match.index ?? 0;
    const lineStart = source.lastIndexOf("\n", offset) + 1;
    const lineEnd = source.indexOf("\n", offset);
    found.push({
      offset,
      scanned: {
        file,
        line: lineAt(source, offset),
        statement: "import",
        specifier: match[2],
        symbols: [],
        unrecognized: source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
      },
    });
  }

  return found.sort((left, right) => left.offset - right.offset).map(({ scanned }) => scanned);
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
  const contractSpecifiers = new Set([...contractKeys].map((key) => key.slice(0, key.lastIndexOf("#"))));
  const violations: string[] = [];
  for (const scanned of imports) {
    const where = `${scanned.file}:${scanned.line}`;
    if (scanned.unrecognized !== undefined) {
      violations.push(
        `${where}: \`${scanned.unrecognized}\` names "${scanned.specifier}" in a form the consumer scan does not parse; ` +
          `write it as a named \`import { ... } from\` or \`export { ... } from\` statement, or extend the scanner and ${CONTRACT_TABLE_PATH}.`,
      );
      continue;
    }
    if (scanned.unsupportedClause !== undefined) {
      const subpathNote = contractSpecifiers.has(scanned.specifier)
        ? ""
        : ` "${scanned.specifier}" is also not a subpath in ${CONTRACT_TABLE_PATH}.`;
      violations.push(
        `${where}: \`${scanned.statement} ${scanned.unsupportedClause} from "${scanned.specifier}"\` is not a named import or export; ` +
          `import named symbols so the consumer contract can check them, or extend the scanner and ${CONTRACT_TABLE_PATH}.${subpathNote}`,
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
