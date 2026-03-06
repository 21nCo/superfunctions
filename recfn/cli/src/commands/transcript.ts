import { program } from 'commander';
import type { RecFn } from 'recfn-client';
import type { OutputFormat } from '../output.js';
import { formatJson, formatTranscriptSearch } from '../output.js';

export function registerTranscriptCommands(recfn: RecFn, format: () => OutputFormat) {
  const transcript = program.command('transcript').description('Transcript retrieval');

  transcript
    .command('get <recordingId>')
    .description('Get transcript')
    .option('-f, --format <format>', 'Format: json, srt, vtt, text', 'json')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--redact', 'Redact PII')
    .action(async (recordingId: string, opts: { format?: string; output?: string; redact?: boolean }) => {
      const result = await recfn.transcripts.get(recordingId, {
        format: (opts.format ?? 'json') as 'json' | 'srt' | 'vtt' | 'text',
        redact: opts.redact,
      });
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      const content = typeof result.data === 'string'
        ? result.data
        : formatJson(result.data);
      if (opts.output) {
        const fs = await import('node:fs');
        fs.writeFileSync(opts.output, content);
        if (format() !== 'json') {
          console.log(`Written to ${opts.output}`);
        }
      } else {
        console.log(content);
      }
    });

  transcript
    .command('search <query>')
    .description('Search transcripts')
    .option('--bot-id <botId>', 'Filter by bot')
    .option('-l, --limit <n>', 'Limit', '20')
    .action(async (query: string, opts: { botId?: string; limit?: string }) => {
      const result = await recfn.transcripts.search({
        q: query,
        botId: opts.botId,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(formatTranscriptSearch(result.data));
      }
    });
}
