#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, ".tmp", "jscpd");
const reportFile = path.join(outputDir, "jscpd-report.json");

mkdirSync(outputDir, { recursive: true });

try {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["jscpd", "--config", ".jscpd.json"],
    { stdio: "inherit", cwd: repoRoot }
  );
} catch (error) {
  console.error("duplication scan command failed");
  process.exit(error.status || 1);
}

try {
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "check-searchfn-adapter-canonical.mjs")],
    { stdio: "inherit", cwd: repoRoot }
  );
} catch (error) {
  console.error("searchfn canonical-source guard failed");
  process.exit(error.status || 1);
}

if (!existsSync(reportFile)) {
  console.error(`missing duplication report at ${reportFile}`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportFile, "utf8"));
const statistics = report.statistics || {};
const total = statistics.total || {};
const payload = {
  ok: true,
  thresholdExceeded: false,
  scannedFiles: total.sources ?? 0,
  duplicatedLines: total.duplicatedLines ?? 0,
  duplicatedPercentage: total.percentage ?? 0
};

console.log(JSON.stringify(payload));
