#!/usr/bin/env node

// Checks, or with --write rewrites, uifn/catalog/swiftui-surface-inventory.json
// against the public UIFnSwiftUI declarations the Swift compiler reports when
// it builds the target for macOS and for the iOS simulator, so a declaration
// in either platform's #if branch counts. Needs macOS with Xcode; the Swift
// workflow's macOS job runs the check. With --symbol-graphs <directory>...
// it reads graphs already emitted with -emit-symbol-graph instead of building.
//
//   node scripts/uifn-swiftui-inventory.mjs [--write] [--symbol-graphs <directory>...]

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CatalogError, createSwiftUISurfaceInventory, stableStringify } from '../uifn/catalog/src/compiler.mjs';
import { readSwiftUISymbolGraphs, SWIFTUI_MODULE, swiftUIDeclarationsFromSymbolGraphs } from '../uifn/catalog/src/swiftui-symbol-graph.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(repoRoot, 'uifn/catalog/swiftui-surface-inventory.json');
const args = process.argv.slice(2);
const write = args.includes('--write');
const graphIndex = args.indexOf('--symbol-graphs');
const givenDirectories = graphIndex >= 0 ? args.slice(graphIndex + 1).filter((arg) => !arg.startsWith('--')) : [];
if (args.some((arg) => arg.startsWith('--') && !['--write', '--symbol-graphs'].includes(arg)) || (graphIndex >= 0 && givenDirectories.length === 0)) {
  console.error('Usage: node scripts/uifn-swiftui-inventory.mjs [--write] [--symbol-graphs <directory>...]');
  process.exit(2);
}

function emitSymbolGraphs(temporaryRoot) {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  const simulatorSdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const platforms = [
    ['macos', []],
    ['ios-simulator', ['--triple', `${arch}-apple-ios16.0-simulator`, '--sdk', simulatorSdk]],
  ];
  return platforms.map(([name, platformArgs]) => {
    const graphs = path.join(temporaryRoot, `${name}-symbol-graphs`);
    // A fresh scratch path builds every file, so the compiler writes a graph.
    execFileSync('swift', [
      'build', '--target', SWIFTUI_MODULE, '--scratch-path', path.join(temporaryRoot, `${name}-build`), ...platformArgs,
      '-Xswiftc', '-emit-symbol-graph', '-Xswiftc', '-emit-symbol-graph-dir', '-Xswiftc', graphs,
    ], { cwd: repoRoot, stdio: ['ignore', 2, 2] });
    return graphs;
  });
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'uifn-swiftui-inventory-'));
try {
  const directories = givenDirectories.length > 0 ? givenDirectories.map((directory) => path.resolve(directory)) : emitSymbolGraphs(temporaryRoot);
  const declarations = [];
  for (const directory of directories) declarations.push(...swiftUIDeclarationsFromSymbolGraphs(await readSwiftUISymbolGraphs(directory)));
  const inventory = createSwiftUISurfaceInventory(declarations);
  const contents = stableStringify(inventory);
  if (write) {
    await writeFile(inventoryPath, contents);
  } else {
    const committed = await readFile(inventoryPath, 'utf8').catch(() => '');
    if (committed !== contents) {
      let listed = [];
      try {
        listed = JSON.parse(committed).declarations ?? [];
      } catch {
        // An unreadable inventory lists nothing.
      }
      const key = (entry) => JSON.stringify([entry.id, entry.kind, entry.source]);
      const committedKeys = new Set(listed.map(key));
      const builtKeys = new Set(inventory.declarations.map(key));
      throw new CatalogError('UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', 'uifn/catalog/swiftui-surface-inventory.json differs from the UIFnSwiftUI declarations the compiler reports. Run node scripts/uifn-swiftui-inventory.mjs --write, then list each new declaration in uifn/catalog/src/swiftui-status.mjs.', {
        added: inventory.declarations.filter((entry) => !committedKeys.has(key(entry))),
        removed: listed.filter((entry) => !builtKeys.has(key(entry))),
      });
    }
  }
  console.log(JSON.stringify({ ok: true, command: `uifn-swiftui-inventory:${write ? 'write' : 'check'}`, symbolGraphDirectories: directories.length, declarationCount: inventory.declarations.length }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, command: 'uifn-swiftui-inventory', code: error.code ?? 'UIFN_CATALOG_SWIFTUI_INVENTORY_FAILED', message: error.message, details: error.details ?? {} }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
