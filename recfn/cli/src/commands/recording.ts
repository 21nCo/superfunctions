import { program } from 'commander';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { RecFn } from 'recfn-client';
import type { OutputFormat } from '../output.js';
import { formatJson, formatRecordingList } from '../output.js';

export function registerRecordingCommands(recfn: RecFn, format: () => OutputFormat) {
  const recording = program.command('recording').description('Recording access');

  recording
    .command('list <botId>')
    .description('List recordings for a bot')
    .action(async (botId: string) => {
      const result = await recfn.recordings.list(botId);
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(formatRecordingList(result.data));
      }
    });

  recording
    .command('download <recordingId>')
    .description('Download recording to file')
    .option('-o, --output <path>', 'Output file path')
    .action(async (recordingId: string, opts: { output?: string }) => {
      const result = await recfn.recordings.download(recordingId);
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      const res = result.data;
      const body = res.body;
      if (!body) {
        console.error('Error: No response body');
        process.exit(1);
      }
      const outPath = opts.output ?? `recording-${recordingId}.mp4`;
      const dest = createWriteStream(outPath);
      await pipeline(body as unknown as NodeJS.ReadableStream, dest);
      if (format() === 'json') {
        console.log(formatJson({ recordingId, outputPath: outPath }));
      } else {
        console.log(`Downloaded to ${outPath}`);
      }
    });
}
