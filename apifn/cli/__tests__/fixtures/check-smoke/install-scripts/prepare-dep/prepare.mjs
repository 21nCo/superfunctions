// npm runs this prepare script while packing the directory dependency (install-links=true copies it), even under the
// --ignore-scripts of npm 10.8 (Node 20's npm). The workflow's npm 11.21 skips it unless allow_install_scripts is true.
// It runs in this directory and writes its marker into the fixture's node_modules, which the install check ignores.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("../node_modules", { recursive: true });
writeFileSync("../node_modules/.apifn-prepare-script-ran", "");
