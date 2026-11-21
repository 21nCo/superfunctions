// Checks that a built McpFn package which inlines @modelcontextprotocol/sdk
// (tsup `noExternal`) bundled exactly the SDK version its package.json pins
// (MCP-13). Consumers cannot override bundled code, so a stale or mismatched
// bundle would ship SDK advisories that the manifest claims are fixed.
//
// The package's tsup config writes `bundledSdkBanner()` at the top of every
// bundle. The banner names the SDK version installed when tsup ran, so the
// version is part of the built bytes: a dist built from another SDK release
// keeps its old stamp (or has none) even after node_modules and the pin
// change. esbuild chains the SDK's own source maps, so the source-map entries
// name SDK `src/*.ts` files that are not published and carry no
// sourcesContent; they only show where the SDK was resolved from.
//
// Usage: node scripts/verify-mcpfn-bundled-sdk.mjs [packageRoot]
// (packageRoot defaults to the current directory, so package build scripts
// can run it after tsup).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SDK_NAME = "@modelcontextprotocol/sdk";
const SDK_SEGMENT = `node_modules/${SDK_NAME}/`;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const STAMP = /\/\*! bundled @modelcontextprotocol\/sdk@([^\s*]+) \*\//g;
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

/**
 * Finds the SDK that a bare `@modelcontextprotocol/sdk/...` import from
 * `packageRoot` resolves to (the nearest node_modules copy, as Node and
 * esbuild resolve it) and returns `{ root, version }`.
 */
export function resolveInstalledSdk(packageRoot) {
  let dir = path.resolve(packageRoot);
  for (;;) {
    const manifest = path.join(dir, "node_modules", SDK_NAME, "package.json");
    if (existsSync(manifest)) return { root: path.dirname(manifest), version: readJson(manifest).version };
    const parent = path.dirname(dir);
    if (parent === dir) throw new BundledSdkError(`${SDK_NAME} is not installed for ${packageRoot}`);
    dir = parent;
  }
}

/** The banner the package's tsup config writes at the top of each bundle. */
export function bundledSdkBanner(packageRoot) {
  return `/*! bundled ${SDK_NAME}@${resolveInstalledSdk(packageRoot).version} */`;
}

// A real import or require of the SDK in emitted code. Same-line block
// comments are removed first; lines inside a multi-line comment (bundled JSDoc
// examples start with `*`) and `//` comment lines are skipped.
function externalSdkImports(code) {
  const pattern = new RegExp(
    String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|(?:\b|_)require\s*\(\s*)["']${SDK_NAME.replace("/", "\\/")}(?:\/[^"']*)?["']`,
  );
  return code.split("\n").filter((line) => {
    const stripped = line.replace(/\/\*.*?\*\//g, "");
    return !/^\s*(?:\*|\/\/|\/\*)/.test(stripped) && pattern.test(stripped);
  });
}

/**
 * Verifies the built bundles of the package at `packageRoot`.
 * Returns `{ name, pinned, bundles: [{ bundle, stamped, sdkRoots, versions, sources }] }`
 * or throws a BundledSdkError naming the mismatch.
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
    const code = readFileSync(bundlePath, "utf8");
    const imports = externalSdkImports(code);
    if (imports.length > 0) {
      throw new BundledSdkError(`${manifest.name} dist/${file} imports ${SDK_NAME} instead of bundling it`, {
        bundle: file,
        imports,
      });
    }

    // Build-time stamp: the SDK version tsup actually bundled.
    const stamps = [...new Set([...code.matchAll(STAMP)].map((match) => match[1]))];
    if (stamps.length === 0) {
      throw new BundledSdkError(
        `${manifest.name} dist/${file} has no bundled ${SDK_NAME} version stamp; rebuild it with npm run build`,
        { bundle: file },
      );
    }
    const wrongStamps = stamps.filter((version) => version !== pinned);
    if (wrongStamps.length > 0) {
      throw new BundledSdkError(
        `${manifest.name} dist/${file} bundles ${SDK_NAME} ${wrongStamps.join(", ")} but package.json pins ${pinned}`,
        { bundle: file, pinned, stamped: stamps },
      );
    }

    // Where the bundled SDK sources were resolved from must be the pinned SDK.
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
        `${manifest.name} dist/${map} resolves ${SDK_NAME} from ${mismatched
          .map(([sdkRoot, version]) => `${sdkRoot} (${version})`)
          .join(", ")} but package.json pins ${pinned}`,
        { bundle: file, pinned, versions },
      );
    }
    bundles.push({
      bundle: file,
      stamped: pinned,
      sdkRoots: Object.keys(versions).map((sdkRoot) => path.relative(root, sdkRoot)),
      versions: [...new Set(Object.values(versions))],
      sources: sources.length,
    });
  }
  return { name: manifest.name, pinned, bundles };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    process.stdout.write(`${JSON.stringify(verifyBundledSdk(process.argv[2] ?? process.cwd()))}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error.message, details: error.details ?? {} })}\n`,
    );
    process.exit(1);
  }
}
