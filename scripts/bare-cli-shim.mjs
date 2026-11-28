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
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
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

// Has npm fetch the CLI at this version and report the PATH it would run it with; the CLI's bin is in the first
// node_modules/.bin folder on it whose package is the CLI at this version. npm's messages go to stderr. Returns
// { error } when npm could not run or fetch it, and { PATH } alone when no such folder is on that PATH.
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
  return { PATH: reported };
}

// A copy of the CLI at this version installed anywhere in the project: npm reuses one nested under another package
// (or installed under an alias) without putting it on the PATH it reports. Searches, nearest first, the node_modules
// folders Node.js would look in from the working directory (it and each folder above it, which covers a workspace
// root), at any depth and whatever name a package is installed under, reading each package once. Only when that finds
// nothing does it also search from linked packages' real locations, where they resolve their own dependencies.
function projectBin() {
  const list = (folder) => {
    try {
      return readdirSync(folder).filter((name) => !name.startsWith('.')).map((name) => path.join(folder, name));
    } catch {
      return [];
    }
  };
  const lookupPaths = (start) => {
    const folders = [];
    for (let folder = start; ; folder = path.dirname(folder)) {
      if (path.basename(folder) !== 'node_modules') folders.push(path.join(folder, 'node_modules'));
      if (path.dirname(folder) === folder) return folders;
    }
  };
  const search = (starts, followLinks) => {
    const queue = [];
    const queued = new Set();
    const enqueue = (folder) => {
      if (!queued.has(folder)) {
        queued.add(folder);
        queue.push(folder);
      }
    };
    starts.forEach(enqueue);
    const seen = new Set();
    const links = [];
    while (queue.length > 0) {
      for (const entry of list(queue.shift())) {
        for (const dir of path.basename(entry).startsWith('@') ? list(entry) : [entry]) {
          let real;
          try {
            real = realpathSync(dir);
          } catch {
            continue;
          }
          if (seen.has(real)) continue;
          seen.add(real);
          const file = binIn(dir);
          if (file) return { file };
          if (real === path.resolve(dir)) {
            enqueue(path.join(real, 'node_modules'));
          } else {
            // A linked package lives outside the project's tree: its folders are searched only in the second phase.
            links.push(path.dirname(real));
            if (followLinks) {
              enqueue(path.join(real, 'node_modules'));
              lookupPaths(path.dirname(real)).forEach(enqueue);
            }
          }
        }
      }
    }
    return { links };
  };
  const project = search(lookupPaths(process.cwd()), false);
  if (project.file) return project.file;
  if (project.links.length === 0) return undefined;
  return search([...lookupPaths(process.cwd()), ...project.links.flatMap(lookupPaths)], true).file;
}

function fetchedBin() {
  const [command, prefix] = npmCommand();
  const found = npmLocate(command, prefix);
  if (found.error) fail(found.error);
  if (found.file) return found;
  const file = projectBin();
  if (file === undefined) fail(`npm found ${spec} but no runnable ${own.name} command for it. Install ${spec} in this project, or run this command from another folder.`);
  return { file, PATH: found.PATH };
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
