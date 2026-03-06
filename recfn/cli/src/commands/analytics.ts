import { program } from 'commander';
import type { RecFn } from 'recfn-client';
import type { OutputFormat } from '../output.js';
import { formatJson, formatAnalytics } from '../output.js';

export function registerAnalyticsCommand(recfn: RecFn, format: () => OutputFormat) {
  program
    .command('analytics <recordingId>')
    .description('Get recording analytics')
    .action(async (recordingId: string) => {
      const result = await recfn.analytics.get(recordingId);
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(formatAnalytics(result.data));
      }
    });
}
