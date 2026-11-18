import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isTestPath = (path: string) => /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/.test(path);

describe('published package contents', () => {
  it('builds only non-test sources into dist', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      resolve(packageDir, 'tsconfig.build.json'),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)); } },
    );
    if (!parsed) throw new Error('tsconfig.build.json did not parse');
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.outDir && relative(packageDir, parsed.options.outDir)).toBe('dist');
    const inputs = parsed.fileNames.map((file) => relative(packageDir, file));
    expect(inputs).toContain('src/index.ts');
    expect(inputs.filter(isTestPath)).toEqual([]);
  });

  it('builds with tsconfig.build.json and leaves compiled tests out of the tarball', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
    expect(manifest.scripts.build).toMatch(/\btsc -p tsconfig\.build\.json\b/);
    expect(manifest.files).toEqual(['dist', '!dist/**/__tests__', '!dist/**/*.test.*']);
  });
});
