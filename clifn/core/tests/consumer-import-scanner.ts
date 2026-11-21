import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { contractKey } from "./consumer-contract.table.js";

/**
 * Static `@clifn/core` import scanner for the consumer contract (CLI-11).
 *
 * The TypeScript parser is the one authority. Every static module reference whose decoded specifier is
 * `@clifn/core` or a subpath is collected from the whole syntax tree (nested blocks, `declare module` bodies
 * and JSDoc included): import and `export ... from` declarations, `import x = require(...)` and inline
 * `import("...").Member` type references. Its specifier, bound symbols and line come from the parser only,
 * so byte order marks, line terminators, comments, string escapes, quoted names and the preceding token
 * cannot change how a reference is read.
 *
 * The issue's one statement expression (`CLIFN_IMPORT_STATEMENT`, the closed form set of named imports,
 * `import type` and `export ... from`) is the locator and cross-check. It runs over the source with every
 * comment blanked; a match that starts inside a string, template, regular expression or JSX text literal is
 * a lookalike and is skipped, and a match in code whose specifier is not a parser reference is reported, so a
 * reference the collector missed fails the scan instead of passing it.
 *
 * Non-goal: dynamic `import()` and `require()` calls are not scanned; no consumer uses them for
 * `@clifn/core` at the reference commit.
 */
export const CLIFN_IMPORT_STATEMENT =
  /\b(import|export)\b\s*(?:(type)\s*)?(\{[^{}]*\}|\*)\s*from\s*(["'])(@clifn\/core(?:\/[^"'\r\n]*)?)\4/dg;

const CLIFN_SPECIFIER = /^@clifn\/core(?:\/.*)?$/s;

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.JsxTextAllWhiteSpaces,
]);

export interface ScannedSymbol {
  readonly symbol: string;
  readonly typeOnly: boolean;
}

export interface ScannedImport {
  readonly file: string;
  readonly line: number;
  readonly statement: "import" | "export";
  /** The decoded module specifier. */
  readonly specifier: string;
  /** The named symbols the reference binds; empty for a zero-binding reference (`{}` or a bare import). */
  readonly symbols: readonly ScannedSymbol[];
  /** Whether the statement expression located this reference (inline type references are never located). */
  readonly located: boolean;
  /** Set for a namespace, default or `*` clause, which binds no named symbol the contract can check. */
  readonly unsupportedClause?: string;
  /** Set for a reference the contract cannot check: `import = require`, a bare inline import type, or a
   * statement match the parser does not see as a module reference. */
  readonly unrecognized?: string;
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

function parse(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function namedSymbols(
  elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>,
  statementTypeOnly: boolean,
): ScannedSymbol[] {
  return elements.map((element) => ({
    symbol: (element.propertyName ?? element.name).text,
    typeOnly: statementTypeOnly || element.isTypeOnly,
  }));
}

/** The clause of an import or export declaration: named symbols, or the clause text when it binds none by name. */
function readClause(
  statement: ts.ImportDeclaration | ts.JSDocImportTag | ts.ExportDeclaration,
  sourceFile: ts.SourceFile,
): { symbols: ScannedSymbol[] } | { unsupportedClause: string } {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      return { symbols: namedSymbols(clause.elements, statement.isTypeOnly) };
    }
    const text = clause === undefined ? "*" : normalized(clause.getText(sourceFile));
    return { unsupportedClause: statement.isTypeOnly ? `type ${text}` : text };
  }
  const clause = statement.importClause;
  if (clause === undefined) {
    return { symbols: [] };
  }
  if (clause.name === undefined && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
    return { symbols: namedSymbols(clause.namedBindings.elements, clause.isTypeOnly) };
  }
  return { unsupportedClause: normalized(clause.getText(sourceFile)) };
}

/** The exported member an inline `import("...").A.B` type names: the leftmost name of its qualifier. */
function leftmostName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmostName(name.left);
}

