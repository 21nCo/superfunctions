import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** CI and the two publish workflows this change is allowed to pin. */
const workflows = [
  '.github/workflows/ci.yml',
  '.github/workflows/publish-python.yml',
  '.github/workflows/publish-tag.yml',
];

describe('CI and publish action pins (F-22)', () => {
  for (const workflow of workflows) {
    it(`${workflow} pins every external action to a commit SHA`, () => {
      const text = readFileSync(join(repoRoot, workflow), 'utf8');
      const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]!);
      expect(uses.length).toBeGreaterThan(0);
      for (const ref of uses) {
        if (ref.startsWith('./')) continue;
        expect(ref, ref).toMatch(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+@[0-9a-f]{40}$/);
      }
    });
  }
});
