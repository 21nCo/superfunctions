/**
 * Deterministic hashFiles(glob) for cache keys and interpolation.
 * Resolves glob relative to workspace root, sorts matches deterministically, hashes contents.
 * No matches → hash of empty string.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Convert glob pattern to regex (minimal: * and **). * = any within segment, ** = any path. */
function globToRegex(glob: string): RegExp {
  const trimmed = glob.trim();
  const parts = trimmed.split(/\*\*/).map(p =>
    p.split(/\*/).map(s =>
      s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*\*/g, '')
    ).join('[^/]*')
  );
  const pattern = parts.join('.*');
  return new RegExp(`^${pattern}$`);
}

/** List files matching glob relative to workspaceRoot. Deterministic sort. */
function listMatches(workspaceRoot: string, glob: string): string[] {
  const regex = globToRegex(glob);
  const results: string[] = [];

  function walk(dir: string, base: string): void {
    if (!existsSync(dir)) return;
    const stat = statSync(dir);
    if (stat.isFile()) {
      const rel = relative(base, dir);
      if (regex.test(rel)) results.push(dir);
      return;
    }
    if (!stat.isDirectory()) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const e of sorted) {
      const full = join(dir, e.name);
      if (e.isFile()) {
        const rel = relative(base, full);
        if (regex.test(rel)) results.push(full);
      } else if (e.isDirectory()) {
        walk(full, base);
      }
    }
  }

  walk(workspaceRoot, workspaceRoot);
  results.sort((a, b) => relative(workspaceRoot, a).localeCompare(relative(workspaceRoot, b), 'en'));
  return results;
}

/**
 * Compute deterministic hash of contents of all files matching glob under workspaceRoot.
 * Returns lowercase hex. No matches → hash of empty string.
 */
export function hashFiles(workspaceRoot: string, glob: string): string {
  const files = listMatches(workspaceRoot, glob);
  const hasher = createHash('sha256');
  if (files.length === 0) {
    hasher.update('', 'utf8');
    return hasher.digest('hex').toLowerCase();
  }
  for (const f of files) {
    const content = readFileSync(f);
    hasher.update(content);
  }
  return hasher.digest('hex').toLowerCase();
}
