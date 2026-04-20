import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { sendfn } from '../src';

describe('TypeScript package baseline', () => {
  it('exports the public factory', () => {
    expect(typeof sendfn).toBe('function');
  });

  it('keeps the package manifest aligned with the public package name', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );

    expect(packageJson.name).toBe('sendfn');
  });

  it('documents the shipped install and import instructions', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

    expect(readme).toContain('npm install sendfn @superfunctions/db @superfunctions/http');
    expect(readme).toContain("import { sendfn, awsSesAdapter, consoleSmsAdapter } from 'sendfn';");
    expect(readme).not.toContain('@sendfn/core');
  });
});
