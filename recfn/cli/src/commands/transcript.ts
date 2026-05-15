import { program } from 'commander';
import type { RecFn } from '@recfn/client';
import type { OutputFormat } from '../output.js';
import { formatJson, formatTranscriptSearch } from '../output.js';

export const DEFAULT_TRANSCRIPT_REDACTION_MESSAGE =
  'Transcript content is redacted unless an explicit include-pii flag is present.';

type TranscriptGetOptions = {
  format?: string;
  output?: string;
  includePii?: boolean;
};

export async function runTranscriptGetCommand(
  recfn: RecFn,
  cliFormat: OutputFormat,
  recordingId: string,
  opts: TranscriptGetOptions,
): Promise<{ content?: string; wroteToFile?: boolean }> {
  const exportFormat = (opts.format ?? 'json') as 'json' | 'srt' | 'vtt' | 'text';
  const includePii = opts.includePii === true;
  const result = await recfn.transcripts.get(recordingId, {
    format: exportFormat,
    redact: !includePii,
  });

  if (!result.ok) {
    console.error(`Error: ${result.error.message}`);
    process.exit(1);
  }

  const transcriptContent =
    typeof result.data === 'string' ? result.data : formatJson(result.data);

  if (opts.output) {
    const fs = await import('node:fs');
    fs.writeFileSync(opts.output, transcriptContent);
    if (cliFormat !== 'json') {
      console.log(`Written to ${opts.output}`);
    }
    return { wroteToFile: true };
  }

  if (!includePii) {
    const safeContent =
      cliFormat === 'json'
        ? formatJson({
            redacted: true,
            message: DEFAULT_TRANSCRIPT_REDACTION_MESSAGE,
          })
        : DEFAULT_TRANSCRIPT_REDACTION_MESSAGE;
    console.log(safeContent);
    return { content: safeContent };
  }

  console.log(transcriptContent);
  return { content: transcriptContent };
}

export function registerTranscriptCommands(recfn: RecFn, format: () => OutputFormat) {
  const transcript = program.command('transcript').description('Transcript retrieval');

  transcript
    .command('get <recordingId>')
    .description('Get transcript')
    .option('-f, --format <format>', 'Format: json, srt, vtt, text', 'json')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--include-pii', 'Include raw transcript content and participant-identifying data')
    .action(async (recordingId: string, opts: TranscriptGetOptions) => {
      await runTranscriptGetCommand(recfn, format(), recordingId, opts);
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
