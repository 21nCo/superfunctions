import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

if (process.platform !== "linux") {
  console.log("Skipping Rollup native package install on non-Linux runner.");
  process.exit(0);
}

const packageNamesByArch = {
  arm64: {
    gnu: "@rollup/rollup-linux-arm64-gnu",
    musl: "@rollup/rollup-linux-arm64-musl",
  },
  x64: {
    gnu: "@rollup/rollup-linux-x64-gnu",
    musl: "@rollup/rollup-linux-x64-musl",
  },
};

const libcFamily =
  process.report?.getReport?.().header?.glibcVersionRuntime != null ? "gnu" : "musl";
const packageName = packageNamesByArch[process.arch]?.[libcFamily];

if (!packageName) {
  console.log(`No Rollup native package mapping for linux/${process.arch}; skipping.`);
  process.exit(0);
}

let rollupVersion;

try {
  const rollupPackageJson = require.resolve("rollup/package.json", { paths: [process.cwd()] });
  ({ version: rollupVersion } = require(rollupPackageJson));
} catch {
  console.log("Rollup is not installed in this workspace; skipping native package install.");
  process.exit(0);
}

try {
  require.resolve(`${packageName}/package.json`, { paths: [process.cwd()] });
  console.log(`${packageName} is already installed.`);
  process.exit(0);
} catch {
  // Install the native package only when npm misses the optional dependency.
}

console.log(`Installing ${packageName}@${rollupVersion} for Rollup.`);

execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["install", "--no-save", "--ignore-scripts", `${packageName}@${rollupVersion}`],
  {
    cwd: process.cwd(),
    stdio: "inherit",
  },
);
