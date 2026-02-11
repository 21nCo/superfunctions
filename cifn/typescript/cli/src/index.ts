import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import fs from 'node:fs';
import path from 'node:path';

// Read package.json for version
// In ESM we can't require, and import assertions are still experimental in some node versions.
// We'll just hardcode or read via fs.
const pkgPath = path.resolve(new URL('.', import.meta.url).pathname, '../package.json');
let version = '0.0.1';
try {
    if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        version = pkg.version;
    }
} catch (e) {
    // ignore
}

const program = new Command();

program
  .name('cifn')
  .description('CLI for CiFn - Self-hosted CI/CD pipeline runner')
  .version(version);

program.addCommand(runCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);

program.parse();
