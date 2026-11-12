#!/usr/bin/env node

// Checks, or with --write rewrites, uifn/catalog/swiftui-surface-inventory.json
// against the public UIFnSwiftUI declarations the Swift compiler reports when
// it builds the target for macOS, iOS devices and the iOS simulator, each in
// debug and release, so a declaration in any of those #if branches counts. It
// fails on an #if clause in Styles or Components that none of those builds
// compiles. Needs macOS with Xcode; the Swift workflow's macOS job runs the
// check. With --symbol-graphs <directory>... it reads graphs already emitted
// with -emit-symbol-graph instead of building.
//
//   node scripts/uifn-swiftui-inventory.mjs [--write] [--symbol-graphs <directory>...]

import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CatalogError, createSwiftUISurfaceInventory, stableStringify } from '../uifn/catalog/src/compiler.mjs';
import { readSwiftUISymbolGraphs, SWIFTUI_MODULE, swiftUIDeclarationsFromSymbolGraphs, uncoveredSwiftConditions } from '../uifn/catalog/src/swiftui-symbol-graph.mjs';
import { SWIFTUI_SOURCES_ROOT } from '../uifn/catalog/src/swiftui-status.mjs';

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

async function swiftFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(file);
    return entry.name.endsWith('.swift') ? [file] : [];
  }));
  return nested.flat().sort();
}

async function checkConditions() {
  const files = (await Promise.all(['Styles', 'Components'].map((name) => swiftFiles(path.join(repoRoot, SWIFTUI_SOURCES_ROOT, name))))).flat();
  const uncovered = (await Promise.all(files.map(async (file) => uncoveredSwiftConditions(await readFile(file, 'utf8')).map((entry) => ({ source: path.relative(repoRoot, file), ...entry }))))).flat();
  if (uncovered.length > 0) {
    throw new CatalogError('UIFN_CATALOG_SWIFTUI_SURFACE_DRIFT', 'An #if clause in UIFnSwiftUI Styles or Components is compiled by none of the inventory builds, or uses a condition they cannot decide. Use os(macOS), os(iOS), canImport(SwiftUI|UIKit|AppKit), DEBUG and targetEnvironment(simulator).', { uncovered });
  }
}

function emitSymbolGraphs(temporaryRoot) {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  const sdk = (name) => execFileSync('xcrun', ['--sdk', name, '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const platforms = [
    ['macos', []],
    ['ios', ['--triple', 'arm64-apple-ios16.0', '--sdk', sdk('iphoneos')]],
    ['ios-simulator', ['--triple', `${arch}-apple-ios16.0-simulator`, '--sdk', sdk('iphonesimulator')]],
  ];
  return platforms.flatMap(([platform, platformArgs]) => ['debug', 'release'].map((configuration) => {
    const name = `${platform}-${configuration}`;
    const graphs = path.join(temporaryRoot, `${name}-symbol-graphs`);
    // A fresh scratch path builds every file, so the compiler writes a graph.
    // Internal access and SPI are emitted so that underscored, @_spi and
    // @_documentation-hidden public declarations are in the graph. Release
    // keeps its conditions (no DEBUG) but skips optimization, which does not
    // change declarations.
    const flags = ['-emit-symbol-graph', '-emit-symbol-graph-dir', graphs, '-symbol-graph-minimum-access-level', 'internal', '-include-spi-symbols', ...(configuration === 'release' ? ['-Onone'] : [])];
    execFileSync('swift', [
      'build', '--target', SWIFTUI_MODULE, '--configuration', configuration, '--scratch-path', path.join(temporaryRoot, `${name}-build`), ...platformArgs,
      ...flags.flatMap((flag) => ['-Xswiftc', flag]),
    ], { cwd: repoRoot, stdio: ['ignore', 2, 2] });
    return graphs;
  }));
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'uifn-swiftui-inventory-'));
try {
  let directories = givenDirectories.map((directory) => path.resolve(directory));
  if (directories.length === 0) {
    await checkConditions();
    directories = emitSymbolGraphs(temporaryRoot);
  }
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
