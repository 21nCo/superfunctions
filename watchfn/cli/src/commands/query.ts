import { Command } from "commander";
import chalk from "chalk";

export const queryCommand = new Command("query")
  .description("Query metrics")
  .argument("<query>", "Query string (e.g. 'api.request.duration > 1000')")
  .option("-t, --time <range>", "Time range", "last-1h")
  .option("-l, --limit <number>", "Limit results", "100")
  .action(async (query, options) => {
    console.log(chalk.blue(`Querying: ${query}`));
    console.log(chalk.gray(`Time: ${options.time}, Limit: ${options.limit}`));
    console.log(chalk.yellow("Stub: Results would appear here."));
  });
