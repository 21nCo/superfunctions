import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

if (process.platform !== "linux") {
  console.log("Skipping optional native package install on non-Linux runner.");
  process.exit(0);
}

const libcFamily =
  process.report?.getReport?.().header?.glibcVersionRuntime != null ? "gnu" : "musl";

const packages = [
  {
    packageName: "rollup",
    nativePackages: {
      arm64: {
        gnu: "@rollup/rollup-linux-arm64-gnu",
        musl: "@rollup/rollup-linux-arm64-musl",
      },
      x64: {
        gnu: "@rollup/rollup-linux-x64-gnu",
        musl: "@rollup/rollup-linux-x64-musl",
      },
    },
  },
  {
    packageName: "lightningcss",
    nativePackages: {
      arm64: {
        gnu: "lightningcss-linux-arm64-gnu",
        musl: "lightningcss-linux-arm64-musl",
      },
      arm: {
        gnu: "lightningcss-linux-arm-gnueabihf",
      },
      x64: {
        gnu: "lightningcss-linux-x64-gnu",
        musl: "lightningcss-linux-x64-musl",
      },
    },
  },
];

function isModuleNotFound(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND");
}

function resolvePackageVersion(packageName) {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [process.cwd()] });
    return require(packageJsonPath).version;
  } catch (error) {
    if (isModuleNotFound(error)) {
      console.log(`${packageName} is not installed in this workspace; skipping native package install.`);
      return null;
    }
    throw error;
  }
}

function ensureNativePackage({ packageName, nativePackages }) {
  const nativePackageName = nativePackages[process.arch]?.[libcFamily];

  if (!nativePackageName) {
    console.log(`No ${packageName} native package mapping for linux/${process.arch}/${libcFamily}; skipping.`);
    return;
  }

  const packageVersion = resolvePackageVersion(packageName);
  if (!packageVersion) {
    return;
  }

  try {
    require.resolve(`${nativePackageName}/package.json`, { paths: [process.cwd()] });
    console.log(`${nativePackageName} is already installed.`);
    return;
  } catch (error) {
    if (!isModuleNotFound(error)) {
      throw error;
    }
  }

  console.log(`Installing ${nativePackageName}@${packageVersion} for ${packageName}.`);
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--no-save", "--ignore-scripts", `${nativePackageName}@${packageVersion}`],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );
}

for (const entry of packages) {
  ensureNativePackage(entry);
}
