#!/usr/bin/env node

import { program } from 'commander';
import { RecFn } from 'recfn-client';
import { loadConfig } from './config.js';
import { registerBotCommands } from './commands/bot.js';
import { registerRecordingCommands } from './commands/recording.js';
import { registerTranscriptCommands } from './commands/transcript.js';
import { registerAnalyticsCommand } from './commands/analytics.js';
import { registerCalendarCommands } from './commands/calendar.js';
import type { OutputFormat } from './output.js';

program
  .name('recfn')
  .description('RecFn CLI — bot management, recordings, transcripts, analytics, calendars')
  .option('-f, --format <format>', 'Output format: text, json', 'text')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    const fmt = (opts.format as string)?.toLowerCase();
    if (fmt && fmt !== 'text' && fmt !== 'json') {
      console.error('Error: --format must be "text" or "json"');
      process.exit(1);
    }
  });

async function main() {
  const hasHelp = process.argv.includes('--help') || process.argv.includes('-h');
  const config = hasHelp ? null : loadConfig();
  const recfn = config
    ? new RecFn({ baseUrl: config.baseUrl, apiKey: config.apiKey })
    : ({} as RecFn);

  const getFormat = (): OutputFormat => {
    const opts = program.opts();
    const fmt = (opts.format as string)?.toLowerCase();
    return (fmt === 'json' ? 'json' : 'text') as OutputFormat;
  };

  registerBotCommands(recfn, getFormat);
  registerRecordingCommands(recfn, getFormat);
  registerTranscriptCommands(recfn, getFormat);
  registerAnalyticsCommand(recfn, getFormat);
  registerCalendarCommands(recfn, getFormat);

  await program.parseAsync(process.argv);

  if (!process.argv.slice(2).length) {
    program.outputHelp();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
