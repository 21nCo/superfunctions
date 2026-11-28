#!/usr/bin/env node
// The command of a product's bare (unscoped) npm package: `npx <product>` runs the product's scoped CLI package at
// exactly this package's version. package.json names that CLI in "frontDoor": { "cli": "<scoped CLI package>" }, and
// every bin of this package runs the CLI's bin named after this package (other bins are aliases of it).
//
// It imports nothing but Node.js built-ins. A bare package that also exports a core never depends on its CLI, so an
// importer of the core installs, loads and bundles none of the CLI; this command makes the CLI available only when it
// runs. A copy of the CLI at this exact version that Node.js can find from here (a CLI-only bare package depends on
// it) runs with Node.js; otherwise npm fetches and runs that exact version, as `npx <cli>@<version>` would. Either way
// the CLI runs as a child process with this terminal, and this command exits as it did.
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
// 128 + its number should this process survive it). SIGINT, SIGTERM and SIGHUP sent to this process alone are passed
// on; through npm, which relays only SIGINT and SIGTERM to the command it runs, a SIGHUP is passed on as SIGTERM.
function runAndExit(command, args, startFailure, { viaNpm = false, env = process.env } = {}) {
  const child = spawn(command, args, { stdio: 'inherit', env });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = (signal) => child.kill(viaNpm && signal === 'SIGHUP' ? 'SIGTERM' : signal);
  for (const signal of signals) process.on(signal, forward);
  child.on('error', (error) => fail(`${startFailure}: ${error.message}`));
  child.on('exit', (code, signal) => {
    for (const name of signals) process.off(name, forward);
    if (signal === null) {
      process.exitCode = code ?? 1;
      return;
    }
    process.exitCode = 128 + (constants.signals[signal] ?? 0);
    process.kill(process.pid, signal);
  });
}

// Set for the npm exec child: if npm resolves the command name back to this package's own bin (it reused a copy of
// the CLI whose bin folder is not on its PATH), the second start of this command stops instead of looping.
const LAUNCHED = 'SUPERFUNCTIONS_BARE_CLI_LAUNCHED';

if (typeof cli !== 'string' || cli === '') fail('package.json names no CLI package in frontDoor.cli.');
if (process.env[LAUNCHED] === spec) {
  fail(`npm ran this command again instead of ${spec}'s ${own.name} bin. Install ${spec} in this project, or run npx ${spec} from another folder.`);
}
const args = process.argv.slice(2);
const installed = installedBin();
if (installed !== undefined) {
  runAndExit(process.execPath, [installed, ...args], `could not start ${installed}`);
} else {
  const [command, prefix] = npmCommand();
  runAndExit(command, [...prefix, 'exec', '--yes', `--package=${spec}`, '--', own.name, ...args], 'could not start npm', {
    viaNpm: true,
    env: { ...process.env, [LAUNCHED]: spec },
  });
}
