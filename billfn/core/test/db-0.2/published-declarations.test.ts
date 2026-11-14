/**
 * A TypeScript host type-checks the declarations core publishes. Every bare
 * module those declarations import must therefore be installed for every host:
 * a hard dependency or a required peer, never an optional peer such as
 * @superfunctions/queue (a host without it would get TS2307 under
 * skipLibCheck: false).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryQueueAdapter, QueueAdapter } from '@superfunctions/queue';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { BillFnQueueAdapter, BillFnQueuedJob } from '../../src/types.js';

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const coreDir = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8')) as Manifest;

/** Emits core's declarations in memory with its own tsconfig. */
function emitDeclarations(): Map<string, string> {
  const configPath = join(coreDir, 'tsconfig.json');
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, coreDir);
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false
  });
  const files = new Map<string, string>();
  const result = program.emit(undefined, (fileName, text) => {
    if (fileName.endsWith('.d.ts')) files.set(fileName, text);
  });
  expect(result.emitSkipped).toBe(false);
  return files;
}

/** The package name of every bare module specifier in a declaration file. */
function importedPackages(text: string): string[] {
  const source = ts.createSourceFile('index.d.ts', text, ts.ScriptTarget.ES2022, true);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    let specifier: ts.Expression | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    }
    if (specifier && ts.isStringLiteral(specifier) && !specifier.text.startsWith('.')) {
      const parts = specifier.text.split('/');
      names.push(specifier.text.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * The declaration emit type-checks all of core in process: about a second
 * alone, several on a loaded two-vCPU CI runner beside the replay suites.
 */
const DECLARATION_EMIT_TIMEOUT_MS = 120_000;

describe('published declarations', () => {
  it('import only packages every host installs', { timeout: DECLARATION_EMIT_TIMEOUT_MS }, () => {
    const declarations = emitDeclarations();
    expect(declarations.size).toBeGreaterThan(0);
    const required = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        (name) => !manifest.peerDependenciesMeta?.[name]?.optional
      )
    ]);
    const missing = [...declarations].flatMap(([file, text]) =>
      importedPackages(text)
        .filter((name) => !required.has(name))
        .map((name) => `${file.slice(coreDir.length)} imports ${name}`)
    );
    expect(missing).toEqual([]);
  });

  it('accept a @superfunctions/queue adapter as the BillFn queue', () => {
    // Type-level: compiled by test/tsconfig.json. A queue adapter must remain assignable.
    const accept = (queue: QueueAdapter<BillFnQueuedJob>): BillFnQueueAdapter => queue;
    const acceptMemory = (queue: MemoryQueueAdapter<BillFnQueuedJob>): BillFnQueueAdapter => queue;
    expect([accept, acceptMemory]).toHaveLength(2);
  });
});
