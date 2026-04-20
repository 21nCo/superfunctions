#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, ".tmp", "jscpd", "langfn");
const reportFile = path.join(outputDir, "jscpd-report.json");
const threshold = Number(process.env.LANGFN_DUPLICATION_THRESHOLD ?? "5");

mkdirSync(outputDir, { recursive: true });

try {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "jscpd",
      "langfn",
      "--min-lines",
      "10",
      "--min-tokens",
      "50",
      "--reporters",
      "console,json",
      "--output",
      outputDir
    ],
    { stdio: "inherit", cwd: repoRoot }
  );
} catch (error) {
  console.error("duplication scan command failed");
  process.exit(error.status || 1);
}

try {
  execFileSync(
    process.platform === "win32" ? "rg.exe" : "rg",
    ["-n", "@superfunctions/|superfunctions\\.", "langfn/typescript", "langfn/python"],
    { stdio: "inherit", cwd: repoRoot }
  );
} catch (error) {
  console.error("shared superfunctions usage guard failed");
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
  threshold,
  thresholdExceeded: Number(total.percentage ?? 0) > threshold,
  scannedFiles: total.sources ?? 0,
  duplicatedLines: total.duplicatedLines ?? 0,
  duplicatedPercentage: total.percentage ?? 0
};

if (payload.thresholdExceeded) {
  console.error(
    `langfn duplication threshold exceeded: ${payload.duplicatedPercentage}% > ${payload.threshold}%`
  );
  process.exit(1);
}

console.log(JSON.stringify(payload));
