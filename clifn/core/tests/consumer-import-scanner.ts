import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { contractKey } from "./consumer-contract.table.js";

/**
 * Static `@clifn/core` import scanner for the consumer contract (CLI-11).
 *
 * One regular expression matches the closed form set of static statements: single-line and multi-line
 * named imports, `import type`, inline `type` specifiers and `export ... from`. Its clause is one brace
 * list (or a namespace, default or `*` clause, reported as unsupported), so a match never spans two
 * statements. It runs over the source with every comment the TypeScript parser sees blanked to spaces
 * (newlines kept, so offsets and line numbers stay those of the file).
 *
 * The scan fails closed against the TypeScript parser: every import, export-from and import-equals
 * declaration whose module specifier is `@clifn/core` or a subpath must be the exact specifier position a
 * statement match consumed, and the match must name exactly the symbols the declaration binds; any other
 * declaration is reported as unrecognized. A regular-expression match the parser does not see as a module
 * specifier (inside a string, template or regular expression literal) is not a module reference and is
 * dropped.
 *
 * Non-goal: dynamic `import()` and `require()` are not scanned; no consumer uses them for
 * `@clifn/core` at the reference commit.
 */
export const CLIFN_IMPORT_STATEMENT =
  /(?:^|[;\n])[ \t]*(import|export)\b\s*(?:(type)(?=[\s{*])\s*)?(\{[^{}]*\}|\*\s*as\s+[\w$]+|\*|[\w$]+(?:\s*,\s*(?:\{[^{}]*\}|\*\s*as\s+[\w$]+))?)\s*\bfrom\s*(['"])(@clifn\/core(?:\/[^'"\n]*)?)\4/dg;

const CLIFN_SPECIFIER = /^@clifn\/core(?:\/.*)?$/s;

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
  /** Set when the parser found a declaration the statement expression did not parse to the same symbols. */
  readonly unrecognized?: string;
}

/** A static `@clifn/core` module reference as the TypeScript parser sees it. */
interface ParsedDeclaration {
  readonly start: number;
  readonly specifierOffset: number;
  readonly specifier: string;
  readonly text: string;
  /** The bound named symbols, or undefined for any other clause (namespace, default, `*`, `{}`, none). */
  readonly symbols: readonly ScannedSymbol[] | undefined;
}

function scriptKindFor(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function namedSymbols(
  elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>,
  statementTypeOnly: boolean,
): ScannedSymbol[] | undefined {
  if (elements.length === 0) {
    return undefined;
  }
  return elements.map((element) => ({
    symbol: (element.propertyName ?? element.name).text,
    typeOnly: statementTypeOnly || element.isTypeOnly,
  }));
}

function clauseSymbols(statement: ts.ImportDeclaration | ts.ExportDeclaration): ScannedSymbol[] | undefined {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    return clause !== undefined && ts.isNamedExports(clause)
      ? namedSymbols(clause.elements, statement.isTypeOnly)
      : undefined;
  }
  const clause = statement.importClause;
  if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined) {
    return undefined;
  }
  return ts.isNamedImports(clause.namedBindings)
    ? namedSymbols(clause.namedBindings.elements, clause.isTypeOnly)
    : undefined;
}

function moduleSpecifierOf(statement: ts.Statement): ts.Expression | undefined {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    return statement.moduleSpecifier;
  }
  if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
    return statement.moduleReference.expression;
  }
  return undefined;
}

