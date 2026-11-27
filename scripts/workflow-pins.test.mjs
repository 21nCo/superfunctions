import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** CI and the two publish workflows this change is allowed to pin. */
const workflows = [
  '.github/workflows/ci.yml',
  '.github/workflows/publish-python.yml',
  '.github/workflows/publish-tag.yml',
];

for (const workflow of workflows) {
  test(`${workflow} pins every external action to a commit SHA`, () => {
    const text = readFileSync(new URL(`../${workflow}`, import.meta.url), 'utf8');
    const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0);
    for (const ref of uses) {
      if (ref.startsWith('./')) continue;
      assert.match(ref, /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+@[0-9a-f]{40}$/, ref);
    }
  });
}
