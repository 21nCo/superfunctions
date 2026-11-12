#!/usr/bin/env node

// Rebuilds the symbol-graph fixtures the catalog tests read: compiles
// sources/ as module UIFnSwiftUI for macOS in debug (DEBUG defined) and for
// iOS devices in release, with the symbol-graph flags
// scripts/uifn-swiftui-inventory.mjs uses, keeps the symbols declared in sources/ (synthesized
// copies included) and the fields src/swiftui-symbol-graph.mjs reads, and
// rewrites each file URI under file:///checkout/. Needs macOS with Xcode.
//
//   node uifn/catalog/fixtures/swiftui-symbol-graph/regenerate.mjs

import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'uifn-symbol-graph-fixtures-'));
const sourceRoot = path.join(temporaryRoot, 'uifn/swift/Sources/UIFnSwiftUI');
const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
const sdk = (name) => execFileSync('xcrun', ['--sdk', name, '--show-sdk-path'], { encoding: 'utf8' }).trim();
const platforms = [
  ['macos-debug', `${arch}-apple-macos13.0`, sdk('macosx'), ['-D', 'DEBUG']],
  ['ios-release', 'arm64-apple-ios16.0', sdk('iphoneos'), []],
];

async function swiftFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(file);
    return entry.name.endsWith('.swift') ? [file] : [];
  }));
  return nested.flat().sort();
}

try {
  await cp(path.join(here, 'sources'), sourceRoot, { recursive: true });
  const files = await swiftFiles(sourceRoot);
  for (const [name, target, sdkPath, defines] of platforms) {
    const build = path.join(temporaryRoot, name);
    await mkdir(build, { recursive: true });
    execFileSync('xcrun', ['swiftc', '-module-name', 'UIFnSwiftUI', '-parse-as-library', '-target', target, '-sdk', sdkPath, '-emit-module', '-emit-module-path', path.join(build, 'UIFnSwiftUI.swiftmodule'), '-emit-symbol-graph', '-emit-symbol-graph-dir', build, '-symbol-graph-minimum-access-level', 'internal', '-include-spi-symbols', ...defines, ...files], { stdio: 'inherit' });
    const output = path.join(here, name);
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    for (const file of (await readdir(build)).filter((entry) => entry.endsWith('.symbols.json')).sort()) {
      const graph = JSON.parse(await readFile(path.join(build, file), 'utf8'));
      const symbols = graph.symbols.filter((symbol) => symbol.location?.uri.includes(`/${path.basename(temporaryRoot)}/`));
      const kept = new Set(symbols.map((symbol) => symbol.identifier.precise));
      const trimmed = {
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
      await writeFile(path.join(output, file), `${JSON.stringify(trimmed, null, 1)}\n`);
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
