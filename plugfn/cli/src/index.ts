#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { generateTypesCommand } from './commands/generate-types.js';
import { addProviderCommand } from './commands/add-provider.js';
import { testCommand } from './commands/test.js';

const program = new Command();

program
  .name('plugfn')
  .description('CLI tool for PlugFn SDK')
  .version('1.0.0');

// Init command
program
  .command('init')
  .description('Initialize a new PlugFn project')
  .option('-d, --directory <path>', 'Target directory', '.')
  .action(initCommand);

// Generate types command
program
  .command('generate-types')
  .description('Generate TypeScript types for providers')
  .option('-p, --provider <name>', 'Provider name')
  .option('-o, --output <path>', 'Output directory', './types')
  .option('-a, --all', 'Generate types for all providers')
  .action(generateTypesCommand);

// Add provider command
program
  .command('add-provider')
  .description('Create a new provider from template')
  .option('-n, --name <name>', 'Provider name (required)')
  .option('-a, --auth <type>', 'Auth type (oauth2, api-key, jwt, basic)', 'api-key')
  .option('-o, --output <path>', 'Output directory', './src/providers')
  .action(addProviderCommand);

// Test command
program
  .command('test')
  .description('Test connections and actions')
  .option('-p, --provider <name>', 'Provider to test')
  .option('-u, --user-id <id>', 'User ID to resolve connections for')
  .option('-a, --action <name>', 'Action to test')
  .option('-c, --connection-id <id>', 'Connection ID to use')
  .option('--params-file <path>', 'JSON file with action params')
  .option('--webhook-fixture <path>', 'JSON file with webhook diagnostic fixture')
  .option('--json', 'Emit machine-readable JSON output')
  .option('--live', 'Run optional provider live health check')
  .action(testCommand);

program.parse();
