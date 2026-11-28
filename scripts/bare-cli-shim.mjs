#!/usr/bin/env node
// The command of a product's bare (unscoped) npm package: `npx <product>` runs the product's scoped CLI package at
// exactly this package's version. package.json names that CLI in "frontDoor": { "cli": "<scoped CLI package>" }, and
// every bin of this package runs the CLI's bin named after this package (other bins are aliases of it).
//
// It imports nothing but Node.js built-ins. A bare package that also exports a core never depends on its CLI, so an
// importer of the core installs, loads and bundles none of the CLI; this command makes the CLI available only when it
// runs. A copy of the CLI at this exact version that Node.js can find from here (a CLI-only bare package depends on
// it) runs with Node.js; otherwise npm fetches and runs that exact version, as `npx <cli>@<version>` would. Either way
// the CLI runs as a child process with this terminal, and this command exits as it did. The CLI is told the exact
// version expected (BARE_EXPECTED_CLI) and refuses to run as any other.
//
// The release gate keeps this file byte-for-byte identical to the shared template in every bare package.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import path from 'node:path';
import process from 'node:process';

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
    // npm treats a backslash in a bin path as a folder separator on every platform.
    resolved = realpathSync(path.resolve(packageDir, file.replaceAll('\\', '/')));
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

// Runs the command with this terminal and exits as it did: with its exit code, or by the signal that ended it (with
// 128 + its number should this process survive it). The terminal sends Ctrl+C (SIGINT) and Ctrl+\ (SIGQUIT) to the
// whole foreground process group, the command included, so they are not passed on again (a second Ctrl+C means
// "force quit" to many CLIs); this process only waits for the command to finish. SIGTERM and SIGHUP, which a
// supervisor may send to this process alone, reach the command as SIGTERM (npm relays only SIGINT and SIGTERM).
function runAndExit(command, args, startFailure, { env = process.env } = {}) {
  const child = spawn(command, args, { stdio: 'inherit', env });
  const wait = () => {};
  const terminate = () => child.kill('SIGTERM');
  const handlers = [['SIGINT', wait], ['SIGTERM', terminate], ['SIGHUP', terminate]];
  // Windows has no SIGQUIT to listen for.
  if (process.platform !== 'win32') handlers.push(['SIGQUIT', wait]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.on('error', (error) => fail(`${startFailure}: ${error.message}`));
  child.on('exit', (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    if (signal === null) {
      process.exitCode = code ?? 1;
      return;
    }
    process.exitCode = 128 + (constants.signals[signal] ?? 0);
    process.kill(process.pid, signal);
  });
}

// The CLI this command expects, as "<package>@<version>", for the CLI it starts. npm exec may reuse a copy of the CLI
// that is not on the PATH it runs the command with, so the command name can reach another version of the CLI, or this
// command again. A CLI behind a bare package compares this with its own name and version at startup and exits non-zero
// on a mismatch (see the README's "Bare packages"); this command refuses to start again under its own expectation.
const EXPECTED = 'BARE_EXPECTED_CLI';

if (typeof cli !== 'string' || cli === '') fail('package.json names no CLI package in frontDoor.cli.');
if (process.env[EXPECTED] === spec) {
  fail(`npm ran this command again instead of ${spec}'s ${own.name} bin. Install ${spec} in this project, or run npx ${spec} from another folder.`);
}
const args = process.argv.slice(2);
const env = { ...process.env, [EXPECTED]: spec };
const installed = installedBin();
if (installed !== undefined) {
  runAndExit(process.execPath, [installed, ...args], `could not start ${installed}`, { env });
} else if (process.env.BARE_CLI_NO_NPM === '1') {
  // The front-door test proves the installed CLI; npm must not stand in for it.
  fail(`${spec} is not installed here, and BARE_CLI_NO_NPM=1 forbids fetching it with npm.`);
} else {
  const [command, prefix] = npmCommand();
  runAndExit(command, [...prefix, 'exec', '--yes', `--package=${spec}`, '--', own.name, ...args], 'could not start npm', { env });
}
