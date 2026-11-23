// The workerd and packed-package tests exercise the built package. turbo builds
// it first (see turbo.json) and so does `npm run gate:mcpfn-release`, but a
// direct `vitest run` after a source edit could still find an older dist. The
// build stamp records a digest of the build inputs: a missing or stale dist is
// rebuilt here, and the run fails if the rebuilt output still does not match.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ensureFreshDist } from "../scripts/build-stamp.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export default function setup(): void {
  ensureFreshDist(packageRoot, () => {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: packageRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  });
}
