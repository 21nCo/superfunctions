// The workerd and packed-package tests exercise the built package. turbo builds
// it first (see turbo.json), but `npm run gate:mcpfn-release` runs the client
// tests before its build step, so build here when the output is missing. An
// existing dist is never rebuilt: dependents may be reading it concurrently.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const builtFiles = ["index.js", "index.cjs", "stdio.js", "stdio.cjs", "stdio-unavailable.js"];

export default function setup(): void {
  if (builtFiles.every((file) => existsSync(new URL(`../dist/${file}`, import.meta.url)))) return;
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}
