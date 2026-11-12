#!/usr/bin/env node

// Rebuilds the symbol-graph fixtures the catalog tests read: compiles
// sources/ as module UIFnSwiftUI for macOS in debug (DEBUG defined) and for
// iOS devices in release, with the symbol-graph flags
// scripts/uifn-swiftui-inventory.mjs uses (SWIFTUI_SYMBOL_GRAPH_FLAGS), keeps
// the symbols declared in sources/ (synthesized copies included) and the
// fields src/swiftui-symbol-graph.mjs reads, and rewrites each file URI under
// file:///checkout/. Every platform is built and trimmed before any committed
// fixture directory is replaced. Needs macOS with Xcode.
//
//   node uifn/catalog/fixtures/swiftui-symbol-graph/regenerate.mjs

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SWIFTUI_SYMBOL_GRAPH_FLAGS, XCRUN } from '../../src/swiftui-symbol-graph.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'uifn-symbol-graph-fixtures-'));

async function swiftFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(file);
    return entry.name.endsWith('.swift') ? [file] : [];
  }));
  return nested.flat().sort();
}

function trimmed(graph) {
  const symbols = graph.symbols.filter((symbol) => symbol.location?.uri.includes(`/${path.basename(temporaryRoot)}/`));
  const kept = new Set(symbols.map((symbol) => symbol.identifier.precise));
  return {
    module: { name: graph.module.name, platform: graph.module.platform },
    symbols: symbols.map((symbol) => ({
      kind: symbol.kind,
      identifier: symbol.identifier,
      pathComponents: symbol.pathComponents,
      names: { title: symbol.names.title },
      accessLevel: symbol.accessLevel,
      location: { uri: `file:///checkout/${symbol.location.uri.slice(symbol.location.uri.indexOf('uifn/swift/Sources/'))}` },
      ...(symbol.swiftExtension ? { swiftExtension: symbol.swiftExtension } : {}),
    })),
    relationships: graph.relationships.filter((relationship) => kept.has(relationship.source)).map(({ kind, source, target, targetFallback }) => ({ kind, source, target, ...(targetFallback ? { targetFallback } : {}) })),
  };
}

// Builds one platform and writes its trimmed graphs to staged/<name>.
async function stagePlatform([name, target, sdkPath, defines], files) {
  const build = path.join(temporaryRoot, 'build', name);
  const staged = path.join(temporaryRoot, 'staged', name);
  await Promise.all([mkdir(build, { recursive: true }), mkdir(staged, { recursive: true })]);
  execFileSync(XCRUN, ['swiftc', '-module-name', 'UIFnSwiftUI', '-parse-as-library', '-target', target, '-sdk', sdkPath, '-emit-module', '-emit-module-path', path.join(build, 'UIFnSwiftUI.swiftmodule'), '-emit-symbol-graph-dir', build, ...SWIFTUI_SYMBOL_GRAPH_FLAGS, ...defines, ...files], { stdio: 'inherit' });
  const graphFiles = (await readdir(build)).filter((entry) => entry.endsWith('.symbols.json'));
  await Promise.all(graphFiles.map(async (file) => {
    const graph = JSON.parse(await readFile(path.join(build, file), 'utf8'));
    await writeFile(path.join(staged, file), `${JSON.stringify(trimmed(graph), null, 1)}\n`);
  }));
}

try {
  const sourceRoot = path.join(temporaryRoot, 'uifn/swift/Sources/UIFnSwiftUI');
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  const sdk = (name) => execFileSync(XCRUN, ['--sdk', name, '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const platforms = [
    ['macos-debug', `${arch}-apple-macos13.0`, sdk('macosx'), ['-D', 'DEBUG']],
    ['ios-release', 'arm64-apple-ios16.0', sdk('iphoneos'), []],
  ];
  await cp(path.join(here, 'sources'), sourceRoot, { recursive: true });
  const files = await swiftFiles(sourceRoot);
  // Each platform builds into its own directories (the compiler runs
  // synchronously, so one at a time).
  await Promise.all(platforms.map((platform) => stagePlatform(platform, files)));
  // Every platform built: replace the committed fixtures. The temporary
  // directory may be on another volume, so copy rather than rename.
  await Promise.all(platforms.map(async ([name]) => {
    await rm(path.join(here, name), { recursive: true, force: true });
    await cp(path.join(temporaryRoot, 'staged', name), path.join(here, name), { recursive: true });
  }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
