import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The tests resolve the built workspace `authfn`, as the published plugin
// does. Under `turbo run test`, ^build has already built it. A direct
// `npm test` runs the same ^build through turbo: its cache rebuilds stale or
// failed output and is a cache hit when current. Node launches turbo's JS
// entry, so no executable is looked up on PATH. The release build installs
// only this package, without the workspace, and tests against the published
// `authfn` it pins, so there is nothing to build.
export function setup(): void {
  if (process.env.TURBO_HASH || !existsSync(new URL('../../node_modules/authfn', import.meta.url))) return;
  const turbo = createRequire(import.meta.url).resolve('turbo/bin/turbo');
  execFileSync(
    process.execPath,
    [turbo, 'run', 'build', '--filter=@authfn/api-keys^...', '--output-logs=new-only'],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit' }
  );
}
