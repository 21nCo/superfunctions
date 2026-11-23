// Build freshness stamp for @mcpfn/client.
//
// The workerd and packed-package tests exercise the built package, so a dist
// left over from older sources would let them pass against stale output.
// `npm run build` (scripts/build.mjs) writes dist/.build-stamp.json with a
// digest of every build input, taken before tsup runs and checked again after
// it, and a sha256 of every emitted file. The test setup compares the stamp with
// the current sources and dist, and rebuilds (or fails) when they differ.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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

// Packages tsup inlines into dist (tsup noExternal): their built output is a
// build input too. A package listed here is hashed when the root's
// package.json depends on it, and an unresolvable one fails the digest.
const inlinedDependencies = ["@superfunctions/oauth-core"];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Resolve the package root through its exported entry: the package does not
// export `./package.json`, so resolving that subpath throws.
function dependencyRoot(root, name) {
  const entry = createRequire(path.resolve(root, "package.json")).resolve(name);
  for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest) && readJson(manifest).name === name) return directory;
    if (path.dirname(directory) === directory) {
      throw new Error(`Cannot find the package root of ${name} from ${entry}`);
    }
  }
}

function inlinedDependencyFiles(root) {
  const manifest = readJson(path.join(root, "package.json"));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  return inlinedDependencies
    .filter((name) => name in declared)
    .flatMap((name) => {
      const directory = dependencyRoot(root, name);
      return ["package.json", ...listFiles(directory, "dist")].map((relative) => ({
        key: `${name}/${relative.split(path.sep).join("/")}`,
        file: path.join(directory, relative),
      }));
    });
}

/** Files the package declares as entry points (`main`, `module`, `types`,
 * `exports` and `imports` targets under dist): a fresh dist has all of them. */
export function requiredArtifacts(root) {
  const manifest = readJson(path.join(root, "package.json"));
  const targets = new Set();
  const collect = (value) => {
    if (typeof value === "string") {
      const relative = path.posix.normalize(value);
      if (relative.startsWith("dist/")) targets.add(relative);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collect);
    }
  };
  collect([manifest.main, manifest.module, manifest.types, manifest.exports, manifest.imports]);
  return [...targets].sort();
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
  for (const { key, file } of inlinedDependencyFiles(root)) {
    hash.update(`${key}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** sha256 of every file under dist except the stamp, keyed by posix path. */
export function distArtifacts(root) {
  const stamp = stampFile.split(path.sep).join("/");
  return Object.fromEntries(
    listFiles(root, "dist")
      .map((relative) => relative.split(path.sep).join("/"))
      .filter((relative) => relative !== stamp)
      .map((relative) => [relative, sha256(path.join(root, relative))]),
  );
}

/** Records the build inputs' digest (by default the current one) and the
 * emitted artifacts. */
export function writeBuildStamp(root, digest = sourceDigest(root)) {
  writeFileSync(
    path.join(root, stampFile),
    `${JSON.stringify({ sourceDigest: digest, artifacts: distArtifacts(root) }, null, 2)}\n`,
  );
}

/** Runs `build` and stamps its output with the digest of the inputs it
 * started from. If an input changed while it ran, the output may mix old and
 * new sources: the build fails and leaves no stamp, so the dist counts as
 * stale. */
export function buildWithStamp(root, build) {
  rmSync(path.join(root, stampFile), { force: true });
  const before = sourceDigest(root);
  build();
  if (sourceDigest(root) !== before) {
    rmSync(path.join(root, stampFile), { force: true });
    throw new Error("@mcpfn/client build inputs changed during the build; run the build again");
  }
  writeBuildStamp(root, before);
}

function sameArtifacts(recorded, current) {
  if (!recorded || typeof recorded !== "object") return false;
  const names = Object.keys(current);
  return (
    Object.keys(recorded).length === names.length &&
    names.every((name) => recorded[name] === current[name])
  );
}

/** Whether dist under `root` was built from the current build inputs. */
export function distIsFresh(root) {
  let stamp;
  try {
    stamp = readJson(path.join(root, stampFile));
  } catch {
    return false;
  }
  // A digest failure (an inlined dependency that does not resolve) throws.
  if (stamp?.sourceDigest !== sourceDigest(root)) return false;
  // The emitted files must be exactly the ones the build recorded: none
  // changed, missing or added since.
  if (!sameArtifacts(stamp.artifacts, distArtifacts(root))) return false;
  // A matching stamp is not enough if an emitted entry point is missing.
  return requiredArtifacts(root).every((relative) => existsSync(path.join(root, relative)));
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

