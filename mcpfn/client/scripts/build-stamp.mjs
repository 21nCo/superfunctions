// Build freshness stamp for @mcpfn/client.
//
// The workerd and packed-package tests exercise the built package, so a dist
// left over from older sources would let them pass against stale output.
// `npm run build` writes dist/.build-stamp.json with a digest of every build
// input; the test setup compares it with the current sources and rebuilds (or
// fails) when they differ.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const stampFile = path.join("dist", ".build-stamp.json");

const inputFiles = ["package.json", "tsconfig.json", "tsup.config.ts"];
const inputDirectories = ["src"];

function listFiles(root, relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [relative];
  return readdirSync(absolute)
    .sort()
    .flatMap((entry) => listFiles(root, path.join(relative, entry)));
}

// `@superfunctions/oauth-core` is inlined into dist (tsup noExternal), so its
// built output is a build input too.
function inlinedDependencyFiles(root) {
  let packageJson;
  try {
    packageJson = createRequire(path.join(root, "package.json")).resolve(
      "@superfunctions/oauth-core/package.json",
    );
  } catch {
    return [];
  }
  const dependencyRoot = path.dirname(packageJson);
  return ["package.json", ...listFiles(dependencyRoot, "dist")].map((file) =>
    path.join(dependencyRoot, file),
  );
}

/** Digest of the client's build inputs under `root`. */
export function sourceDigest(root) {
  const hash = createHash("sha256");
  const local = [...inputFiles, ...inputDirectories].flatMap((entry) => listFiles(root, entry));
  for (const relative of local) {
    hash.update(`${relative.split(path.sep).join("/")}\0`);
    hash.update(readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  for (const absolute of inlinedDependencyFiles(root)) {
    hash.update(`@superfunctions/oauth-core:${path.basename(absolute)}\0`);
    hash.update(readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function writeBuildStamp(root) {
  writeFileSync(
    path.join(root, stampFile),
    `${JSON.stringify({ sourceDigest: sourceDigest(root) }, null, 2)}\n`,
  );
}

/** Whether dist under `root` was built from the current build inputs. */
export function distIsFresh(root) {
  try {
    const stamp = JSON.parse(readFileSync(path.join(root, stampFile), "utf8"));
    return stamp.sourceDigest === sourceDigest(root);
  } catch {
    return false;
  }
}

/** Rebuilds a missing or stale dist with `build`, then fails unless the
 * rebuilt output matches the current sources. A fresh dist is left alone:
 * dependents may be reading it concurrently. */
export function ensureFreshDist(root, build) {
  if (distIsFresh(root)) return "fresh";
  build();
  if (!distIsFresh(root)) {
    throw new Error(
      `@mcpfn/client dist does not match its sources after building (${stampFile} missing or stale)`,
    );
  }
  return "rebuilt";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "write") {
    console.error("usage: node scripts/build-stamp.mjs write");
    process.exit(2);
  }
  writeBuildStamp(process.cwd());
}
