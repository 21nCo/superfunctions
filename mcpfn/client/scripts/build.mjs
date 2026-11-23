// `npm run build`: runs tsup and writes the build stamp (see build-stamp.mjs).
// The stamp is written only when no build input changed while tsup ran.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWithStamp } from "./build-stamp.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const tsupManifest = require.resolve("tsup/package.json");
const tsupCli = path.join(path.dirname(tsupManifest), require(tsupManifest).bin.tsup);

buildWithStamp(root, () => {
  execFileSync(process.execPath, [tsupCli, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
});
