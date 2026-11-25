import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const changelogPath = join(dirname(fileURLToPath(import.meta.url)), '../content/docs/reference/changelog.md');
const raw = readFileSync(changelogPath, 'utf8');

function splitFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, 'changelog has frontmatter');
  return { frontmatter: match[1], body: match[2] };
}

/** Headings and links only, enough to check the releases anchor. */
function render(markdown) {
  return markdown
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

test('changelog lists versions, guest ownership, and the releases page', () => {
  const { frontmatter, body } = splitFrontmatter(raw);
  assert.match(frontmatter, /title:\s*Changelog/);
  for (const version of ['Unreleased', '0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0']) {
    assert.match(body, new RegExp(`^## .*${version}`, 'm'), version);
  }

  const security = body.split(/^## /m).find((section) => section.startsWith('0.7.0'));
  assert.ok(security, '0.7.0 section');
  assert.match(security, /principal `anonymous`/);
  assert.match(security, /owns nothing/);
  assert.match(security, /Signed-in owners can manage grants for their own files over HTTP/);
  assert.match(security, /revokedAt/);
  assert.match(security, /filePermissions/);
  assert.match(security, /resolveSession/);

  const unreleased = body.split(/^## /m).find((section) => section.startsWith('Unreleased'));
  assert.match(unreleased, /FILEFN_STORAGE_STAT_UNAVAILABLE/);
  assert.match(unreleased, /FILEFN_UPLOAD_INCOMPLETE/);
  assert.match(unreleased, /filefn\.quota/);

  const html = render(body);
  assert.match(html, /<h2>[^<]*0\.7\.0/);
  assert.match(html, /<a href="https:\/\/github.com\/21nCo\/superfunctions\/releases">/);
  assert.doesNotMatch(body, /super-functions\/releases/);
});
