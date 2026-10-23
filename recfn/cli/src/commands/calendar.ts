import { program } from 'commander';
import type { RecFn } from '@recfn/client';
import type { OutputFormat } from '../output.js';
import { formatJson, formatCalendarList } from '../output.js';

export function registerCalendarCommands(recfn: RecFn, format: () => OutputFormat) {
  const calendar = program.command('calendar').description('Calendar management');

  calendar
    .command('add <provider>')
    .description('Add calendar integration')
    .requiredOption('-t, --token <accessToken>', 'OAuth access token')
    .option('-r, --refresh-token <token>', 'Refresh token')
    .option('--auto-schedule', 'Enable auto-scheduling')
    .action(async (provider: string, opts: { token: string; refreshToken?: string; autoSchedule?: boolean }) => {
      const result = await recfn.calendars.create({
        provider: provider as 'google' | 'outlook',
        accessToken: opts.token,
        refreshToken: opts.refreshToken,
        autoSchedule: opts.autoSchedule,
      });
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(`Calendar added: ${result.data.id} (${result.data.provider})`);
      }
    });

  calendar
    .command('list')
    .description('List connected calendars')
    .action(async () => {
      const result = await recfn.calendars.list();
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(formatCalendarList(result.data));
      }
    });
}