interface CollectedReference extends Omit<ScannedImport, "located"> {
  /** Offset just after the opening quote of a declaration's specifier; undefined for inline type references. */
  readonly specifierOffset?: number;
}

interface ParsedFile {
  readonly references: CollectedReference[];
  /** Sorted, non-overlapping [start, end) ranges of string, template, regular expression and JSX text tokens. */
  readonly literals: Array<readonly [number, number]>;
}

/**
 * A qualifier-less inline module type names one export only through a string-literal index,
 * `(typeof import("..."))["A"]`, through any parentheses; every other use names the whole module.
 */
function indexedMember(node: ts.ImportTypeNode, sourceFile: ts.SourceFile): Partial<CollectedReference> {
  let object: ts.Node = node;
  while (ts.isParenthesizedTypeNode(object.parent)) {
    object = object.parent;
  }
  const access = object.parent;
  if (
    ts.isIndexedAccessTypeNode(access) &&
    access.objectType === object &&
    ts.isLiteralTypeNode(access.indexType) &&
    ts.isStringLiteral(access.indexType.literal)
  ) {
    return { symbols: [{ symbol: access.indexType.literal.text, typeOnly: true }] };
  }
  return { unrecognized: normalized(node.getText(sourceFile)) };
}

function lineOf(sourceFile: ts.SourceFile, offset: number): number {
  return sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
}

