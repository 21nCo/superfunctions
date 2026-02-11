#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runChecksCommand } from "./commands/run-checks.js";
import { exportCommand } from "./commands/export.js";
import { attestCommand } from "./commands/attest.js";

const program = new Command();

program
  .name("compfn")
  .description("CompFn CLI: compliance automation tool")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize config and DB schema")
  .option("-c, --config <path>", "Path to config file")
  .action(initCommand);

program
  .command("run-checks")
  .description("Run checks (all or one)")
  .option("--check-id <id>", "Run a specific check by ID")
  .option("-c, --config <path>", "Path to config file")
  .action(runChecksCommand);

program
  .command("export")
  .description("Export auditor pack")
  .option("--framework-id <id>", "Framework ID to export")
  .option("--output <path>", "Output file path (default: stdout)")
  .option("-c, --config <path>", "Path to config file")
  .action(exportCommand);

program
  .command("attest")
  .description("Create manual attestation evidence")
  .requiredOption("--control-id <id>", "Control ID")
  .requiredOption("--actor-id <id>", "Actor ID")
  .option("--outcome <pass|fail>", "Outcome (default: pass)")
  .option("-c, --config <path>", "Path to config file")
  .action(attestCommand);

program.parse(process.argv);