/** Collects every static `@clifn/core` declaration, including those inside `declare module` blocks. */
function parsedDeclarations(sourceFile: ts.SourceFile): ParsedDeclaration[] {
  const found: ParsedDeclaration[] = [];
  const visitStatements = (statements: readonly ts.Statement[]): void => {
    for (const statement of statements) {
      if (ts.isModuleDeclaration(statement)) {
        let body = statement.body;
        while (body !== undefined && ts.isModuleDeclaration(body)) {
          body = body.body;
        }
        if (body !== undefined && ts.isModuleBlock(body)) {
          visitStatements(body.statements);
        }
        continue;
      }
      const specifier = moduleSpecifierOf(statement);
      if (specifier === undefined || !ts.isStringLiteralLike(specifier) || !CLIFN_SPECIFIER.test(specifier.text)) {
        continue;
      }
      found.push({
        start: statement.getStart(sourceFile),
        specifierOffset: specifier.getStart(sourceFile) + 1,
        specifier: specifier.text,
        text: statement.getText(sourceFile).replace(/\s+/g, " ").trim(),
        symbols: ts.isImportEqualsDeclaration(statement) ? undefined : clauseSymbols(statement),
      });
    }
  };
  visitStatements(sourceFile.statements);
  return found;
}

/**
 * Replaces every comment the TypeScript parser sees with spaces, keeping newlines and all string,
 * template, regular expression and JSX text content, so a comment cannot hide or break a statement.
 */
export function blankComments(source: string, file = "source.ts"): string {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  return blankParsedComments(sourceFile);
}

function blankParsedComments(sourceFile: ts.SourceFile): string {
  const text = sourceFile.text;
  const out = text.split("");
  const blank = (range: ts.CommentRange): void => {
    for (let index = range.pos; index < range.end; index += 1) {
      if (out[index] !== "\n" && out[index] !== "\r") {
        out[index] = " ";
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    // JSX text is content, not trivia: a `//` inside it is not a comment.
    if (node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces) {
      return;
    }
    // Comments before the first newline are trailing ranges and the rest leading ranges; together they
    // are every comment in the trivia before this token.
    ts.getTrailingCommentRanges(text, node.pos)?.forEach(blank);
    ts.getLeadingCommentRanges(text, node.pos)?.forEach(blank);
  };
  visit(sourceFile);
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

function sameSymbols(left: readonly ScannedSymbol[] | undefined, right: readonly ScannedSymbol[] | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.length === right.length &&
    left.every((symbol, index) => symbol.symbol === right[index].symbol && symbol.typeOnly === right[index].typeOnly)
  );
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

interface StatementMatch {
  readonly statement: "import" | "export";
  readonly keywordOffset: number;
  readonly specifier: string;
  readonly clause: string;
  readonly symbols: readonly ScannedSymbol[] | undefined;
}

export function scanSource(source: string, file: string): ScannedImport[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const blanked = blankParsedComments(sourceFile);

  const matches = new Map<number, StatementMatch>();
  for (const match of blanked.matchAll(CLIFN_IMPORT_STATEMENT)) {
    const [, statement, typeKeyword, clause, , specifier] = match;
    const typePrefix = typeKeyword === undefined ? "" : "type ";
    matches.set(match.indices?.[5]?.[0] ?? -1, {
      statement: statement as "import" | "export",
      keywordOffset: match.indices?.[1]?.[0] ?? match.index ?? 0,
      specifier,
      clause: `${typePrefix}${clause.replace(/\s+/g, " ").trim()}`,
      symbols: parseNamedClause(clause, typeKeyword !== undefined),
    });
  }

  // Reconcile with the parser: each declaration must be one statement match with exactly its symbols.
  return parsedDeclarations(sourceFile).map((declaration): ScannedImport => {
    const match = matches.get(declaration.specifierOffset);
    if (match === undefined || !sameSymbols(match.symbols, declaration.symbols)) {
      return {
        file,
        line: lineAt(source, declaration.start),
        statement: match?.statement ?? "import",
        specifier: declaration.specifier,
        symbols: [],
        unrecognized: declaration.text,
      };
    }
    return {
      file,
      line: lineAt(source, match.keywordOffset),
      statement: match.statement,
      specifier: match.specifier,
      symbols: match.symbols ?? [],
      ...(match.symbols === undefined ? { unsupportedClause: match.clause } : {}),
    };
  });
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
