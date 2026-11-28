#!/usr/bin/env node
// The command of a product's bare (unscoped) npm package: `npx <product>` runs the product's scoped CLI package at
// exactly this package's version. package.json names that CLI in "frontDoor": { "cli": "<scoped CLI package>" }, and
// every bin of this package runs the CLI's bin named after this package (other bins are aliases of it).
//
// It imports nothing but Node.js built-ins. A bare package that also exports a core never depends on its CLI, so an
// importer of the core installs, loads and bundles none of the CLI; this command makes the CLI available only when it
// runs. A copy of the CLI at this exact version that Node.js can find from here (a CLI-only bare package depends on
// it) runs in place; otherwise npm fetches that version into its cache, as npx would. Either way the CLI's bin module
// is loaded into this process, as if Node.js had been started on it, so no second process stands between the CLI and
// the terminal: it alone gets every signal, reads the terminal directly and sets the exit code.
//
// The release gate keeps this file byte-for-byte identical to the shared template in every bare package.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const manifestUrl = new URL('../package.json', import.meta.url);
const own = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const cli = own.frontDoor?.cli;
const spec = `${cli}@${own.version}`;

function fail(message) {
  console.error(`${own.name}: ${message}`);
  process.exit(1);
}

// The CLI's bin file in packageDir, as a real path: undefined unless packageDir holds the CLI at this exact version
// with a bin named after this package that exists and, once symlinks are resolved, stays inside the CLI package.
function binIn(packageDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (manifest?.name !== cli || manifest.version !== own.version) return undefined;
  const bin = typeof manifest.bin === 'string' ? { [cli.split('/').pop()]: manifest.bin } : manifest.bin;
  const file = bin?.[own.name];
  if (typeof file !== 'string') return undefined;
  let realDir;
  let resolved;
  try {
    realDir = realpathSync(packageDir);
    resolved = realpathSync(path.resolve(packageDir, file));
  } catch {
    return undefined;
  }
  const relative = path.relative(realDir, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return resolved;
}

// A copy of the CLI at this version in the node_modules folders Node.js searches from this package. Every folder is
// tried, so a project's own copy at another version never stands in for this one.
function installedBin() {
  for (const folder of createRequire(manifestUrl).resolve.paths(cli) ?? []) {
    const file = binIn(path.join(folder, ...cli.split('/')));
    if (file) return file;
  }
  return undefined;
}

// npm, run as `node <npm-cli.js>` with no shell where it can be found, so arguments reach npm unchanged: the npm that
// started this command (npx and npm exec set npm_execpath). On Windows, npm is npm.cmd, a shim for
// node_modules\npm\bin\npm-cli.js in its own folder, so it then takes the first PATH folder holding both, and finally
// the npm installed with Node.js. Elsewhere `npm` from PATH is an executable script that needs no shell.
function npmCommand() {
  const launcher = process.env.npm_execpath;
  if (launcher && /(?:^|[\\/])np[mx]-cli\.js$/.test(launcher)) {
    const npmCli = path.join(path.dirname(launcher), 'npm-cli.js');
    if (existsSync(npmCli)) return [process.execPath, [npmCli]];
  }
  if (process.platform !== 'win32') return ['npm', []];
  const cliIn = (folder) => path.join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  for (const folder of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (existsSync(path.join(folder, 'npm.cmd')) && existsSync(cliIn(folder))) return [process.execPath, [cliIn(folder)]];
  }
  const bundled = cliIn(path.dirname(process.execPath));
  if (!existsSync(bundled)) fail(`could not find npm. Run npx ${spec} instead.`);
  return [process.execPath, [bundled]];
}

// Has npm fetch the CLI at this version and report the PATH it would run it with; the CLI's bin is in the first
// node_modules/.bin folder on it whose package is the CLI at this version. npm's messages go to stderr. Returns
// { error } when npm could not run or fetch it, and undefined when npm ran but no such folder is on that PATH.
function npmLocate(command, prefix) {
  const args = [...prefix, 'exec', '--yes', `--package=${spec}`, '--', 'node', '-p', 'process.env.PATH'];
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (result.error) return { error: `could not start npm: ${result.error.message}` };
  if (result.status !== 0) return { error: `npm could not fetch ${spec}.` };
  const reported = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  for (const folder of reported.split(path.delimiter)) {
    if (path.basename(folder) !== '.bin' || path.basename(path.dirname(folder)) !== 'node_modules') continue;
    const file = binIn(path.join(path.dirname(folder), ...cli.split('/')));
    // The CLI and the commands it starts see the PATH they would have under npx.
    if (file) return { file, PATH: reported };
  }
  return undefined;
}

// npm fetches the CLI at this version into its cache and reports a PATH reaching it. When npm instead reuses a copy
// nested somewhere in the project's tree, no reported PATH reaches it (so `npx` could not run that copy either), and
// this command stops rather than run another version.
function fetchedBin() {
  const [command, prefix] = npmCommand();
  const found = npmLocate(command, prefix);
  if (found === undefined) {
    fail(`npm found ${spec} but no runnable ${own.name} command for it; it may be nested in this project's node_modules. Install ${spec} in the project, or run this command from another folder.`);
  }
  if (found.error) fail(found.error);
  return found;
}

if (typeof cli !== 'string' || cli === '') fail('package.json names no CLI package in frontDoor.cli.');
let file = installedBin();
if (file === undefined) {
  const fetched = fetchedBin();
  file = fetched.file;
  process.env.PATH = fetched.PATH;
}
// The real path, as Node.js gives the module it loads in import.meta.url, so a CLI that compares the two runs.
file = realpathSync(file);
process.argv = [process.argv[0], file, ...process.argv.slice(2)];
await import(pathToFileURL(file).href);
