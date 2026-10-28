import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  strict: true,
  skipLibCheck: true,
  esModuleInterop: true,
  types: [],
};

function diagnosticsText(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => '\n',
  });
}

describe('published declarations', () => {
  it('do not reference the optional @superfunctions/db peer', () => {
    const emitted = new Map<string, string>();
    // Comments are dropped so only real module references are inspected.
    const emitOptions: ts.CompilerOptions = {
      ...compilerOptions,
      declaration: true,
      emitDeclarationOnly: true,
      removeComments: true,
      outDir: join(packageRoot, 'dist-declarations'),
    };
    const host = ts.createCompilerHost(emitOptions);
    host.writeFile = (name, text) => void emitted.set(name, text);
    const program = ts.createProgram([join(packageRoot, 'src/index.ts')], emitOptions, host);
    const result = program.emit();
    expect(diagnosticsText(result.diagnostics)).toBe('');
    expect([...emitted.keys()].some((name) => name.endsWith('database.d.ts'))).toBe(true);
    for (const [name, text] of emitted) {
      expect(text, name).not.toContain('@superfunctions/db');
    }
  });

  it('accept drizzleAdapter and kyselyAdapter results as the db option', () => {
    const fixture = join(packageRoot, 'src/__tests__/__db-option-fixture.ts');
    const source = `
      import { kyselyAdapter } from '@superfunctions/db/adapters';
      import { drizzleAdapter } from '@superfunctions/db/adapters/drizzle';
      import type { Adapter } from '@superfunctions/db';
      import { DatabaseQueueAdapter } from '../index.js';
      declare const fromDrizzle: ReturnType<typeof drizzleAdapter>;
      declare const fromKysely: ReturnType<typeof kyselyAdapter>;
      declare const anyAdapter: Adapter;
      new DatabaseQueueAdapter({ db: fromDrizzle });
      new DatabaseQueueAdapter({ db: fromKysely });
      new DatabaseQueueAdapter({ db: anyAdapter });
    `;
    const host = ts.createCompilerHost(compilerOptions);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.readFile = (name) => (name === fixture ? source : readFile(name));
    host.fileExists = (name) => name === fixture || fileExists(name);
    host.getSourceFile = (name, languageVersion, ...rest) =>
      name === fixture
        ? ts.createSourceFile(name, source, languageVersion)
        : getSourceFile(name, languageVersion, ...rest);
    const program = ts.createProgram([fixture], { ...compilerOptions, noEmit: true }, host);
    expect(diagnosticsText(ts.getPreEmitDiagnostics(program))).toBe('');
  });
});
