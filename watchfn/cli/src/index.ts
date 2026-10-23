import { Command } from "commander";
import chalk from "chalk";
import { queryCommand } from "./commands/query";
import { tailCommand } from "./commands/tail";
import { alertsCommand } from "./commands/alerts";

const program = new Command();

program
  .name("watchfn")
  .description("CLI for WatchFn Observability Platform")
  .version("0.1.0")
  .option("-u, --url <url>", "WatchFn API URL", "http://localhost:3000/watch")
  .option("-k, --key <key>", "API Key");

program.addCommand(queryCommand);
program.addCommand(tailCommand);
program.addCommand(alertsCommand);

program.parse();
