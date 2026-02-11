#!/usr/bin/env node

import { Command } from "commander";
import { registerSchemaCommands } from "./commands/schema.js";
import { registerDatasetCommands } from "./commands/dataset.js";
import { registerDocCommands } from "./commands/doc.js";

const program = new Command();

program
  .name("contentfn")
  .description("ContentFn CLI - schema, dataset, and document operations")
  .version("0.0.1")
  .option("--server <url>", "ContentFn server URL", process.env.CONTENTFN_SERVER ?? "http://localhost:3000");

registerSchemaCommands(program);
registerDatasetCommands(program);
registerDocCommands(program);

program.parseAsync(process.argv);
