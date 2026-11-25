import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const serverRequire = createRequire(join(repoRoot, 'filefn/server/package.json'));
const exampleRequire = createRequire(join(repoRoot, 'filefn/examples/production/server/package.json'));

function readJson(path: string): { name?: string; version: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version: string; dependencies?: Record<string, string> };
}

/** Version of a package as Node resolves it from `req`, ignoring export maps that hide package.json. */
function resolvedVersion(req: NodeRequire, name: string): string {
  const entry = req.resolve(name);
  let dir = dirname(entry);
  while (true) {
    try {
      const manifest = readJson(join(dir, 'package.json'));
      if (manifest.name === name) return manifest.version;
    } catch {
      // Keep walking until the package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No package.json for ${name} from ${entry}`);
}

/** True when `actual` is the same as `floor` or a later major.minor.patch. */
function atLeast(actual: string, floor: string): boolean {
  const parse = (value: string) => value.split('.').map((part) => Number(part));
  const left = parse(actual);
  const right = parse(floor);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

describe('server dependency pins (F-20)', () => {
  it('resolves the workspace db and processing packages', () => {
    const db = resolvedVersion(serverRequire, '@superfunctions/db');
    const processing = resolvedVersion(serverRequire, '@filefn/processing');
    expect(db).toBe(readJson(join(repoRoot, 'packages/db/package.json')).version);
    expect(db).toBe('0.3.4');
    expect(processing).toBe(readJson(join(repoRoot, 'filefn/processing/package.json')).version);
    expect(processing).toBe('0.4.0');
    // Middleware 0.2.0 peers on db 0.2.0 exactly, so the server uses the workspace release that accepts db 0.3.
    const middleware = resolvedVersion(serverRequire, '@superfunctions/middleware');
    expect(middleware).toBe(readJson(join(repoRoot, 'packages/middleware/package.json')).version);
    expect(middleware).toBe('0.3.1');
  });

  it('points the Python project at 21nCo/superfunctions', () => {
    const toml = readFileSync(join(repoRoot, 'filefn/python/pyproject.toml'), 'utf8');
    expect(toml).toContain('Documentation = "https://docs.superfunctions.dev/filefn"');
    expect(toml).toContain('Repository = "https://github.com/21nCo/superfunctions"');
    expect(toml).toContain('Issues = "https://github.com/21nCo/superfunctions/issues"');
    expect(toml).not.toContain('super-functions');
  });
});

describe('production example dependency floors (N-08)', () => {
  it('resolves sharp and hono at the patched floors', () => {
    const manifest = readJson(join(repoRoot, 'filefn/examples/production/server/package.json'));
    expect(manifest.dependencies?.sharp).toBe('^0.35.5');
    expect(manifest.dependencies?.hono).toBe('^4.12.4');
    const sharp = resolvedVersion(exampleRequire, 'sharp');
    const hono = resolvedVersion(exampleRequire, 'hono');
    expect(atLeast(sharp, '0.35.5')).toBe(true);
    expect(atLeast(hono, '4.12.4')).toBe(true);
  });

  it('loads the thumbnail processor factory from the workspace package', async () => {
    const { createThumbnailProcessor } = await import('@filefn/processing');
    const processor = createThumbnailProcessor();
    expect(typeof processor.process).toBe('function');
  });
});
