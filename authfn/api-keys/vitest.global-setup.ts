import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The tests resolve the built workspace `authfn`, as the published plugin
// does. Turbo builds it first (^build); a direct `npm test` may not have.
export function setup(): void {
  const coreDir = fileURLToPath(new URL('../core/', import.meta.url));
  if (!existsSync(`${coreDir}dist/index.js`)) {
    execFileSync('npm', ['run', 'build'], { cwd: coreDir, stdio: 'inherit' });
  }
}
