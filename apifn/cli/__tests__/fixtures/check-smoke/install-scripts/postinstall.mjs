// Runs only when npm ci runs lifecycle scripts (allow_install_scripts: true). It writes the marker inside
// node_modules, which the workflow's install check ignores, as a generated client or native build would.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("node_modules", { recursive: true });
writeFileSync("node_modules/.apifn-install-script-ran", "");
