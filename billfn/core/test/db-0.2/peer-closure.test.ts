/**
 * A host on either db line must install @billfn/core with one valid
 * @superfunctions/db copy. npm validates every `@superfunctions/db` peer range
 * (optional or not) declared by a package it installs, so each range reachable
 * through core's hard dependency closure must accept both db 0.2.x and 0.3.x.
 * Optional peers of core itself (e.g. @superfunctions/queue) are not installed
 * on the host's behalf and are excluded from the closure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { describe, expect, it } from 'vitest';

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const DB = '@superfunctions/db';
const coreDir = fileURLToPath(new URL('../..', import.meta.url));

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

/** Node's lookup: the nearest node_modules/<name> walking up from `fromDir`. */
function locate(name: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`cannot locate ${name} from ${fromDir}`);
  }
}

/** Every `@superfunctions/db` peer range declared in core's installed hard dependency closure. */
function dbPeerRangesInClosure(): Array<{ from: string; range: string }> {
  const ranges: Array<{ from: string; range: string }> = [];
  const seen = new Set<string>();
  const queue: string[] = [coreDir];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = readManifest(dir);
    const peer = manifest.peerDependencies?.[DB];
    if (peer) ranges.push({ from: `${manifest.name}@${manifest.version}`, range: peer });
    for (const name of Object.keys(manifest.dependencies ?? {})) queue.push(locate(name, dir));
  }
  return ranges;
}

const db02Version = readManifest(locate('@superfunctions/db-0.2', coreDir)).version;
const db03Version = readManifest(locate(DB, coreDir)).version;

describe('@superfunctions/db peer closure', () => {
  it('tests one db 0.2.x and one db 0.3.x release', () => {
    expect(semver.satisfies(db02Version, '^0.2.0')).toBe(true);
    expect(semver.satisfies(db03Version, '^0.3.0')).toBe(true);
  });

  it('accepts db 0.2.x and 0.3.x in every peer range core installs', () => {
    const ranges = dbPeerRangesInClosure();
    expect(ranges.map((entry) => entry.from)).toContain(`@billfn/core@${readManifest(coreDir).version}`);
    const rejecting = ranges.filter(
      ({ range }) => !semver.satisfies(db02Version, range) || !semver.satisfies(db03Version, range)
    );
    expect(rejecting).toEqual([]);
  });
});