function collect(sourceFile: ts.SourceFile, file: string): ParsedFile {
  const references: CollectedReference[] = [];
  const literals: Array<readonly [number, number]> = [];
  const reference = (node: ts.Node, specifier: ts.StringLiteralLike, fields: Partial<CollectedReference>): void => {
    if (!CLIFN_SPECIFIER.test(specifier.text)) {
      return;
    }
    references.push({
      file,
      line: lineOf(sourceFile, node.getStart(sourceFile)),
      statement: "import",
      specifier: specifier.text,
      symbols: [],
      ...fields,
    });
  };
  const visit = (node: ts.Node, inJsDoc: boolean): void => {
    if (LITERAL_KINDS.has(node.kind) && !inJsDoc) {
      literals.push([node.getStart(sourceFile), node.end]);
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
        reference(node, specifier, {
          statement: ts.isImportDeclaration(node) ? "import" : "export",
          specifierOffset: specifier.getStart(sourceFile) + 1,
          ...readClause(node, sourceFile),
        });
      }
    } else if (ts.isJSDocImportTag(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      // `/** @import { A } from "..." */` binds types like `import type`; it sits in a comment, so it is never located.
      const clause = readClause(node, sourceFile);
      reference(node, node.moduleSpecifier, "symbols" in clause ? { symbols: clause.symbols.map((bound) => ({ ...bound, typeOnly: true })) } : clause);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression;
      if (ts.isStringLiteralLike(specifier)) {
        reference(node, specifier, {
          specifierOffset: specifier.getStart(sourceFile) + 1,
          unrecognized: normalized(node.getText(sourceFile)),
        });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      reference(
        node,
        node.argument.literal,
        node.qualifier !== undefined
          ? { symbols: [{ symbol: leftmostName(node.qualifier), typeOnly: true }] }
          : indexedMember(node, sourceFile),
      );
    }
    for (const doc of (node as { jsDoc?: readonly ts.Node[] }).jsDoc ?? []) {
      visit(doc, true);
    }
    ts.forEachChild(node, (child) => visit(child, inJsDoc));
  };
  visit(sourceFile, false);
  return { references, literals };
}

function insideLiteral(literals: ParsedFile["literals"], offset: number): boolean {
  let low = 0;
  let high = literals.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = literals[middle];
    if (offset < start) {
      high = middle - 1;
    } else if (offset >= end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Replaces every comment the TypeScript parser sees with spaces, keeping newlines and all string,
 * template, regular expression and JSX text content, so a comment cannot hide or break a statement.
 */
export function blankComments(source: string, file = "source.ts"): string {
  return blankParsedComments(parse(source, file));
}

function blankParsedComments(sourceFile: ts.SourceFile): string {
  const text = sourceFile.text;
  const out = text.split("");
  const blank = (range: { readonly pos: number; readonly end: number }): void => {
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
  // A hashbang line is trivia too; blank it so its text is never read as a statement.
  const hashbang = ts.getShebang(text);
  if (hashbang !== undefined) {
    blank({ pos: 0, end: hashbang.length });
  }
  return out.join("");
}

export function scanSource(source: string, file: string): ScannedImport[] {
  const sourceFile = parse(source, file);
  const { references, literals } = collect(sourceFile, file);
  const bySpecifierOffset = new Map(
    references.flatMap((found) => (found.specifierOffset === undefined ? [] : [[found.specifierOffset, found] as const])),
  );

  // Cross-check: each statement match in code must be a parser reference. A match that starts inside a literal is
  // skipped and the scan resumes one character later, so it cannot consume a real statement after it.
  const located = new Set<CollectedReference>();
  const unmatched: ScannedImport[] = [];
  const pattern = new RegExp(CLIFN_IMPORT_STATEMENT.source, CLIFN_IMPORT_STATEMENT.flags);
  const blanked = blankParsedComments(sourceFile);
  for (let match = pattern.exec(blanked); match !== null; match = pattern.exec(blanked)) {
    if (insideLiteral(literals, match.index)) {
      pattern.lastIndex = match.index + 1;
      continue;
    }
    const found = bySpecifierOffset.get(match.indices?.[5]?.[0] ?? -1);
    if (found === undefined) {
      unmatched.push({
        file,
        line: lineOf(sourceFile, match.index),
        statement: match[1] as "import" | "export",
        specifier: match[5],
        symbols: [],
        located: true,
        unrecognized: normalized(match[0]),
      });
    } else {
      located.add(found);
    }
  }

  const scanned = references.map((found): ScannedImport => {
    const { specifierOffset: _offset, ...fields } = found;
    return { ...fields, located: located.has(found) };
  });
  return [...scanned, ...unmatched].sort((left, right) => left.line - right.line);
}

/** Alphabetical, with a code-unit tie-break so distinct paths that collate equally (`é`, `e\u0301`) keep one order. */
export function compareSourcePaths(left: string, right: string): number {
  return left.localeCompare(right, "en") || (left < right ? -1 : Number(left > right));
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
  return files.sort(compareSourcePaths);
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
    const listedSubpath = contractSpecifiers.has(scanned.specifier);
    const subpathNote = listedSubpath ? "" : ` "${scanned.specifier}" is also not a subpath in ${CONTRACT_TABLE_PATH}.`;
    if (scanned.unrecognized !== undefined) {
      violations.push(
        `${where}: \`${scanned.unrecognized}\` names "${scanned.specifier}" in a form the consumer scan does not parse; ` +
          `write it as a named \`import { ... } from\` or \`export { ... } from\` statement, or extend the scanner and ${CONTRACT_TABLE_PATH}.${subpathNote}`,
      );
    } else if (scanned.unsupportedClause !== undefined) {
      violations.push(
        `${where}: \`${scanned.statement} ${scanned.unsupportedClause} from "${scanned.specifier}"\` is not a named import or export; ` +
          `import named symbols so the consumer contract can check them, or extend the scanner and ${CONTRACT_TABLE_PATH}.${subpathNote}`,
      );
    } else if (scanned.symbols.length === 0) {
      // A zero-binding reference (`import {} from` or a bare import) depends only on the subpath existing.
      if (!listedSubpath) {
        violations.push(
          `${where}: "${scanned.specifier}" is not a subpath in the @clifn/core consumer contract; ` +
            `add the rows its consumers rely on to ${CONTRACT_TABLE_PATH}, or remove the reference.`,
        );
      }
    } else {
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
  }
  return violations;
}
