#!/usr/bin/env node
// Checks that a built McpFn package which inlines @modelcontextprotocol/sdk
// (tsup `noExternal`) bundled exactly the SDK version its package.json pins
// (MCP-13). Consumers cannot override bundled code, so a stale or mismatched
// bundle would ship SDK advisories that the manifest claims are fixed.
//
// Usage: node scripts/verify-mcpfn-bundled-sdk.mjs [packageRoot]
// (packageRoot defaults to the current directory, so package build scripts
// can run it after tsup).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SDK_NAME = "@modelcontextprotocol/sdk";
const SDK_SEGMENT = `node_modules/${SDK_NAME}/`;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const BUNDLES = [
  { file: "index.js", map: "index.js.map" },
  { file: "index.cjs", map: "index.cjs.map" },
];

export class BundledSdkError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BundledSdkError";
    this.details = details;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// A real import or require of the SDK in emitted code (not in a bundled JSDoc
// example, whose lines start with `*` or `//`).
function externalSdkImports(code) {
  const pattern = new RegExp(
    String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']${SDK_NAME.replace("/", "\\/")}(?:\/[^"']*)?["']`,
  );
  return code
    .split("\n")
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line) && pattern.test(line));
}

/**
 * Verifies the built bundles of the package at `packageRoot`.
 * Returns `{ pinned, bundles: [{ bundle, sdkRoots, versions, sources }] }` or
 * throws a BundledSdkError naming the mismatch.
 */
export function verifyBundledSdk(packageRoot) {
  const root = path.resolve(packageRoot);
  const manifest = readJson(path.join(root, "package.json"));
  const pinned = manifest.dependencies?.[SDK_NAME];
  if (typeof pinned !== "string" || !EXACT_VERSION.test(pinned)) {
    throw new BundledSdkError(
      `${manifest.name} must pin ${SDK_NAME} to an exact version, found ${JSON.stringify(pinned)}`,
      { pinned },
    );
  }
  const bundles = [];
  for (const { file, map } of BUNDLES) {
    const bundlePath = path.join(root, "dist", file);
    const mapPath = path.join(root, "dist", map);
    if (!existsSync(bundlePath) || !existsSync(mapPath)) {
      throw new BundledSdkError(`${manifest.name} has no built ${file} with ${map}; build it first`, {
        bundle: file,
      });
    }
    const imports = externalSdkImports(readFileSync(bundlePath, "utf8"));
    if (imports.length > 0) {
      throw new BundledSdkError(`${manifest.name} dist/${file} imports ${SDK_NAME} instead of bundling it`, {
        bundle: file,
        imports,
      });
    }
    const sourceMap = readJson(mapPath);
    const sources = (sourceMap.sources ?? []).filter((source) =>
      source.replaceAll("\\", "/").includes(SDK_SEGMENT),
    );
    if (sources.length === 0) {
      throw new BundledSdkError(`${manifest.name} dist/${map} contains no ${SDK_NAME} sources`, {
        bundle: file,
      });
    }
    const versions = {};
    for (const source of sources) {
      const absolute = path
        .resolve(path.dirname(mapPath), sourceMap.sourceRoot ?? "", source)
        .replaceAll("\\", "/");
      const sdkRoot = absolute.slice(0, absolute.lastIndexOf(SDK_SEGMENT) + SDK_SEGMENT.length - 1);
      if (!(sdkRoot in versions)) {
        const sdkManifest = path.join(sdkRoot, "package.json");
        if (!existsSync(sdkManifest)) {
          throw new BundledSdkError(`${manifest.name} dist/${map} bundles ${SDK_NAME} from ${sdkRoot}, which is not installed`, {
            bundle: file,
            sdkRoot,
          });
        }
        versions[sdkRoot] = readJson(sdkManifest).version;
      }
    }
    const mismatched = Object.entries(versions).filter(([, version]) => version !== pinned);
    if (mismatched.length > 0) {
      throw new BundledSdkError(
        `${manifest.name} dist/${file} bundles ${SDK_NAME} ${mismatched
          .map(([, version]) => version)
          .join(", ")} but package.json pins ${pinned}`,
        { bundle: file, pinned, versions },
      );
    }
    bundles.push({
      bundle: file,
      sdkRoots: Object.keys(versions).map((sdkRoot) => path.relative(root, sdkRoot)),
      versions: [...new Set(Object.values(versions))],
      sources: sources.length,
    });
  }
  return { name: manifest.name, pinned, bundles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(verifyBundledSdk(process.argv[2] ?? process.cwd()))}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error.message, details: error.details ?? {} })}\n`,
    );
    process.exit(1);
  }
}
